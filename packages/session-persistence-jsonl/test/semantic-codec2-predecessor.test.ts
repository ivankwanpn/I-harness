import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exportConversationSeed } from '@i-harness/core-session'
import { createSessionCoordinator, compileSemanticSeed } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/index.ts'
import { extractSemanticCodec1Predecessor13, pinnedSource } from './helpers/semantic-codec1-predecessor13.ts'
import { provisionPredecessorLock, extractCurrentPredecessor } from './helpers/current-context-predecessors.ts'
import { extractFormat12Predecessor } from './helpers/format12-predecessor.ts'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function fresh() { const root = await mkdtemp(join(tmpdir(), 'ih-codec2-old-')); roots.push(root); return root }
function prefix(packages: readonly string[], format: number) {
  return `
import {registerHooks,syncBuiltinESMExports,createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {dirname,resolve,sep} from 'node:path';
const root=dirname(fileURLToPath(import.meta.url)),allowed=${JSON.stringify(packages)},counts={fetch:0,provider:0,repair:0,append:0,updateMeta:0,upgradeSessionFormat:0,replaceEvents:0,fsWrites:0,otherFsWrites:0},resolved=[];
globalThis.fetch=async()=>{counts.fetch++;throw Error('network forbidden')};
registerHooks({resolve(specifier,context,next){const result=next(specifier,context);if(context.parentURL?.startsWith('file:')&&fileURLToPath(context.parentURL).startsWith(root+sep)&&result.url.startsWith('file:')&&specifier!=='koffi'&&!fileURLToPath(result.url).startsWith(root+sep))throw Error('relative graph escape');if(specifier.startsWith('@i-harness/')||allowed.includes(specifier)){if(!allowed.some(name=>specifier===name||specifier.startsWith(name+'/'))){counts.provider++;throw Error('provider forbidden')}if(!fileURLToPath(result.url).startsWith(root+sep+'node_modules'+sep))throw Error('workspace escape');resolved.push({specifier,url:result.url})}return result}});
const fs=createRequire(import.meta.url)('node:fs').promises;
const target=resolve(process.argv[2]),inTarget=value=>{if(value instanceof URL)value=fileURLToPath(value);if(typeof value!=='string')return false;const path=resolve(value);return path===target||path.startsWith(target+sep)},write=args=>{counts[args.some(inTarget)?'fsWrites':'otherFsWrites']++};
for(const name of ['writeFile','appendFile','rename','unlink','truncate','mkdir']){const original=fs[name];fs[name]=async(...args)=>{write(name==='rename'?args.slice(0,2):args.slice(0,1));return original(...args)}}
const originalOpen=fs.open;fs.open=async(...args)=>{if(typeof args[1]==='string'&&/[wa+]/.test(args[1]))write(args.slice(0,1));return originalOpen(...args)};syncBuiltinESMExports();
const core=await import('@i-harness/core-session'),persistence=await import('@i-harness/session-persistence'),jsonl=await import('@i-harness/session-persistence-jsonl');
if(core.CURRENT_FORMAT_VERSION!==${format})throw Error('wrong genuine predecessor');
`
}
async function run(root: string, label: string, body: string, store: string, packages: readonly string[], provenance: unknown, format = 13) {
  const runner = join(root, label + '.mjs'); await writeFile(runner, prefix(packages, format) + body)
  const args = ['--import', loader, runner, store], result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 30000 })
  const evidence = join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'codec2-predecessor'); await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, label + '.json'), JSON.stringify({ cwd: root, node: process.execPath, args, nodeSha256: hash(await readFile(process.execPath)), runnerSha256: hash(await readFile(runner)), provenance, status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2))
  if (result.error) throw result.error
  expect(result.stderr).toBe(''); expect(result.status).toBe(0)
  return JSON.parse(result.stdout.trim())
}
async function files(root: string) {
  const entries = (await readdir(root)).filter(name => name.endsWith('.jsonl') || name.endsWith('.stage')).sort()
  return Promise.all(entries.map(async name => ({ name, bytes: (await readFile(join(root, name))).toString('base64') })))
}
it('uses the unmodified codec1 graph to refuse ordinary/torn V2 at coordinator load/loadOwned and direct repair before writes', async () => {
  const root = await fresh(), old = join(root, 'old'), receipt = await extractSemanticCodec1Predecessor13(old), native = await provisionPredecessorLock(old), store = join(root, 'store'); await mkdir(store)
  expect(receipt).toMatchObject({ product: pinnedSource, fileCount: 211, graphFiles: 210 })
  const coordinator = createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: true } })
  try {
    await coordinator.create({ sessionId: 'source' }); await coordinator.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'one' }, { type: 'code/store', version: 1, cellId: 'c', sessionId: 'source', writes: [['x', 7]] }, { type: 'code/cell', cellId: 'c', sessionId: 'source', state: 'completed' }, { type: 'turn/end' }])
    const document = await coordinator.openManagedDocument('source'), view = document.view
    const exported = exportConversationSeed(view, { kind: 'session', sessionId: 'source' }, { kind: 'completed' }, { kind: 'public-completed-passive', owner: { kind: 'held-public-fork', sourceSessionId: 'source', view, factOwner: document, assertCurrent() { document.assertReady() } } })
    if (exported.kind !== 'seed') throw Error(JSON.stringify(exported))
    const request = { invocation: { version: 1 as const, operationId: 'new-codec', targetSessionId: 'target', createdAt: '2026-10-27T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'source' }, seed: compileSemanticSeed(exported) }
    expect((await coordinator.bootstrapSemanticTarget(request, { assertCurrent() {}, dependencies: { async confirm() { throw Error('empty') }, async reconcile() { throw Error('empty') } } })).kind).toBe('ready')
  } finally { await coordinator.close() }
  const original = await readFile(join(store, 'target.jsonl'))
  for (const shape of ['ordinary', 'torn']) {
    await writeFile(join(store, 'target.jsonl'), shape === 'ordinary' ? original : Buffer.concat([original, Buffer.from('{"torn":')]))
    const before = await files(store)
    for (const method of ['load', 'loadOwned', 'repair']) {
      const result = await run(old, 'refuse-' + shape + '-' + method, `
const backend=jsonl.createJsonlBackend(process.argv[2]);for(const name of ['repair','append','updateMeta','upgradeSessionFormat','replaceEvents']){if(typeof backend[name]==='function'){const original=backend[name].bind(backend);backend[name]=async(...args)=>{counts[name]++;return original(...args)}}}
const coordinator=persistence.createSessionCoordinator(backend,{lock:{enabled:true}});let refusal;
try{await ${method === 'repair' ? 'backend.repair' : 'coordinator.' + method}('target')}catch(error){refusal=String(error)}finally{await coordinator.close()}
if(!refusal)throw Error('old reader accepted codec2');console.log(JSON.stringify({format:core.CURRENT_FORMAT_VERSION,refusal,counts,resolved}));`, store, receipt.packages, { receipt, native })
      expect(result.refusal).toMatch(/semantic seed/i)
      expect(result.counts).toEqual({ fetch: 0, provider: 0, repair: method === 'repair' ? 1 : 0, append: 0, updateMeta: 0, upgradeSessionFormat: 0, replaceEvents: 0, fsWrites: 0, otherFsWrites: expect.any(Number) })
      expect(await files(store)).toEqual(before)
    }
  }
}, 60000)
it.each(([11, 12, 13] as const).flatMap(format => (['ready', 'header-only', 'torn'] as const).map(shape => ({ format, shape }))))('cold resumes genuine original codec1/format$format $shape birth preserving original stage/frames and supported upgrade', async ({ format, shape }) => {
  const root = await fresh(), old = join(root, 'old'), receipt = format === 13 ? await extractSemanticCodec1Predecessor13(old) : format === 12 ? await extractFormat12Predecessor(old) : await extractCurrentPredecessor(old, 11), native = await provisionPredecessorLock(old), store = join(root, 'store'); await mkdir(store)
  const original = await run(old, 'original-v1-' + format + '-' + shape, `
const source=core.createSession();core.append(source,{type:'turn/start'});core.append(source,{type:'user/message',text:'original V1 conversation'});core.append(source,{type:'turn/end'});
const exported=core.exportConversationSeed(source,{kind:'session',sessionId:'parent'},{kind:'completed'});if(exported.kind!=='seed'||exported.seed.version!==1)throw Error('original V1 required');
const request={invocation:{version:1,operationId:'original-v1',targetSessionId:'target',createdAt:'2026-10-27T00:00:00.000Z',requestDigest:'a'.repeat(64)},target:{kind:'new'},metadata:{title:'original'},lineage:{origin:'fork',parentSession:'parent'},seed:persistence.compileSemanticSeed(exported)};
const coordinator=persistence.createSessionCoordinator(jsonl.createJsonlBackend(process.argv[2]),{lock:{enabled:true}});let outcome;try{outcome=await coordinator.bootstrapSemanticTarget(request,{assertCurrent(){},dependencies:{async confirm(){throw Error('empty')},async reconcile(){throw Error('empty')}}})}finally{await coordinator.close()};console.log(JSON.stringify({request,kind:outcome.kind,receipt:outcome.receipt}));`, store, receipt.packages, { receipt, native }, format)
  expect(original.kind).toBe('ready')
  const path = join(store, 'target.jsonl'), before = await readFile(path), stageName = (await readdir(store)).find(name => name.endsWith('.stage'))!, stage = await readFile(join(store, stageName)), headerEnd = before.indexOf(10)
  expect(JSON.parse(before.subarray(0, headerEnd).toString()).semanticSeed).toMatchObject({ version: 1, codec: 'semantic-seed-v1' })
  expect(JSON.parse(before.subarray(0, headerEnd).toString()).formatVersion).toBe(format)
  expect(JSON.parse(stage.toString()).headerBytes).toBe(before.subarray(0, headerEnd + 1).toString())
  if (shape !== 'ready') await writeFile(path, before.subarray(0, shape === 'header-only' ? headerEnd + 1 : headerEnd + 24))
  const coordinator = createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: true } })
  try {
    const resumed = await coordinator.resumeSemanticTarget(original.request.invocation, { assertCurrent() {}, dependencies: { async confirm() { throw Error('empty') }, async reconcile() { throw Error('empty') } } }, original.request)
    expect(resumed.kind).toBe(shape === 'ready' ? 'already-ready' : 'ready')
    const after = await readFile(path), afterHeader = JSON.parse(after.subarray(0, after.indexOf(10)).toString()), beforeHeader = JSON.parse(before.subarray(0, headerEnd).toString())
    expect(afterHeader).toEqual({ ...beforeHeader, formatVersion: 13 })
    expect(after.subarray(after.indexOf(10) + 1)).toEqual(before.subarray(headerEnd + 1))
    if (format === 13) expect(after).toEqual(before)
    expect(await readFile(join(store, stageName))).toEqual(stage)
  } finally { await coordinator.close() }
}, 60000)
