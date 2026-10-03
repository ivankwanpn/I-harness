import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ExecService, ExecCommand, ExecStreamRunOptions } from '@i-harness/exec'
import { append, deriveMessages } from '@i-harness/core-session'
import { createSessionAssembly } from '../src/assembly.ts'
import { rmWorkspaceSync } from './helpers.ts'

const parent = process.platform === 'win32' ? 'D:/agent-complete/playground' : tmpdir()
const waitFor = async (condition: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms
  while (!condition()) { if (Date.now() >= deadline) throw new Error('search fixture never started'); await new Promise((r) => setTimeout(r, 10)) }
}

it.each(['mixed','only'] as const)('keeps full mounted %s search traces while JS emits only ten references', async (mode) => {
  const root = mkdtempSync(join(parent, 'search-code-'))
  for (let n = 0; n < 20; n++) {
    const folder = join(root, `group-${n % 10}`); mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `file-${n}.txt`),Array.from({length:12},(_,line)=>`needle ${n} row ${line+1}`).join('\n')+'\n')
  }
  const assembly = await createSessionAssembly({ workspace: root, sandbox: 'workspace-write', modelPolicy: 'test-mock', approveAll: true, codeMode: { mode } })
  try {
    expect(assembly.tools.deferredSearchIndex().find((t) => t.name === 'grep')).toBeDefined()
    append(assembly.session, { type: 'tool/call', callId: 'outer', name: 'code_exec', args: {} })
    const executed = await assembly.tools.execute({ name: 'code_exec', args: { code: `const all = await tools.grep({pattern:"needle",maxResults:1000,maxResultBytes:262144}); const groups = new Map(); for (const m of all.matches.filter(m=>m.line===2)) { const group=m.path.split("/")[0]; if(!groups.has(group)) groups.set(group,{path:m.path,line:m.line}); } text([...groups.values()].slice(0,10));`, yield_time_ms: 1000 } })
    let output = executed.output as { cell_id:string; status:string; text:string }
    while (output.status === 'running') output = (await assembly.tools.execute({ name: 'code_wait', args: { cell_id: output.cell_id, yield_time_ms: 1000 } })).output as typeof output
    expect(output.status).toBe('completed')
    const nested = assembly.session.events.find((e) => e.type === 'code/result' && e.name === 'grep')
    expect(nested?.type === 'code/result' && nested.output).toMatchObject({ status: 'completed', matches: expect.any(Array), limits: { maxResultBytes: 262144 } })
    const refs = JSON.parse(output.text)
    expect(refs).toHaveLength(10)
    expect(refs.every((ref: {line:number}) => ref.line === 2)).toBe(true)
    expect(nested?.type === 'code/result' && (nested.output as {matches:unknown[]}).matches).toHaveLength(240)
    append(assembly.session, { type: 'tool/result', callId: 'outer', name: 'code_exec', output })
    const visible = JSON.stringify(deriveMessages(assembly.session))
    expect(visible).toContain(refs[0].path)
    expect(visible).not.toContain('needle 19 row 12')
    expect(visible).not.toContain('engineRawBytes')
    expect(Buffer.byteLength(output.text)).toBeLessThan(1000)
  } finally { await assembly.dispose(); rmWorkspaceSync(root) }
}, 15000)

it.each(['human','code_wait'] as const)('%s stop drains the mounted search before closing and prevents follow-on calls', async (stopKind) => {
  const root = mkdtempSync(join(parent, 'search-stop-'))
  for (let n = 0; n < 300; n++) writeFileSync(join(root, `${n}.txt`), `needle ${n}\n`)
  const assembly = await createSessionAssembly({ workspace: root, sandbox: 'danger-full-access', modelPolicy: 'test-mock', approveAll: true, codeMode: { mode: 'only' } })
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
    expect(nested[0]?.type === 'code/result' && nested[0].output).toMatchObject({ status: 'cancelled', partial: true })
    expect(activeOwned).toBe(0)
    expect(assembly.liveResources!().codeCells).toEqual([])
    expect(assembly.session.events.some((e) => e.type === 'code/call' && e.name === 'glob')).toBe(false)
    expect(JSON.stringify(assembly.session.events.filter((e) => e.type === 'code/output'))).not.toContain('RESURRECTED')
  } finally { await assembly.dispose(); rmWorkspaceSync(root) }
}, 10000)
