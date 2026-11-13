import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { append, createSession, toJSONL, projectConversation } from '@i-harness/core-session'
import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import { createJsonlBackend } from '../src/index.ts'
import { createSessionCoordinator } from './helpers/composed.ts'
import { extractFormat10Predecessor } from './helpers/format10-predecessor.ts'
import { extractCurrentPredecessor, provisionPredecessorLock } from './helpers/current-context-predecessors.ts'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
async function fresh() { const root = await mkdtemp(join(tmpdir(), 'ih-c12-')); roots.push(root); return root }
function runnerPrefix(packages: string[]) { return `
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, sep } from 'node:path';
const root=dirname(fileURLToPath(import.meta.url)), allowed=${JSON.stringify(packages)}, imports=new Set();
globalThis.fetch=async()=>{throw Error('network forbidden')};
registerHooks({resolve(specifier,context,next){const result=next(specifier,context);if(specifier.startsWith('@i-harness/')||allowed.includes(specifier)){if(!allowed.some(name=>specifier===name||specifier.startsWith(name+'/'))||!fileURLToPath(result.url).startsWith(root+sep+'node_modules'+sep))throw Error('escaped predecessor graph '+specifier);imports.add(specifier)}return result}});
const core=await import('@i-harness/core-session'), persistence=await import('@i-harness/session-persistence'), jsonl=await import('@i-harness/session-persistence-jsonl');
` }

it.each([1, 10, 11] as const)('genuine format%s reader refuses future12 before repair or upgrade with unchanged bytes', async format => {
  const root = await fresh(), old = join(root, 'old'), receipt = format === 10 ? await extractFormat10Predecessor(old) : await extractCurrentPredecessor(old, format)
  const store = join(root, 'store'); await mkdir(store)
  const session = createSession(); append(session, { type: 'runtime/context', version: 1, sections: [{ name: 'instructions', text: 'current rule' }] })
  const lines = toJSONL(session).split('\n'); lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), sessionId: 'ready', createdAt: 'original' })
  const bytes = lines.join('\n'), cases = { ready: bytes, headerOnly: lines[0]! + '\n', interrupted: bytes.slice(0, bytes.indexOf('\n') + 24) }
  for (const [id, data] of Object.entries(cases)) await writeFile(join(store, id + '.jsonl'), data)
  const runner = join(old, 'reader.mjs')
  await writeFile(runner, runnerPrefix(receipt.packages) + `
if(core.CURRENT_FORMAT_VERSION!==${format})throw Error('wrong predecessor');
const backend=jsonl.createJsonlBackend(process.argv[2]), counts={repair:0,upgrade:0};
for(const [method,key] of [['repair','repair'],['upgradeSessionFormat','upgrade']])if(backend[method]){const original=backend[method].bind(backend);backend[method]=async(...args)=>{counts[key]++;return original(...args)}}
const c=persistence.createSessionCoordinator(backend,{lock:{enabled:false}}), refused=[];
try{for(const id of ['ready','headerOnly','interrupted']){try{await c.load(id);throw Error('accepted future format')}catch(error){if(!String(error).includes('newer than this build'))throw error;refused.push(id)}}}finally{await c.close()}
console.log(JSON.stringify({format:core.CURRENT_FORMAT_VERSION,refused,counts,imports:[...imports].sort()}));`)
  const result = JSON.parse(execFileSync(process.execPath, ['--import', loader, runner, store], { cwd: old, encoding: 'utf8', timeout: 20000 }).trim())
  expect(result).toMatchObject({ format, refused: Object.keys(cases), counts: { repair: 0, upgrade: 0 } })
  expect(result.imports).toContain('@i-harness/session-persistence-jsonl')
  for (const [id, data] of Object.entries(cases)) expect(await readFile(join(store, id + '.jsonl'), 'utf8')).toBe(data)
}, 30000)

