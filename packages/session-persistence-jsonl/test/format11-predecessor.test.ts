import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { createManagedSessionState, legacyPrefixDigest, projectConversation, toJSONL } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { buildSession } from '../../session-persistence/src/format/validation.ts'
import { parseHeader } from '../src/format.ts'
import { createJsonlBackend } from '../src/index.ts'
import { literalReady } from '../../core-session/test/fixtures/format11-seed.ts'
import { extractFormat10Predecessor, pinnedProduct } from './helpers/format10-predecessor.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}) })
async function fresh() { const root = await mkdtemp(join(tmpdir(),'format11-predecessor-')); roots.push(root); return root }

it('uses the committed genuine format10 execution reader to refuse ready, header-only and interrupted11 before repair', async () => {
  const root = await fresh(), copyRoot = join(root,'old')
  const receipt = await extractFormat10Predecessor(copyRoot)
  expect(receipt).toMatchObject({product:pinnedProduct,graphFiles:177,fileCount:178})
  const store = join(root,'fixtures'); await mkdir(store)
  const readyLines = toJSONL(literalReady).split('\n')
  readyLines[0] = JSON.stringify({...JSON.parse(readyLines[0]!),sessionId:'literal11',createdAt:'2026-10-22T00:00:00.000Z'})
  const ready = readyLines.join('\n'), firstLF = ready.indexOf('\n')
  const cases = {ready,headerOnly:ready.slice(0,firstLF+1),interrupted:ready.slice(0,firstLF+24)}
  for (const [id,bytes] of Object.entries(cases)) await writeFile(join(store,id+'.jsonl'),bytes)
  const runner = join(copyRoot,'reader.mjs')
  await writeFile(runner, `
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep } from 'node:path';
const root=dirname(fileURLToPath(import.meta.url)), allowed=${JSON.stringify(receipt.packages)};
const counts={fetch:0,repair:0,upgrade:0,provider:0};
registerHooks({resolve(specifier,context,next){
  const result=next(specifier,context);
  if(specifier.startsWith('@i-harness/')){
    if(!allowed.includes(specifier)){counts.provider++;throw Error('unexpected old product/provider import');}
    if(!fileURLToPath(result.url).startsWith(root+sep+'node_modules'+sep))throw Error('escaped old graph');
  }
  return result;
}});
globalThis.fetch=async()=>{counts.fetch++;throw Error('network forbidden');};
for(const name of allowed){if(!fileURLToPath(import.meta.resolve(name)).startsWith(root+sep+'node_modules'+sep))throw Error('escaped package entry');}
const {createJsonlBackend}=await import('@i-harness/session-persistence-jsonl');
const {createSessionCoordinator}=await import('@i-harness/session-persistence');
const {CURRENT_FORMAT_VERSION}=await import('@i-harness/core-session');
if(CURRENT_FORMAT_VERSION!==10)throw Error('not the genuine format10 predecessor');
const backend=createJsonlBackend(process.argv[2]);
const repair=backend.repair.bind(backend);backend.repair=async(...args)=>{counts.repair++;return repair(...args);};
const upgrade=backend.upgradeSessionFormat.bind(backend);backend.upgradeSessionFormat=async(...args)=>{counts.upgrade++;return upgrade(...args);};
const coordinator=createSessionCoordinator(backend,{lock:{enabled:false}}),refused=[];
try{for(const id of ['ready','headerOnly','interrupted']){
  try{await coordinator.load(id);throw Error('accepted format11');}catch(error){if(!String(error).includes('newer than this build'))throw error;refused.push(id);}
}}finally{await coordinator.close();}
console.log(JSON.stringify({format:CURRENT_FORMAT_VERSION,refused,counts,product:'${pinnedProduct}',graphEntries:allowed.length}));
`)
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
  const result = JSON.parse(execFileSync(process.execPath,['--import',loader,runner,store],{encoding:'utf8',cwd:copyRoot,timeout:20000}).trim())
  expect(result).toEqual({format:10,refused:['ready','headerOnly','interrupted'],counts:{fetch:0,repair:0,upgrade:0,provider:0},product:pinnedProduct,graphEntries:10})
  for (const [id,bytes] of Object.entries(cases)) expect(await readFile(join(store,id+'.jsonl'),'utf8')).toBe(bytes)
},30000)

it('preserves reservation through parse→buildSession→managed view and reads10 without inventing ready evidence', async () => {
  const store = await fresh()
  const current = toJSONL(literalReady), lines = current.split('\n')
  lines[0] = JSON.stringify({...JSON.parse(lines[0]!),sessionId:'literal',createdAt:'2026-10-22T00:00:00.000Z'})
  await writeFile(join(store,'literal.jsonl'),lines.join('\n'))
  const backend = createJsonlBackend(store), read = await backend.read('literal')
  const parsed = parseHeader(lines[0]!), built = buildSession(parsed,read.events)
  expect(createManagedSessionState(built).view.header?.semanticSeed).toEqual(literalReady.header!.semanticSeed)
  expect(projectConversation(built).items[1]!.messages[1]!.content).toBe('seed exact')
  const journal = {version:1,legacyBodyBytes:0,legacyEventCount:0,legacyPrefixDigest:legacyPrefixDigest(0,new Uint8Array()),separatorBytes:0}
  await writeFile(join(store,'old.jsonl'),JSON.stringify({formatVersion:10,sessionId:'old',createdAt:'old',journal})+'\n')
  const coordinator = createSessionCoordinator(backend,{lock:{enabled:true}})
  try {
    const old = await coordinator.load('old')
    expect(old.session.header?.semanticSeed).toBeUndefined();expect(old.session.events).toEqual([])
    // This literal has no original operation stage: read-only inspection is
    // valid, but it cannot mint a birth receipt during the 11→12 write gate.
    const before = await readFile(join(store,'literal.jsonl'))
    expect((await coordinator.snapshot!('literal')).session.events).toEqual(literalReady.events)
    await expect(coordinator.openManagedDocument('literal')).rejects.toThrow()
    expect(await readFile(join(store,'literal.jsonl'))).toEqual(before)
    const repair = vi.spyOn(backend,'repair')
    for(const [id,text] of Object.entries({headerOnly:lines[0]!+'\n',interrupted:lines[0]!+'\n'+lines[1]!.slice(0,20)})) {
      await writeFile(join(store,id+'.jsonl'),text)
      await expect(coordinator.openManagedDocument(id)).rejects.toThrow(/bootstrap-incomplete/)
      expect(await readFile(join(store,id+'.jsonl'),'utf8')).toBe(text)
    }
    expect(repair).not.toHaveBeenCalled()
  } finally { await coordinator.close() }
})
