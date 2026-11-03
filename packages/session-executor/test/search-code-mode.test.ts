import { appendStandalone as append } from "./helpers.ts"
import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecService, ExecCommand, ExecStreamRunOptions } from '@i-harness/exec'
import { createHash } from 'node:crypto'
import { createContextOutputService, type ContextOutputService } from '@i-harness/context-output'
import type { ResultEnvelope } from '@i-harness/core-session'
import { deriveMessages } from '@i-harness/core-session'
import { createSessionAssembly } from '../src/assembly.ts'
import { rmWorkspaceSync } from './helpers.ts'

async function retainedValue(service: ContextOutputService, envelope: ResultEnvelope | undefined): Promise<unknown> {
  expect(envelope).toBeDefined()
  if (!envelope) throw new Error('missing retained fact')
  if (envelope.retention.kind === 'inline') return envelope.retention.value
  expect(envelope.retention.kind).toBe('artifact')
  if (envelope.retention.kind !== 'artifact') throw new Error('retained full value unavailable')
  const ref = envelope.retention.ref, pieces: Buffer[] = []
  let offset = 0
  for (;;) {
    const page = await service.readResult({ sessionId: 'search-fixture' }, { ref, offset })
    pieces.push(page.data.kind === 'text' ? Buffer.from(page.data.text) : Buffer.from(page.data.base64, 'base64'))
    if (page.eof) break
    offset = page.nextOffset!
  }
  const bytes = Buffer.concat(pieces)
  expect(bytes.length).toBe(ref.encodedBytes)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.contentDigest)
  return JSON.parse(bytes.toString('utf8'))
}

const parent = join(process.cwd(), '.tmp')
mkdirSync(parent, { recursive: true })
const waitFor = async (condition: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms
  while (!condition()) { if (Date.now() >= deadline) throw new Error('search fixture never started'); await new Promise((r) => setTimeout(r, 10)) }
}

it.each(['mixed','only'] as const)('keeps full mounted %s search traces while JS emits only ten references', async (mode) => {
  const root = mkdtempSync(join(parent, 'sandbox-redesign-search-code-'))
  // Keep 240 hits and duplicate candidates for ten groups without making this
  // trace-projection test pay for twenty Windows reader/matcher process pairs.
  for (let n = 0; n < 10; n++) {
    const folder = join(root, `group-${n}`); mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `file-${n}.txt`),Array.from({length:24},(_,line)=>`needle ${n} row ${line+1}`).join('\n')+'\n')
  }
  const retained = createContextOutputService({root:join(root, "retained"),workspaceId:"fixture",config:{enabled:true}})
  const assembly = await createSessionAssembly({ contextOutput:retained, sessionId:"search-fixture", workspace: root, sandbox: 'workspace-write', modelPolicy: 'test-mock', approveAll: true, codeMode: { mode } })
  try {
    expect(assembly.tools.deferredSearchIndex().find((t) => t.name === 'grep')).toBeDefined()
    append(assembly.session, { type: 'tool/call', callId: 'outer', name: 'code_exec', args: {} })
    const executed = await assembly.tools.execute({ name: 'code_exec', args: { code: `const all = await tools.grep({pattern:"needle",maxResults:1000,maxResultBytes:262144}); const groups = new Map(); for (const m of all.matches.filter(m=>m.line===2||m.line===3)) { const group=m.path.split("/")[0]; if(!groups.has(group)) groups.set(group,{path:m.path,line:m.line}); } text([...groups.values()].slice(0,10));`, yield_time_ms: 1000 } })
    let output = executed.output as { cell_id:string; status:string; text:string }
    while (output.status === 'running') output = (await assembly.tools.execute({ name: 'code_wait', args: { cell_id: output.cell_id, yield_time_ms: 1000 } })).output as typeof output
    expect(output.status).toBe('completed')
    const nested = assembly.session.events.find((e) => e.type === 'code/result' && e.name === 'grep')
    const full = await retainedValue(retained, nested?.type === 'code/result' ? nested.envelope : undefined)
    expect(full).toMatchObject({ status: 'completed', matches: expect.any(Array), limits: { maxResultBytes: 262144 } })
    const refs = JSON.parse(output.text)
    expect(refs).toHaveLength(10)
    expect(refs.every((ref: {line:number}) => ref.line === 2)).toBe(true)
    expect(nested?.type === 'code/result' && (full as {matches:unknown[]}).matches).toHaveLength(240)
    append(assembly.session, { type: 'tool/result', callId: 'outer', name: 'code_exec', output })
    const visible = JSON.stringify(deriveMessages(assembly.session))
    expect(visible).toContain(refs[0].path)
    expect(visible).not.toContain('needle 9 row 24')
    expect(visible).not.toContain('engineRawBytes')
    expect(Buffer.byteLength(output.text)).toBeLessThan(1000)
  } finally { await assembly.dispose(); await retained.close(); rmWorkspaceSync(root) }
}, 15000)

it.each(['human','code_wait'] as const)('%s stop drains the mounted search before closing and prevents follow-on calls', async (stopKind) => {
  const root = mkdtempSync(join(parent, 'sandbox-redesign-search-stop-'))
  for (let n = 0; n < 300; n++) writeFileSync(join(root, `${n}.txt`), `needle ${n}\n`)
  const retained = createContextOutputService({root:join(root, "retained"),workspaceId:"fixture",config:{enabled:true}})
  const assembly = await createSessionAssembly({ contextOutput:retained, sessionId:"search-fixture", workspace: root, sandbox: 'danger-full-access', modelPolicy: 'test-mock', approveAll: true, codeMode: { mode: 'only' } })
  const raw=assembly.ctx.services.get<ExecService>('exec/service'), original=raw.run.bind(raw)
  let startedReaders=0, activeOwned=0
  raw.run=((command:ExecCommand,options?:ExecStreamRunOptions|{backgroundAfterMs?:number})=>{
    if(command.argv.some((arg)=>arg.endsWith('reader.mjs'))) startedReaders++
    activeOwned++
    const pending=options===undefined?original(command):'stream'in options?original(command,options):original(command,options)
    return pending.finally(()=>{activeOwned--})
  }) as ExecService['run']
  let id: string | undefined
  try {
    const started = await assembly.tools.execute({ name: 'code_exec', args: { code: 'const found=await tools.grep({pattern:"needle",maxResults:1000,maxResultBytes:262144}); text("RESURRECTED"); await tools.glob({pattern:"*.txt"});', yield_time_ms: 0 } })
    id = (started.output as {cell_id:string}).cell_id
    await waitFor(() => startedReaders>0 && activeOwned>0)
    if (stopKind === 'human') await assembly.stopCodeCell!(id)
    else await assembly.tools.execute({ name: 'code_wait', args: { cell_id: id, terminate: true } })
    const nested = assembly.session.events.filter((e) => e.type === 'code/result' && e.name === 'grep')
    expect(nested).toHaveLength(1)
    expect(await retainedValue(retained, nested[0]?.type === 'code/result' ? nested[0].envelope : undefined)).toMatchObject({ status: 'cancelled', partial: true })
    expect(activeOwned).toBe(0)
    expect(assembly.liveResources!().codeCells).toEqual([])
    expect(assembly.session.events.some((e) => e.type === 'code/call' && e.name === 'glob')).toBe(false)
    expect(JSON.stringify(assembly.session.events.filter((e) => e.type === 'code/output'))).not.toContain('RESURRECTED')
    expect(nested[0]?.type === 'code/result' && nested[0].envelope?.execution.outcome).toBe('canceled')
  } finally { await assembly.dispose(); await retained.close(); rmWorkspaceSync(root) }
}, 10000)