it.each(['ready', 'header-only', 'stage-only', 'partial-header', 'upgrade-response-lost', 'upgrade-target-revoked', 'direct-upgrade', 'birth-conflict', 'unsupported-upgrade'] as const)('adopts genuine old11 %s with original initial work, immutable birth and current storage', async mode => {
  const root = await fresh(), old = join(root, 'old'), receipt = await extractCurrentPredecessor(old, 11), store = join(root, 'store'); await mkdir(store)
  const lock = await provisionPredecessorLock(old)
  const wasReady = !['header-only', 'stage-only', 'partial-header'].includes(mode)
  const runner = join(old, 'birth.mjs')
  await writeFile(runner, runnerPrefix(receipt.packages) + `
const request={invocation:{version:1,operationId:'original-operation',targetSessionId:'target',createdAt:'2026-10-23T00:00:00.000Z',requestDigest:'a'.repeat(64)},target:{kind:'new'},metadata:{title:'original'},lineage:{origin:'fork',parentSession:'parent'},seed:{digest:core.EMPTY_SEMANTIC_SEED_DIGEST,dependencyDigest:core.EMPTY_SEMANTIC_DEPENDENCY_DIGEST,sourceObservation:{kind:'none'},records:[]},initial:{inputId:'original-input',text:'original task',startedAt:100,expiresAt:100000,parentSessionId:'parent'}};
const source=core.createSession(), ref={version:1,id:'ctxv1_'+'c'.repeat(64),revision:'d'.repeat(64),codec:'json-utf8-v1',encodedBytes:10,contentDigest:'e'.repeat(64),completeness:'complete'};
core.append(source,{type:'step/start'});core.append(source,{type:'tool/call',callId:'ref',name:'read',args:{}});core.append(source,{type:'assistant/message',text:''});
core.append(source,{type:'tool/result',callId:'ref',name:'read',envelope:{version:1,execution:{outcome:'succeeded',dispatch:'dispatched'},preview:'original artifact preview',media:[],retention:{kind:'artifact',ref}}});core.append(source,{type:'step/end'});
const exported=core.exportConversationSeed(source,{kind:'session',sessionId:'parent'},{kind:'all'});if(exported.kind!=='seed')throw Error('original seed refused');request.seed=persistence.compileSemanticSeed(exported);
const pins=[], c=persistence.createSessionCoordinator(jsonl.createJsonlBackend(process.argv[2]),{lock:{enabled:true}}), guards={assertCurrent(){},dependencies:{async confirm(input){pins.push(input);return {kind:'confirmed',closureDigest:'f'.repeat(64)}},async reconcile(input){pins.push(input);return {kind:'confirmed',closureDigest:'f'.repeat(64)}}}},blocked={async confirm(){return {kind:'blocked',reason:'unavailable'}},async reconcile(){return {kind:'confirmed'}},assertTargetCurrent(){}};
const outcome=await c.bootstrapSemanticTarget(request,{...guards,...(!${JSON.stringify(wasReady)}?{targetPreparation:blocked}:{})});
await c.close();console.log(JSON.stringify({request,kind:outcome.kind,reason:outcome.reason,receipt:outcome.receipt,pins,imports:[...imports].sort(),lockResolved:fileURLToPath(import.meta.resolve('koffi'))}));`)
  const original = JSON.parse(execFileSync(process.execPath, ['--import', loader, runner, store], { cwd: old, encoding: 'utf8', timeout: 20000 }).trim())
  expect(original.lockResolved.replace(/index\.js$/, 'index.cjs')).toBe(lock.entry)
  expect(original.kind, JSON.stringify(original.reason)).toBe(wasReady ? 'ready' : 'blocked')
  const path = join(store, 'target.jsonl'), before = await readFile(path), stageName = (await readdir(store)).find(name => name.endsWith('.stage'))!, stage = await readFile(join(store, stageName))
  expect(JSON.parse(before.subarray(0, before.indexOf(10)).toString()).formatVersion).toBe(11)
  let targetAvailable = true
  let cutUpgrade = mode === 'upgrade-response-lost'
  let legacyUpgradeCalls = 0
  let nativeUpgradePublications = 0
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  if (mode === 'upgrade-response-lost' || mode === 'upgrade-target-revoked') {
    vi.mocked(rename).mockImplementation(async (...args) => {
      const result = await native.rename(...args)
      if (String(args[1]) === path && String(args[0]).endsWith('.tmp')) {
        nativeUpgradePublications++
        if (mode === 'upgrade-target-revoked') targetAvailable = false
        if (cutUpgrade) { cutUpgrade = false; throw new Error('lost original native upgrade publication acknowledgment') }
      }
      return result
    })
  }
  // The native transition owns its retained stageOwnedUpgrade. The optional
  // legacy header helper is not its publication or receipt boundary.
  const backend = createJsonlBackend(store, { wrap: b => {
    const actualUpgrade = b.upgradeSessionFormat!.bind(b)
    b.upgradeSessionFormat = async (...args) => {
      legacyUpgradeCalls++
      if (mode === 'unsupported-upgrade') throw new Error('legacy upgrade capability unavailable')
      return actualUpgrade(...args)
    }
  } })
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const pinRequests: unknown[] = []
  const pin = async (input: unknown) => { pinRequests.push(input); return { kind: 'confirmed' as const, closureDigest: 'f'.repeat(64) } }
  const guards = { assertCurrent() {}, dependencies: { confirm: pin, reconcile: pin }, targetPreparation: { async confirm() { return { kind: 'confirmed' as const } }, async reconcile() { return { kind: 'confirmed' as const } }, assertTargetCurrent() { if (!targetAvailable) throw Error('target changed') } } }
  if (mode === 'stage-only') await rm(path)
  if (mode === 'partial-header') await writeFile(path, before.subarray(0, 23))
  const cutBytes = mode === 'stage-only' ? undefined : await readFile(path)
  try {
    expect((await coordinator.inspectBootstrap(original.request.invocation)).kind).toBe(wasReady ? 'ready' : 'reserved')
    if (cutBytes) expect(await readFile(path)).toEqual(cutBytes)
    if (!wasReady) {
      expect(await coordinator.resumeSemanticTarget(original.request.invocation, guards)).toMatchObject({ kind: 'blocked', reason: 'payload-required' })
      if (cutBytes) expect(await readFile(path)).toEqual(cutBytes)
    }
    if (mode === 'birth-conflict') {
      const changed = JSON.parse(stage.toString())
      changed.originalTarget = { kind: 'existing-empty', expectedHeaderDigest: 'b'.repeat(64), expectedPrefix: { eventCount: 0, bodyBytes: 0, prefixDigest: changed.headerBase.journal.legacyPrefixDigest } }
      const { canonicalJsonData } = await import('@i-harness/core-session')
      await writeFile(join(store, stageName), canonicalJsonData(changed) + '\n')
      await expect(backend.upgradeSessionFormat!('target', 11, CURRENT_FORMAT_VERSION)).rejects.toThrow('manifest')
      expect(await readFile(path)).toEqual(before)
      await writeFile(join(store, stageName), stage)
    }
    if (mode === 'direct-upgrade') expect(await coordinator.ensureWritableFormat!('target')).toEqual({ formatVersion: CURRENT_FORMAT_VERSION })
    if (mode === 'upgrade-response-lost' || mode === 'upgrade-target-revoked') {
      expect((await coordinator.resumeSemanticTarget(original.request.invocation, guards, original.request)).kind).toBe('blocked')
      expect(await readFile(join(store, stageName))).toEqual(stage)
      expect(nativeUpgradePublications).toBe(1)
      targetAvailable = true
    }
    const resumed = await coordinator.resumeSemanticTarget(original.request.invocation, guards, original.request)
    expect(resumed.kind).toBe(wasReady ? 'already-ready' : 'ready')
    if (mode === 'unsupported-upgrade') expect(legacyUpgradeCalls).toBe(0)
    if (mode === 'upgrade-response-lost' || mode === 'upgrade-target-revoked') expect(nativeUpgradePublications).toBe(1)
    if (resumed.kind !== 'ready' && resumed.kind !== 'already-ready') throw Error(JSON.stringify(resumed))
    expect(resumed.document.view.events.filter(event => event.type === 'agent/input/admitted')).toHaveLength(1)
    expect(resumed.receipt.initial).toEqual({ inputId: 'original-input', seq: original.request.seed.records.length + 1, startedAt: 100, expiresAt: 100000 })
    if (original.receipt) expect(resumed.receipt.completion.key).toEqual(original.receipt.completion.key)
    expect(await readFile(join(store, stageName))).toEqual(stage)
    const upgraded = await readFile(path), header = JSON.parse(upgraded.subarray(0, upgraded.indexOf(10)).toString())
    expect(header.formatVersion).toBe(CURRENT_FORMAT_VERSION)
    expect(header.semanticSeed).toEqual(JSON.parse(before.subarray(0, before.indexOf(10)).toString()).semanticSeed)
    expect(resumed.receipt.dependencyClosureDigest).toBe('f'.repeat(64))
    expect(pinRequests.length).toBeGreaterThan(0)
    for (const request of pinRequests) expect(request).toMatchObject({ operationId: original.request.invocation.operationId, sourceSessionId: 'parent', artifacts: original.request.seed.records[0].artifacts })
    if (wasReady) for (const request of pinRequests) expect(request).toEqual(original.pins[0])
    if (wasReady) expect(upgraded.subarray(upgraded.indexOf(10) + 1)).toEqual(before.subarray(before.indexOf(10) + 1))
    const action = resumed.document.beginAction()
    expect(await action.captureRuntimeContext({ type: 'runtime/context', version: 1, sections: [{ name: 'instructions', text: 'target rule' }] }, () => true).admit()).toMatchObject({ kind: 'committed' })
    action.finish()
    expect(projectConversation(resumed.document.view).current?.sections[0]?.text).toBe('target rule')
  } finally { await coordinator.close() }
  const cold = createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: true } })
  try { expect((await cold.resumeSemanticTarget(original.request.invocation, guards)).kind).toBe('already-ready') }
  finally { await cold.close() }
}, 30000)
