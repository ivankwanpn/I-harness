import {createHash} from 'node:crypto'
import {realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {createContextOutputService,type ContextOutputConfig,type ContextResultRef} from '@i-harness/context-output'
import {createCodeRetrievalService,type CodeRetrievalConfig} from '@i-harness/code-retrieval'
import type {SessionCoordinator} from '@i-harness/session-persistence'
import type {SessionProjectContext} from '@i-harness/session-executor'
import {createNativeCodeSourceReader,type NativeReferenceSource} from './context-source-reader.ts'

const pathKey=(path:string)=>process.platform==='win32'?path.toLowerCase():path
export async function createNativeContextRuntime(options:{
  workspace:string;storageRoot:string;coordinator:Pick<SessionCoordinator,'profile'>
  projectFor(sessionId:string):Promise<SessionProjectContext|undefined>
  contextConfig?:Partial<ContextOutputConfig>;codeConfig?:Partial<CodeRetrievalConfig>
  references?:NativeReferenceSource[]|((workspaceKey:string)=>NativeReferenceSource[]);resolveCredential?(ref:string):string|undefined
  visibleRefsFor?(sessionId:string):Promise<readonly ContextResultRef[]>
}) {
  const canonical=await realpath(options.workspace)
  const workspaceKey=createHash('sha256').update(pathKey(canonical)).digest('hex')
  const humanSessionId=`native-index-human:${workspaceKey}`
  let references=structuredClone(typeof options.references==='function'?options.references(workspaceKey):options.references??[]),closed=false
  let timer:ReturnType<typeof setInterval>|undefined,refreshing:Promise<unknown>|undefined
  async function projectScope(sessionId:string){
    if(sessionId===humanSessionId)return undefined
    const {meta}=await options.coordinator.profile(sessionId)
    if(meta.archived)throw new Error('Native context session is archived')
    return options.projectFor(sessionId)
  }
  async function sourceFor(sessionId:string){
    const scope=await projectScope(sessionId)
    const sourceId='session-scope:'+createHash('sha256').update(JSON.stringify([scope?.id??workspaceKey,(scope?.roots??[canonical]).map(pathKey).sort()])).digest('hex')
    return{sourceId,readonly:true}
  }
  const contextOutput=createContextOutputService({root:join(options.storageRoot,'context-output'),workspaceId:workspaceKey,config:options.contextConfig,
    authorize:async(access,ref)=>{
      try{
        if(ref.workspaceId!==workspaceKey||!ref.source||(await sourceFor(access.sessionId)).sourceId!==ref.source.sourceId)return false
        return access.sessionId===ref.sessionId||Boolean((await options.visibleRefsFor?.(access.sessionId))?.some(visible=>visible.id===ref.id))
      }catch{return false}
    }})
  let codeRetrieval:ReturnType<typeof createCodeRetrievalService>
  const reader=createNativeCodeSourceReader({workspace:canonical,references:()=>references,config:()=>codeRetrieval.status().config,
    authorize:async(actor,sourceId)=>{
      if(closed)return false
      try{
        const scope=await projectScope(actor)
        if(scope&&!scope.roots.some(root=>pathKey(root)===pathKey(canonical)))return false
        return sourceId==='workspace'||references.some(ref=>ref.id===sourceId)
      }catch{return false}
    }})
  codeRetrieval=createCodeRetrievalService({root:join(options.storageRoot,'code-retrieval'),workspaceId:workspaceKey,reader,config:options.codeConfig,resolveCredential:options.resolveCredential})
  async function autoRefresh(){
    const status=codeRetrieval.status()
    if(closed||refreshing||!status.enabled||!status.config.autoRefresh||status.activeJobs)return
    const work=(async()=>{const{jobId}=await codeRetrieval.startIndex({sessionId:humanSessionId});await codeRetrieval.wait(jobId)})()
    refreshing=work
    try{await work}catch{/* The service preserves job error/outcome for its UI. */}finally{if(refreshing===work)refreshing=undefined}
  }
  return{workspaceId:workspaceKey,workspaceKey,humanSessionId,contextOutput,codeRetrieval,sourceFor,
    async configureReferences(next:NativeReferenceSource[]){
      if(JSON.stringify(references)===JSON.stringify(next))return
      // Visibility changes before awaiting drainage, so old snippets cannot
      // borrow a superseded source binding during the transition.
      references=structuredClone(next)
      await codeRetrieval.cancel();await codeRetrieval.clear()
    },
    async inheritFork(parentId:string,targetId:string,refs:readonly ContextResultRef[]){
      const target=(await options.coordinator.profile(targetId)).meta
      if(target.parentSession!==parentId)throw new Error('Native reference target is not this fork')
      for(const ref of refs){
        if(ref.expiresAt<=Date.now())continue
        try{await contextOutput.grant({sessionId:parentId},[ref.id],targetId)}catch(error){
          const message=error instanceof Error?error.message:''
          if(/unavailable|expired|not found|unknown reference|not readable|not authorized/i.test(message))continue
          throw error
        }
      }
    },
    syncAutoRefresh(){
      const active=!closed&&codeRetrieval.status().enabled&&codeRetrieval.status().config.autoRefresh
      if(!active&&timer){clearInterval(timer);timer=undefined}
      if(active&&!timer){timer=setInterval(()=>{void autoRefresh()},30000);timer.unref?.();void autoRefresh()}
    },
    async close(){
      if(closed)return;closed=true;if(timer)clearInterval(timer)
      await codeRetrieval.cancel();await refreshing
      await Promise.all([contextOutput.close(),codeRetrieval.close()])
    },
  }
}
