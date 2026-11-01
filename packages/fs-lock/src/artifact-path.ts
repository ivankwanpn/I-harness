import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { createWin32ArtifactPathOwner } from './win32-artifact-path.ts'
export type ArtifactPathCapture = Readonly<{kind:'ready';key:string;assertCurrent():void}|{kind:'needs-parents';assertCurrent():void}|{kind:'needs-root';preparation:Readonly<{kind:'root-only';path:string}>;assertCurrent():void}>
/** Original platform namespace evidence only; no existence/read/launch authority. */
export function createArtifactPathOwner(root:string):{capture(path:string):ArtifactPathCapture;settleResources():void}{
  if(process.platform==='win32')return createWin32ArtifactPathOwner(root)
  if(process.platform!=='linux')throw Error('Artifact identity unsupported on this platform')
  root=resolve(root)
  type Evidence={path:string;dev:bigint;ino:bigint;mode:bigint;final:string}
  let bound:Evidence|undefined,busy=false
  const absent=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT'
  const same=(a:Evidence,b:Evidence)=>a.dev===b.dev&&a.ino===b.ino&&a.mode===b.mode&&a.final===b.final
  const directory=(path:string):Evidence=>{const value=lstatSync(path,{bigint:true});if(!value.isDirectory()||value.isSymbolicLink())throw Error('Original artifact ancestor unavailable');const final=realpathSync(path),after=lstatSync(path,{bigint:true});if(value.dev!==after.dev||value.ino!==after.ino||value.mode!==after.mode)throw Error('Artifact ancestor changed');return{path,dev:value.dev,ino:value.ino,mode:value.mode,final}}
  function snapshot(target:string){
    const rel=target.slice(parse(target).root.length).split(sep).filter(Boolean),parts=root.slice(parse(root).root.length).split(sep).filter(Boolean),evidence:Evidence[]=[]
    if(target===root||dirname(target).split(sep).length<root.split(sep).length)throw Error('Artifact outside original root')
    let original:Evidence
    try{original=directory(root)}catch(e){if(bound||!absent(e))throw e;for(let i=0;i<parts.length;i++){const p=join(parse(root).root,...parts.slice(0,i));try{evidence.push(directory(p))}catch(error){if(i>0&&absent(error))break;throw error}}if(!evidence.length)throw Error('No original root ancestor');return{kind:'needs-root' as const,evidence}}
    if(bound&&!same(bound,original))throw Error('Original artifact root changed');bound??=original;evidence.push(original)
    const candidate=join(parse(target).root,...rel.slice(0,parts.length));if(candidate!==root){const reached=directory(candidate);if(!same(reached,original))throw Error('Artifact reaches another root');evidence.push(reached)}
    let containing=original
    for(let i=parts.length+1;i<rel.length;i++){try{containing=directory(join(parse(target).root,...rel.slice(0,i)));evidence.push(containing)}catch(e){if(absent(e))return{kind:'needs-parents' as const,evidence};throw e}}
    const bytes=Buffer.from(rel.at(-1)!,'utf16le');return{kind:'ready' as const,key:`artifact-dir-v1:linux:${containing.dev}:${containing.ino}:${bytes.length}:${bytes.toString('hex')}`,evidence}
  }
  const equal=(a:ReturnType<typeof snapshot>,b:ReturnType<typeof snapshot>)=>a.kind===b.kind&&a.key===b.key&&a.evidence.length===b.evidence.length&&a.evidence.every((e,i)=>e.path===b.evidence[i]!.path&&same(e,b.evidence[i]!))
  const captureSnapshot=(target:string)=>{if(busy)throw Error('Artifact capture reentry');busy=true;try{const a=snapshot(target),b=snapshot(target);if(!equal(a,b))throw Error('Artifact changed during capture');return a}finally{busy=false}}
  const owner=Object.freeze({capture(target:string):ArtifactPathCapture{if(this!==owner)throw TypeError('Invalid artifact owner receiver');if(!isAbsolute(target)||target.includes('\0'))throw TypeError('Invalid original artifact path');target=resolve(target);const original=captureSnapshot(target);let retired=false;let capture:ArtifactPathCapture;function assertCurrent(this:ArtifactPathCapture){if(this!==capture||retired)throw Error('Artifact capture unavailable');try{if(!equal(original,captureSnapshot(target)))throw Error('Original artifact path changed')}catch(e){retired=true;throw e}}capture=original.kind==='ready'?Object.freeze({kind:'ready',key:original.key!,assertCurrent}):original.kind==='needs-root'?Object.freeze({kind:'needs-root',preparation:Object.freeze({kind:'root-only',path:root}),assertCurrent}):Object.freeze({kind:'needs-parents',assertCurrent});return capture},settleResources(){if(this!==owner||busy)throw TypeError('Invalid artifact owner receiver')}});return owner
}
