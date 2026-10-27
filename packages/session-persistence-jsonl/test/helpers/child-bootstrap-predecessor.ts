import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp } from 'node:fs/promises'

const rootKeys = ['IH_CONFIG_DIR','IH_STRUCTURE_EVIDENCE_ROOT','IH_RESULT_INTEGRITY_EVIDENCE_ROOT','IH_LEGACY_FORK_EVIDENCE_ROOT','IH_MIXED_RETENTION_EVIDENCE_ROOT','IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT'] as const
/** Child processes never inherit the parent's six runtime roots. Keep all roots,
 * receipts, and original stores after failure for independent investigation. */
export async function fixtureRuntime(label:string) {
  const base=process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT
  if(!base)throw Error('Six isolated qualification roots required')
  const root=await mkdtemp(resolve(base,'child-'+label+'-')),env={...process.env},roots:Record<string,string>={}
  for(const [i,key] of rootKeys.entries()){const path=resolve(root,String(i));await mkdir(path);roots[key]=path;env[key]=path}
  await writeFile(resolve(root,'runtime-roots.json'),JSON.stringify({label,roots},null,2))
  return{root,env,roots}
}
export const fixtureLoader=pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
export async function runPredecessor(root:string,label:string,body:string,store:string,packages:readonly string[],provenance:unknown,format:number) {
  const runtime=await fixtureRuntime(label),runner=resolve(root,label+'.mjs')
  await writeFile(runner,predecessorPrefix(packages,format)+body)
  const args=['--import',fixtureLoader,runner,store],result=spawnSync(process.execPath,args,{cwd:root,env:runtime.env,windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024})
  const receipt={cwd:root,node:process.execPath,args,nodeSha256:hash(await readFile(process.execPath)),loader:fixtureLoader,runnerSha256:hash(await readFile(runner)),provenance,runtime,status:result.status,signal:result.signal,error:result.error?.message,stdout:result.stdout,stderr:result.stderr}
  await writeFile(resolve(runtime.root,'process.json'),JSON.stringify(receipt,null,2))
  if(result.error||result.status!==0||result.stderr)throw Error('Genuine predecessor runtime failed; preserved '+runtime.root+': '+(result.error?.message??result.stderr))
  const lines=result.stdout.trim().split('\n').map(line=>JSON.parse(line))
  return lines.at(-1)
}
function predecessorPrefix(packages:readonly string[],format:number){return `
import {registerHooks,syncBuiltinESMExports,createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {dirname,resolve,sep} from 'node:path';
const graph=dirname(fileURLToPath(import.meta.url)),allowed=${JSON.stringify(packages)},resolved=[],operations=[],counts={fetch:0,provider:0,capture:0,source:0,model:0,prepareBootstrapHeader:0,append:0,repair:0,updateMeta:0,upgradeSessionFormat:0,replaceEvents:0};
globalThis.fetch=async()=>{counts.fetch++;throw Error('network forbidden')};
registerHooks({resolve(specifier,context,next){const r=next(specifier,context);if(r.url.startsWith('file:')){const destination=fileURLToPath(r.url),parent=context.parentURL?.startsWith('file:')?fileURLToPath(context.parentURL):'';if(parent.startsWith(graph+sep)&&!destination.startsWith(graph+sep)&&specifier!=='koffi')throw Error('isolated graph escape: '+specifier);if(specifier.startsWith('@i-harness/')&&!allowed.some(p=>specifier===p||specifier.startsWith(p+'/'))){counts.provider++;throw Error('undeclared product import')};if(parent.startsWith(graph+sep)||specifier.startsWith('@i-harness/'))resolved.push({specifier,parent:context.parentURL,url:r.url})}return r}});
const fs=createRequire(import.meta.url)('node:fs').promises,store=resolve(process.argv[2]);
const pathname=x=>x instanceof URL?fileURLToPath(x):typeof x==='string'?resolve(x):String(x);
const record=(operation,paths)=>operations.push({operation,paths:paths.map(pathname)});
for(const name of ['writeFile','appendFile','rename','unlink','truncate','mkdir','copyFile','link']){const original=fs[name];fs[name]=async(...args)=>{record(name,args.slice(0,['rename','copyFile','link'].includes(name)?2:1));return original(...args)}}
const originalOpen=fs.open;fs.open=async(...args)=>{const writable=typeof args[1]==='string'&&/[wa+]/.test(args[1]);if(writable)record('open:'+args[1],args.slice(0,1));const handle=await originalOpen(...args);if(!writable)return handle;return new Proxy(handle,{get(target,key){const value=Reflect.get(target,key);if(['write','writeFile','appendFile','truncate','sync'].includes(key))return async(...values)=>{record('handle:'+key,args.slice(0,1));return value.apply(target,values)};return typeof value==='function'?value.bind(target):value}})};syncBuiltinESMExports();
const core=await import('@i-harness/core-session'),persistence=await import('@i-harness/session-persistence'),jsonl=await import('@i-harness/session-persistence-jsonl');
if(core.CURRENT_FORMAT_VERSION!==${format})throw Error('wrong genuine predecessor format');
const guards={assertCurrent(){},dependencies:{async confirm(){throw Error('unexpected artifact')},async reconcile(){throw Error('unexpected artifact')}}};
function errorRecord(error,depth=0){if(depth>=8)return {truncated:true,type:typeof error};if(error===null||typeof error!=='object')return {type:typeof error,value:typeof error==='bigint'?String(error):error};const output={name:String(error.name),message:String(error.message),stack:typeof error.stack==='string'?error.stack.slice(0,8192):undefined,code:error.code};if('cause' in error)output.cause=errorRecord(error.cause,depth+1);if(Array.isArray(error.errors))output.errors=error.errors.slice(0,32).map(e=>errorRecord(e,depth+1));return output}
async function cleanupCoordinator(coordinator){try{await coordinator.close();return {status:'fulfilled'}}catch(error){return {status:'rejected',error:errorRecord(error)}}}
function backendFor(path){const backend=jsonl.createJsonlBackend(path);for(const name of Object.keys(counts)){if(typeof backend[name]==='function'){const original=backend[name].bind(backend);backend[name]=async(...args)=>{counts[name]++;return original(...args)}}}return backend}
`}

