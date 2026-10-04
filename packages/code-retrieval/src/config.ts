import type { CodeRetrievalConfig } from './types.ts'
export const defaults: CodeRetrievalConfig = {
  enabled:false, mode:'lexical', autoRefresh:false, maxFiles:20000, maxFileBytes:1024*1024,
  maxInputBytes:128*1024*1024, maxChunks:50000, maxDiskBytes:512*1024*1024,
  maxSearchBytes:16*1024, deadlineMs:60000, ignorePatterns:[],
}
export function configuration(patch: Partial<CodeRetrievalConfig>, previous=defaults): CodeRetrievalConfig {
  const value={...previous,...patch,ignorePatterns:[...(patch.ignorePatterns??previous.ignorePatterns)]}
  for(const key of ['maxFiles','maxFileBytes','maxInputBytes','maxChunks','maxDiskBytes','maxSearchBytes','deadlineMs'] as const)
    if(!Number.isSafeInteger(value[key]) || value[key]<1 || value[key]>2**31-1) throw new Error(`Invalid ${key}`)
  if(value.maxSearchBytes<128) throw new Error('maxSearchBytes must allow a 128-byte result envelope')
  if(typeof value.enabled!=='boolean' || typeof value.autoRefresh!=='boolean' || !['lexical','hybrid'].includes(value.mode)) throw new Error('Invalid Code Context configuration')
  if(value.ignorePatterns.length>128 || value.ignorePatterns.some(p=>typeof p!=='string'||Buffer.byteLength(p)>1024)) throw new Error('Invalid ignore patterns')
  if(value.embedding) {
    const embedding={...value.embedding}; const endpoint=new URL(embedding.endpoint)
    if(!['https:','http:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash) throw new Error('Invalid embedding endpoint')
    if(!['openai-compatible','ollama'].includes(embedding.provider)) throw new Error('Invalid embedding provider')
    identity(embedding.model,'embedding model')
    if(embedding.credentialRef!==undefined) identity(embedding.credentialRef,'credential reference')
    if(embedding.dimensions!==undefined && (!Number.isSafeInteger(embedding.dimensions)||embedding.dimensions<1||embedding.dimensions>8192)) throw new Error('Invalid embedding dimensions')
    value.embedding=embedding
  }
  if(value.mode==='hybrid'&&!value.embedding) throw new Error('Hybrid mode requires an explicit embedding configuration')
  return value
}
export function identity(value: string, label: string): void {
  if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>4096||value.includes('\0')) throw new Error(`Invalid ${label}`)
}
export function sourceIds(value?: string[]): void {
  if(value!==undefined && (!Array.isArray(value)||value.length>100||value.some(v=>typeof v!=='string'||!v||Buffer.byteLength(v)>4096))) throw new Error('Invalid source IDs')
}
