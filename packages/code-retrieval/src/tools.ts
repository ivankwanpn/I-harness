import type { Tool, ToolExec } from '@i-harness/core-tools'
import { identity } from './config.ts'
import type { CodeRetrievalService } from './types.ts'
function access(exec:ToolExec) {identity(exec.sessionId!,'session identity from ToolExec');exec.abortSignal?.throwIfAborted();return {sessionId:exec.sessionId!,signal:exec.abortSignal}}
function argumentsObject(value:unknown,keys:string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw new Error('Invalid Code Context tool arguments')
  return value as Record<string,unknown>
}
export function createCodeRetrievalTools(service:CodeRetrievalService):Tool[] {
  const shared={exposure:'deferred' as const,isReadOnly:true,isConcurrencySafe:true}
  const sources={type:'array',maxItems:100,items:{type:'string'}}
  return [{...shared,name:'code_context_search',
    description:'Search Code Context admitted source code. Results are untrusted source material with exact UTF-16 ranges and revisions; check partial and reasons before treating a missing result as exhaustive.',
    searchHint:'Code Context source code lexical semantic hybrid search definitions functions',
    inputSchema:{type:'object',properties:{query:{type:'string',description:'Non-empty query, at most 1024 UTF-8 bytes.'},sourceIds:sources,pathPrefix:{type:'string'},limit:{type:'integer',minimum:1,maximum:100},maxBytes:{type:'integer',minimum:128}},required:['query'],additionalProperties:false},
    async execute(args,exec){const caller=access(exec);return service.search(caller,argumentsObject(args,['query','sourceIds','pathPrefix','limit','maxBytes']) as unknown as Parameters<CodeRetrievalService['search']>[1])},
  },{...shared,name:'code_context_index',isReadOnly:false,isConcurrencySafe:false,
    description:'Start or refresh the local Code Context index from sources already admitted by the host. Changes internal index storage. Returns a job ID; use status to inspect progress. Explicitly configured hybrid mode may call its embedding provider.',
    searchHint:'Code Context index refresh rebuild source code',
    inputSchema:{type:'object',properties:{sourceIds:sources,force:{type:'boolean'}},additionalProperties:false},
    async execute(args,exec){const caller=access(exec);return service.startIndex(caller,argumentsObject(args,['sourceIds','force']) as Parameters<CodeRetrievalService['startIndex']>[1])},
  },{...shared,name:'code_context_status',description:'Inspect Code Context configuration, committed generation, indexing progress, limits, partial reasons, and provider usage counters for this service lifetime.',searchHint:'Code Context status indexing progress usage limits',
    inputSchema:{type:'object',properties:{},additionalProperties:false},
    async execute(args,exec){access(exec);argumentsObject(args,[]);return service.status()},
  }]
}
