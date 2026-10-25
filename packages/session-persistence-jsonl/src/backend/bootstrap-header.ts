import { open, readFile, readdir, rename, mkdir, type FileHandle } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalJsonData, type BootstrapInvocation } from '@i-harness/core-session'
import { readBootstrapFactJournal } from '@i-harness/core-session/internal/bootstrap'
import { isHeldFactOwner, parseBootstrapHeaderStage, parseBootstrapCaptureReservation, rawHeaderDigest, type HeldFactOwner, type BootstrapBackend, type BootstrapHeaderOperation, type HeaderOutcome } from '@i-harness/session-persistence'
import { parseHeader } from '../format.ts'
import { bootstrapNamespace, createBootstrapCaptureBackend } from './bootstrap-capture.ts'

export function bootstrapPaths(path: string, invocation: BootstrapInvocation) {
  const key=createHash('sha256').update(canonicalJsonData(invocation)).digest('hex')
  return {stage:`${path}.bootstrap-${key}.stage`,promote:`${path}.bootstrap-${key}.promote`,publish:`${path}.bootstrap-${key}.publish`}
}
export async function bootstrapArtifacts(path:string):Promise<string[]> {
  const prefix=basename(path)+'.bootstrap-'
  const names=await readdir(dirname(path)).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e})
  return names.filter(n=>n.startsWith(prefix)&&/^[a-f0-9]{64}\.(stage|publish|promote)$/.test(n.slice(prefix.length)))
}
async function optional(path:string):Promise<Buffer|undefined> { try{return await readFile(path)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e} }
async function bounded(path:string,limit:number):Promise<Buffer|undefined> {
  let handle:FileHandle|undefined
  try {handle=await open(path,'r'); if((await handle.stat()).size>limit)throw new Error('Bootstrap stage exceeds byte limit');return await handle.readFile()}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}finally{await handle?.close()}
}
async function headerPrefix(path:string):Promise<Buffer|undefined> {
  let handle:FileHandle|undefined
  try {
    handle=await open(path,'r')
    const bytes=Buffer.alloc(65536);let offset=0
    while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)break;offset+=result.bytesRead;if(bytes.subarray(0,offset).includes(10))break}
    return bytes.subarray(0,offset)
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}finally{await handle?.close()}
}
function scope(id:string,owner:HeldFactOwner) {
  if(!isHeldFactOwner(owner)||owner.owner.sessionId!==id)throw new TypeError('Invalid bootstrap owner scope')
  owner.assertHeld()
}
function matchingPrefix(actual:Uint8Array,expected:Uint8Array):boolean {
  return actual.length<=expected.length&&Buffer.from(actual).equals(Buffer.from(expected.subarray(0,actual.length)))
}
function originalEmptyTarget(actual:Buffer,id:string,operation:BootstrapHeaderOperation):boolean {
  if(operation.target.kind!=='existing-empty')return false
  try {
    const end=actual.indexOf(10),meta=end>=0?parseHeader(actual.subarray(0,end).toString('utf8')):undefined
    return end===actual.length-1&&!!meta&&!meta.semanticSeed&&[11,12,13].includes(meta.formatVersion)&&meta.sessionId===id&&meta.createdAt===operation.invocation.createdAt
      &&rawHeaderDigest(actual)===operation.target.expectedHeaderDigest&&meta.journal?.legacyEventCount===0&&meta.journal?.legacyBodyBytes===0
      &&meta.journal?.separatorBytes===0&&meta.journal?.legacyPrefixDigest===operation.target.expectedPrefix.prefixDigest
  }catch{return false}
}
export function createBootstrapHeaderBackend(filePath:(id:string)=>string, assertNotDeleted:(kind:string,id:string)=>Promise<void>, rootPath:string):Pick<BootstrapBackend,'prepareBootstrapHeader'|'reconcileBootstrapHeader'|'readBootstrapState'|'checkBootstrapCaptureRoot'|'readBootstrapCapture'|'prepareBootstrapCapture'|'settleBootstrapCaptureIO'> {
  const capture = createBootstrapCaptureBackend(filePath, assertNotDeleted, rootPath)
  function check(id:string,owner:HeldFactOwner,operation:BootstrapHeaderOperation) {
    scope(id,owner)
    const stage=parseBootstrapHeaderStage(operation.stageBytes)
    if(stage.invocation.targetSessionId!==id || canonicalJsonData(stage.invocation)!==canonicalJsonData(operation.invocation) || canonicalJsonData(stage.originalTarget)!==canonicalJsonData(operation.target)
      || !Buffer.from(stage.headerBytes).equals(Buffer.from(operation.headerBytes)))throw new TypeError('Invalid bootstrap header scope')
  }
  async function syncExact(path:string,bytes:Uint8Array,id:string,owner:HeldFactOwner):Promise<boolean> {
    const actual=await optional(path)
    if(!actual||actual.length<bytes.length||!actual.subarray(0,bytes.length).equals(Buffer.from(bytes)))return false
    if(actual.length>bytes.length){const meta=parseHeader(Buffer.from(bytes).toString('utf8'));readBootstrapFactJournal(actual.subarray(bytes.length),meta.journal!,meta.formatVersion,meta)}
    const h=await open(path,'r+')
    try{scope(id,owner);await h.sync();scope(id,owner)}finally{await h.close().catch(()=>{})}
    return true
  }
  return {
    checkBootstrapCaptureRoot: capture.checkBootstrapCaptureRoot,
    readBootstrapCapture: capture.readBootstrapCapture,
    prepareBootstrapCapture: capture.prepareBootstrapCapture,
    settleBootstrapCaptureIO: capture.settleBootstrapCaptureIO,
    async readBootstrapState(invocation) {
      await assertNotDeleted('session',invocation.targetSessionId)
      const path=filePath(invocation.targetSessionId), paths=bootstrapPaths(path,invocation)
      const siblings=await bootstrapNamespace(path);let foreign=siblings.some(n=>n!==basename(paths.stage)&&n!==basename(paths.publish)&&n!==basename(paths.promote))
      let stageBytes:Buffer|undefined, publicationBytes:Buffer|undefined, raw:Buffer|undefined
      let stagePresent=siblings.includes(basename(paths.stage)), promotionPresent=siblings.includes(basename(paths.promote)), promotionBytes:Buffer|undefined, captureReservation:import('@i-harness/session-persistence').BootstrapCaptureReservation|undefined
      let publicationPresent=siblings.includes(basename(paths.publish))
      const retained=()=>({stagePresent,promotionPresent,...(promotionBytes?{promotionBytes}:{}),...(captureReservation?{captureReservation}:{}),...(stageBytes?{stageBytes}:{}),...(publicationBytes?{publicationBytes}:{}),publicationPresent,foreign})
      try {
        stageBytes=await bounded(paths.stage,262144)
        stagePresent ||= stageBytes!==undefined
        if(stageBytes!==undefined) {
          try { captureReservation=parseBootstrapCaptureReservation(stageBytes);stageBytes=undefined }
          catch { try { parseBootstrapHeaderStage(stageBytes!) } catch { stageBytes=undefined;return {kind:'unavailable',...retained()} } }
        }
        promotionBytes=await bounded(paths.promote,262144);promotionPresent ||= promotionBytes!==undefined
        if(promotionPresent&&!captureReservation)foreign=true
        publicationBytes=await bounded(paths.publish,65536)
        publicationPresent ||= publicationBytes!==undefined
        const prefix=await headerPrefix(path)
        if(!prefix&&!stagePresent&&!promotionPresent&&!publicationPresent&&!foreign)return {kind:'absent'}
        if(!prefix)return {kind:'present',...retained()}
        if(prefix.indexOf(10)<0)return {kind:'unavailable',...retained()}
        raw=await optional(path)
        if(!raw)return {kind:'unavailable',...retained()}
        const end=raw.indexOf(10)
        if(end<0||end+1>65536)return {kind:'unavailable',...retained()}
        const rawHeader=raw.subarray(0,end+1).toString('utf8'),meta=parseHeader(rawHeader)
        const journal=readBootstrapFactJournal(raw.subarray(end+1),meta.journal!,meta.formatVersion,meta)
        return {kind:'present',...retained(),rawHeader,meta,...journal}
      } catch { return {kind:'unavailable',...retained()} }
    },
    async prepareBootstrapHeader(id,owner,operation) {
      check(id,owner,operation)
      if(parseBootstrapHeaderStage(operation.stageBytes).captureReservation)return capture.prepareCapturedHeader(id,owner,operation)
      await assertNotDeleted('session',id)
      const path=filePath(id),paths=bootstrapPaths(path,operation.invocation)
      let issued=false, cleanup=false
      const before=()=>{scope(id,owner);owner.beforeIssue();issued=true}
      const continueFile=async(path:string,bytes:Uint8Array)=>{
        const existing=await optional(path)
        if(existing && (existing.length>bytes.length||!existing.equals(Buffer.from(bytes.subarray(0,existing.length)))))throw new Error('BOOTSTRAP_CONFLICT')
        let h:FileHandle
        if(existing) h=await open(path,'r+')
        else {before();h=await open(path,'wx')}
        let synced=false
        try {
          let offset=existing?.length??0
          while(offset<bytes.length){before();const result=await h.write(bytes,offset,bytes.length-offset,offset);if(result.bytesWritten<=0)throw new Error('Header write made no progress');offset+=result.bytesWritten}
          scope(id,owner);await h.sync();synced=true
        } finally {await h.close().catch(error=>{if(synced)cleanup=true;else throw error})}
      }
      try {
        const siblings=await bootstrapNamespace(path)
        if(siblings.some(n=>n!==basename(paths.stage)&&n!==basename(paths.publish)))return {kind:'conflict'}
        const stage=await bounded(paths.stage,262144),publication=await bounded(paths.publish,65536),target=await optional(path)
        if(stage!==undefined&&stage.length===0)return {kind:'unknown'}
        if(stage&&!matchingPrefix(stage,operation.stageBytes))return {kind:'conflict'}
        if(publication!==undefined) {
          if(operation.target.kind==='new')return {kind:'conflict'}
          if(!stage)return {kind:'unknown'}
          if(!matchingPrefix(publication,operation.headerBytes))return {kind:'conflict'}
        }
        if(!stage&&target&&operation.target.kind==='new')return {kind:'conflict'}
        if(operation.target.kind==='new'&&target&&!matchingPrefix(target,operation.headerBytes))return {kind:'conflict'}
        if(operation.target.kind==='existing-empty'&&target&&!target.equals(Buffer.from(operation.headerBytes))) {
          if(!originalEmptyTarget(target,id,operation))return {kind:'conflict'}
        }
        if(operation.target.kind==='existing-empty'&&!target)return {kind:'conflict'}
        before();await mkdir(dirname(path),{recursive:true})
        await continueFile(paths.stage,operation.stageBytes)
        if(operation.target.kind==='new')await continueFile(path,operation.headerBytes)
        else if(!await syncExact(path,operation.headerBytes,id,owner)) {
          await continueFile(paths.publish,operation.headerBytes)
          const actual=await optional(path)
          if(!actual||rawHeaderDigest(actual)!==operation.target.expectedHeaderDigest) return {kind:'conflict'}
          before();await rename(paths.publish,path)
          if(!await syncExact(path,operation.headerBytes,id,owner))return {kind:'unknown'}
        }
        const directory=await open(dirname(path),'r').catch(()=>undefined)
        if(directory){try{await directory.sync()}catch{}finally{await directory.close().catch(()=>{})}}
        return {kind:'committed',headerDigest:rawHeaderDigest(operation.headerBytes),...(cleanup?{cleanupDiagnostic:'file-close-failed' as const}:{})}
      } catch(error) {
        const code=(error as {code?:string}).code
        if((error as Error).message==='BOOTSTRAP_CONFLICT'||code==='EEXIST')return {kind:'conflict'}
        if(!issued&&(code==='FACT_CANCELLED'||code==='FACT_PRECONDITION_STALE'))return {kind:'not-issued',reason:code==='FACT_CANCELLED'?'cancelled':'stale-source'}
        return {kind:issued?'unknown':'absent'}
      }
    },
    async reconcileBootstrapHeader(id,owner,operation):Promise<HeaderOutcome> {
      check(id,owner,operation)
      if(parseBootstrapHeaderStage(operation.stageBytes).captureReservation)return capture.reconcileCapturedHeader(id,owner,operation)
      await assertNotDeleted('session',id)
      const path=filePath(id),paths=bootstrapPaths(path,operation.invocation)
      try {
        const siblings=await bootstrapNamespace(path)
        if(siblings.some(n=>n!==basename(paths.stage)&&n!==basename(paths.publish)&&n!==basename(paths.promote)))return {kind:'conflict'}
        const stage=await bounded(paths.stage,262144)
        if(!stage)return {kind:'unknown'}
        if(!stage.equals(Buffer.from(operation.stageBytes))) {
          try { const reservation=parseBootstrapCaptureReservation(stage);if(canonicalJsonData(reservation)===canonicalJsonData(parseBootstrapHeaderStage(operation.stageBytes).captureReservation))return {kind:'unknown'} }catch{}
          return {kind:stage.length<operation.stageBytes.length&&stage.equals(Buffer.from(operation.stageBytes.subarray(0,stage.length)))?'unknown':'conflict'}
        }
        const publication=await bounded(paths.publish,65536)
        if(publication!==undefined) {
          if(operation.target.kind==='new'||!matchingPrefix(publication,operation.headerBytes))return {kind:'conflict'}
          if(publication.length<operation.headerBytes.length)return {kind:'unknown'}
        }
        const target=await optional(path)
        if(!target)return {kind:'unknown'}
        if(originalEmptyTarget(target,id,operation))return {kind:'unknown'}
        if(target.length<operation.headerBytes.length)return {kind:target.equals(Buffer.from(operation.headerBytes.subarray(0,target.length)))?'unknown':'conflict'}
        if(!target.subarray(0,operation.headerBytes.length).equals(Buffer.from(operation.headerBytes)))return {kind:'conflict'}
        if(!await syncExact(path,operation.headerBytes,id,owner))return {kind:'unknown'}
        return {kind:'committed',headerDigest:rawHeaderDigest(operation.headerBytes)}
      } catch{return {kind:'unknown'}}
    },
  }
}