export const predecessorFixture = new URL('../fixtures/child-bootstrap-predecessor13/', import.meta.url)
export const pinnedSource = 'd62c85ea24e7cb87c3a674a38e6a9476a6b891d1'
const packages = ['@i-harness/core-session','@i-harness/fs-lock','@i-harness/fs-watch','@i-harness/harness-home','@i-harness/session-persistence','@i-harness/session-persistence-jsonl','@i-harness/settings','@i-harness/telemetry','chokidar','readdirp']
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
interface File { path: string; bytes: number; sha256: string }
interface Manifest { version: number; product: string; format: number; packages: string[]; graphFileCount: number; fileCount: number; compressedBytes: number; decodedBytes: number; totalFileBytes: number; capsuleSha256: string; files: File[] }

/** Fixture-only extractor: bounded data capsule, never archive instructions or
 * links. Validate every path/hash before the first extracted file is written. */
export async function extractChildBootstrapPredecessor13(target: string, fixture = predecessorFixture) {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', fixture),'utf8')) as Manifest
  const capsule = await readFile(new URL('graph.json.gz', fixture))
  if (manifest.version !== 1 || manifest.product !== pinnedSource || manifest.format !== 13 || JSON.stringify(manifest.packages) !== JSON.stringify(packages)
    || manifest.capsuleSha256 !== '64d7100d894deb196a1579b7c91505503d0c69cb35191aa1892ef00f3c6a041d'
    || manifest.graphFileCount !== 224 || manifest.fileCount !== 225 || manifest.files.length !== 225
    || !Number.isSafeInteger(manifest.decodedBytes) || manifest.decodedBytes < 1 || manifest.decodedBytes > 8 * 1024 * 1024
    || capsule.length > 2 * 1024 * 1024 || capsule.length !== manifest.compressedBytes || hash(capsule) !== manifest.capsuleSha256) throw Error('Invalid predecessor capsule manifest/hash')
  const decoded = gunzipSync(capsule,{maxOutputLength:8 * 1024 * 1024})
  if (decoded.length !== manifest.decodedBytes) throw Error('Invalid predecessor decoded size')
  const content = JSON.parse(decoded.toString('utf8')) as {version:number;files:{path:string;base64:string}[]}
  if (content.version !== 1 || !Array.isArray(content.files) || content.files.length !== manifest.fileCount) throw Error('Invalid predecessor file count')
  const paths = new Set<string>(), declared = new Map<string,File>(), pending: {path:string;bytes:Buffer}[] = []
  for (const file of manifest.files) {
    if (declared.has(file.path)) throw Error('Duplicate predecessor manifest path')
    declared.set(file.path,file)
  }
  let total = 0, graphFiles = 0
  for (const file of content.files) {
    if (typeof file.path !== 'string' || !/^(?:LICENSE|node_modules\/(?:@i-harness\/[a-z-]+|chokidar|readdirp)\/[A-Za-z0-9_./-]+)$/.test(file.path)
      || file.path.split('/').some(part => part === '.' || part === '..' || !part) || paths.has(file.path.toLowerCase())
      || file.path !== 'LICENSE' && !packages.some(name => file.path.startsWith('node_modules/' + name + '/'))) throw Error('Unsafe or duplicate predecessor path')
    paths.add(file.path.toLowerCase())
    const path = resolve(target,file.path)
    if (!path.startsWith(resolve(target) + sep)) throw Error('Predecessor extraction escaped root')
    const expected = declared.get(file.path)
    if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || expected.bytes > 1024 * 1024
      || typeof file.base64 !== 'string' || file.base64.length > 2 * 1024 * 1024) throw Error('Invalid predecessor entry bounds')
    const bytes = Buffer.from(file.base64,'base64')
    if (bytes.toString('base64') !== file.base64 || bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) throw Error('Predecessor file hash mismatch')
    total += bytes.length
    if (total > 6 * 1024 * 1024) throw Error('Predecessor total size exceeded')
    if (file.path.startsWith('node_modules/')) graphFiles++
    pending.push({path,bytes})
  }
  if (total !== manifest.totalFileBytes || graphFiles !== 224) throw Error('Predecessor graph total mismatch')
  for (const name of packages) if (!declared.has('node_modules/' + name + '/package.json')) throw Error('Predecessor package missing')
  await mkdir(target,{recursive:false})
  for (const file of pending) { await mkdir(dirname(file.path),{recursive:true}); await writeFile(file.path,file.bytes,{flag:'wx'}) }
  return {product:pinnedSource,graphFiles,fileCount:pending.length,capsuleSha256:manifest.capsuleSha256,packages}
}
