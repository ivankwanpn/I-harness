import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createSession, append, toJSONL, readDeliveries, encodeFactBatch, legacyPrefixDigest } from '@i-harness/core-session';
import { createSessionCoordinator } from '@i-harness/session-persistence';
import { createJsonlBackend } from '../src/index.ts';
import { extractFormat12Predecessor, pinnedSource } from './helpers/format12-predecessor.ts';
import { extractCurrentPredecessor, provisionPredecessorLock } from './helpers/current-context-predecessors.ts';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;
async function fresh() { const root = await mkdtemp(join(tmpdir(), 'ih-format13-')); roots.push(root); return root; }
function prefix(packages: string[]) {
  return `
import {registerHooks} from 'node:module';import {fileURLToPath} from 'node:url';import {dirname,sep} from 'node:path';
const root=dirname(fileURLToPath(import.meta.url)),allowed=${JSON.stringify(packages)},counts={fetch:0,repair:0,upgrade:0,provider:0};
globalThis.fetch=async()=>{counts.fetch++;throw Error('network forbidden')};
registerHooks({resolve(specifier,context,next){const resolved=next(specifier,context);if(context.parentURL?.startsWith('file:')&&fileURLToPath(context.parentURL).startsWith(root+sep)&&resolved.url.startsWith('file:')&&specifier!=='koffi'&&!fileURLToPath(resolved.url).startsWith(root+sep))throw Error('relative workspace escape');if(specifier.startsWith('@i-harness/')||allowed.includes(specifier)){if(!allowed.some(name=>specifier===name||specifier.startsWith(name+'/'))){counts.provider++;throw Error('provider forbidden')}if(!fileURLToPath(resolved.url).startsWith(root+sep+'node_modules'+sep))throw Error('workspace escape')}return resolved}});
const core=await import('@i-harness/core-session'),persistence=await import('@i-harness/session-persistence'),jsonl=await import('@i-harness/session-persistence-jsonl');
`;
}
async function run(root: string, body: string, store: string, packages: string[]) { const runner = join(root, 'runner.mjs'); await writeFile(runner, prefix(packages) + body); return JSON.parse(execFileSync(process.execPath, ['--import', loader, runner, store], { cwd: root, encoding: 'utf8', timeout: 20000 }).trim()); }
it('genuine pinned12 refuses ready, header-only and torn13 before any repair/upgrade/provider/fetch', async () => {
  const root = await fresh(), old = join(root, 'old'), receipt = await extractFormat12Predecessor(old), store = join(root, 'store');
  await mkdir(store);
  expect(receipt).toMatchObject({ product: pinnedSource, fileCount: 208, graphFiles: 207 });
  const session = createSession();
  append(session, { type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'stop', reason: 'user-stop' });
  const lines = toJSONL(session).split('\n');
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), sessionId: 'parent', createdAt: 'original' });
  const bytes = lines.join('\n'), end = bytes.indexOf('\n'), cases = { ready: bytes, headerOnly: bytes.slice(0, end + 1), torn: bytes.slice(0, end + 25) };
  for (const [id, body] of Object.entries(cases))
    await writeFile(join(store, id + '.jsonl'), body);
  const result = await run(old, `if(core.CURRENT_FORMAT_VERSION!==12)throw Error('wrong predecessor');const b=jsonl.createJsonlBackend(process.argv[2]);for(const [method,key]of [['repair','repair'],['upgradeSessionFormat','upgrade']]){const f=b[method].bind(b);b[method]=async(...args)=>{counts[key]++;return f(...args)}}const c=persistence.createSessionCoordinator(b,{lock:{enabled:false}}),refused=[];try{for(const id of ['ready','headerOnly','torn']){try{await c.load(id);throw Error('accepted13')}catch(e){if(!String(e).includes('newer than this build'))throw e;refused.push(id)}}}finally{await c.close()}console.log(JSON.stringify({format:core.CURRENT_FORMAT_VERSION,refused,counts}));`, store, receipt.packages);
  expect(result).toEqual({ format: 12, refused: Object.keys(cases), counts: { fetch: 0, repair: 0, upgrade: 0, provider: 0 } });
  for (const [id, body] of Object.entries(cases))
    expect(await readFile(join(store, id + '.jsonl'), 'utf8')).toBe(body);
}, 30000);
it('predecessor12 refuses header-downgraded required facts via its unknown required event gate', async () => {
  const root = await fresh(), old = join(root, 'old'), receipt = await extractFormat12Predecessor(old), store = join(root, 'store');
  await mkdir(store);
  const digest = legacyPrefixDigest(0, new Uint8Array()), header = { formatVersion: 12, sessionId: 'parent', createdAt: 'original', journal: { version: 1, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: digest, separatorBytes: 0 } };
  const bytes = Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), Buffer.from(encodeFactBatch('required', digest, [{ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'stop', reason: 'user-stop', seq: 0 }]).bytes)]);
  await writeFile(join(store, 'parent.jsonl'), bytes);
  const result = await run(old, `const b=jsonl.createJsonlBackend(process.argv[2]),original=b.repair.bind(b);b.repair=async(...args)=>{counts.repair++;return original(...args)};const c=persistence.createSessionCoordinator(b,{lock:{enabled:false}});let error;try{await c.load('parent')}catch(e){error=String(e)}finally{await c.close()}console.log(JSON.stringify({error,counts}));`, store, receipt.packages);
  expect(result.error).toMatch(/unknown event type.*agent\/delivery-generation/);
  expect(result.counts).toEqual({ fetch: 0, repair: 0, upgrade: 0, provider: 0 });
  expect(await readFile(join(store, 'parent.jsonl'))).toEqual(bytes);
  const current = createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: false } });
  try {
    await expect(current.load('parent')).rejects.toThrow();
  }
  finally {
    await current.close();
  }
}, 30000);
it.each([11, 12] as const)('preserves genuine original%s ready/header-only/interrupted bootstrap birth and initial work through13', async (format) => {
  for (const cut of ['ready', 'header-only', 'interrupted'] as const) {
    const root = await fresh(), old = join(root, 'old'), receipt = format === 12 ? await extractFormat12Predecessor(old) : await extractCurrentPredecessor(old, 11), store = join(root, 'store');
    await mkdir(store);
    await provisionPredecessorLock(old);
    const original = await run(old, `
if(core.CURRENT_FORMAT_VERSION!==${format})throw Error('wrong predecessor');
const request={invocation:{version:1,operationId:'original',targetSessionId:'target',createdAt:'2026-10-26T00:00:00.000Z',requestDigest:'a'.repeat(64)},target:{kind:'new'},metadata:{title:'original'},lineage:{origin:'subagent',parentSession:'parent',delegationDepth:1,subagentProtocolVersion:1},seed:{digest:core.EMPTY_SEMANTIC_SEED_DIGEST,dependencyDigest:core.EMPTY_SEMANTIC_DEPENDENCY_DIGEST,sourceObservation:{kind:'none'},records:[]},initial:{inputId:'original-input',text:'original task',parentSessionId:'parent',startedAt:1,expiresAt:100}};
const backend=jsonl.createJsonlBackend(process.argv[2]),c=persistence.createSessionCoordinator(backend,{lock:{enabled:true}}),guards={assertCurrent(){},dependencies:{async confirm(){throw Error('empty')},async reconcile(){throw Error('empty')}}};const outcome=await c.bootstrapSemanticTarget(request,guards);await c.close();console.log(JSON.stringify({request,kind:outcome.kind,receipt:outcome.receipt}));`, store, receipt.packages);
    expect(original.kind).toBe('ready');
    const path = join(store, 'target.jsonl'), before = await readFile(path), stageName = (await readdir(store)).find(name => name.endsWith('.stage'))!, stage = await readFile(join(store, stageName)), end = before.indexOf(10);
    expect(JSON.parse(before.subarray(0, end).toString()).formatVersion).toBe(format);
    if (cut !== 'ready')
      await writeFile(path, before.subarray(0, cut === 'header-only' ? end + 1 : end + 23));
    const backend = createJsonlBackend(store), c = createSessionCoordinator(backend, { lock: { enabled: true } }), guards = { assertCurrent() { }, dependencies: { async confirm() { throw Error('empty'); }, async reconcile() { throw Error('empty'); } } };
    try {
      const resumed = await c.resumeSemanticTarget!(original.request.invocation, guards, original.request);
      expect(resumed.kind).toBe(cut === 'ready' ? 'already-ready' : 'ready');
      if (resumed.kind !== 'ready' && resumed.kind !== 'already-ready')
        throw Error(JSON.stringify(resumed));
      expect(resumed.document.view.events.filter(e => e.type === 'agent/input/admitted')).toHaveLength(1);
      expect(resumed.receipt.initial).toEqual(original.receipt.initial);
      expect(await readFile(join(store, stageName))).toEqual(stage);
      const after = await readFile(path);
      expect(JSON.parse(after.subarray(0, after.indexOf(10)).toString()).formatVersion).toBe(13);
      expect(after.subarray(after.indexOf(10) + 1)).toEqual(before.subarray(end + 1));
      expect(readDeliveries(resumed.document.view).activeGeneration()).toBeUndefined();
    }
    finally {
      await c.close();
    }
  }
}, 30000);
it('upgrades genuine ordinary12 header with byte-identical original journal and no delivery authority', async () => {
  const root = await fresh(), old = join(root, 'old'), receipt = await extractFormat12Predecessor(old), store = join(root, 'store');
  await mkdir(store);
  await provisionPredecessorLock(old);
  await run(old, `const c=persistence.createSessionCoordinator(jsonl.createJsonlBackend(process.argv[2]),{lock:{enabled:true}});await c.create({sessionId:'parent'});const d=await c.openManagedDocument('parent'),a=d.beginAction();core.committedFactSeqs(await a.facts.delivery.record({type:'subagent/start',version:1,taskId:'original',role:'r',agentPath:'a',description:'original',parentSessionId:'parent'}));const s=a.registerSettlementSource(async()=>{});core.committedFactSeqs(await s.delivery.capture({type:'subagent/end',version:1,taskId:'original',outcome:'completed',resultRevision:'old-revision',envelope:{version:1,execution:{outcome:'succeeded',dispatch:'dispatched'},preview:'',media:[],retention:{kind:'inline',value:'old result',encodedBytes:12}}}).admit());await s.close();a.finish();await c.close();console.log(JSON.stringify({format:core.CURRENT_FORMAT_VERSION}));`, store, receipt.packages);
  const path = join(store, 'parent.jsonl'), before = await readFile(path), c = createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: true } });
  try {
    const d = await c.openManagedDocument('parent'), after = await readFile(path);
    expect(d.view.formatVersion).toBe(13);
    expect(after.subarray(after.indexOf(10) + 1)).toEqual(before.subarray(before.indexOf(10) + 1));
    expect(d.view.events.at(-1)).toMatchObject({ type: 'subagent/end', resultRevision: 'old-revision', envelope: { retention: { value: 'old result' } } });
    expect(readDeliveries(d.view).activeGeneration()).toBeUndefined();
    expect(readDeliveries(d.view).pending()).toEqual([]);
  }
  finally {
    await c.close();
  }
}, 30000);
