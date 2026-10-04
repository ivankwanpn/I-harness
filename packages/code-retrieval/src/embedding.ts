import { hash } from './store.ts'
import type { CodeEmbeddingConfig, CodeRetrievalOptions } from './types.ts'
export const modelIdentity=(config:CodeEmbeddingConfig)=>hash(JSON.stringify(['code-context-v1',config.provider,config.endpoint,config.model,config.dimensions??null,config.credentialRef??null]))
export const vectorKey=(model:string,text:string)=>hash(model+'\0'+text)
export function validVector(value:unknown, dimensions?:number):number[] {
  if(!Array.isArray(value)||!value.length||value.length>8192||value.some(n=>typeof n!=='number'||!Number.isFinite(n))||value.every(n=>n===0)||(dimensions!==undefined&&value.length!==dimensions)) throw new Error('Invalid embedding vector or dimensions')
  return value as number[]
}
export async function embed(texts:string[],config:CodeEmbeddingConfig,options:CodeRetrievalOptions,signal:AbortSignal,usage?:{request():void;reported(tokens:number):void}):Promise<number[][]> {
  signal.throwIfAborted()
  if(texts.length>16 || texts.reduce((n,t)=>n+Buffer.byteLength(t),0)>65536) throw new Error('Embedding batch quota exceeded')
  const endpoint=config.endpoint.replace(/\/+$/,'')+(config.provider==='ollama'?'/api/embed':'/embeddings')
  const credential=config.credentialRef?options.resolveCredential?.(config.credentialRef):undefined
  if(config.credentialRef&&!credential) throw new Error('Embedding credential unavailable')
  const headers:Record<string,string>={'content-type':'application/json'}
  if(credential)headers.authorization=`Bearer ${credential}`
  // No race-with-abort shortcut: a transport that ignores abort remains owned
  // until it settles, and control operations wait for that settlement.
  usage?.request()
  const response=await (options.fetch??globalThis.fetch)(endpoint,{method:'POST',headers,redirect:'error',signal,
    body:JSON.stringify({model:config.model,input:texts,...(config.provider==='ollama'?{truncate:false}:config.dimensions?{dimensions:config.dimensions}:{})})})
  try {
    signal.throwIfAborted()
    if(!response.ok) throw new Error(`Embedding provider HTTP ${response.status}`)
    if(Number(response.headers.get('content-length'))>2*1024*1024) throw new Error('Embedding response quota exceeded')
    if(!response.body)throw new Error('Empty embedding response')
    const reader=response.body.getReader(),parts:Uint8Array[]=[]
    let cancellation:Promise<void>|undefined
    const abort=()=>{cancellation=reader.cancel(signal.reason).catch(()=>{})}
    signal.addEventListener('abort',abort,{once:true})
    let bytes=0
    try {
      if(signal.aborted)abort()
      while(true) {
        const part=await reader.read();signal.throwIfAborted()
        if(part.done)break
        bytes+=part.value.byteLength
        if(bytes>2*1024*1024)throw new Error('Embedding response quota exceeded')
        parts.push(part.value)
      }
    } finally {signal.removeEventListener('abort',abort);await cancellation;await reader.cancel();reader.releaseLock()}
    const body=JSON.parse(Buffer.concat(parts).toString('utf8')) as {embeddings?:unknown[];data?:{index:number;embedding:unknown}[];usage?:{prompt_tokens?:number};prompt_eval_count?:number}
    const tokens=config.provider==='ollama'?body.prompt_eval_count:body.usage?.prompt_tokens
    if(typeof tokens==='number'&&Number.isSafeInteger(tokens)&&tokens>=0)usage?.reported(tokens)
    let vectors:unknown[]|undefined
    if(config.provider==='ollama')vectors=body.embeddings
    else if(Array.isArray(body.data)) {
      if(body.data.length!==texts.length||body.data.some(v=>!v||!Number.isInteger(v.index)||v.index<0||v.index>=texts.length)||new Set(body.data.map(v=>v.index)).size!==texts.length)throw new Error('Invalid embedding response indices')
      vectors=[...body.data].sort((a,b)=>a.index-b.index).map(v=>v.embedding)
    }
    if(!Array.isArray(vectors)||vectors.length!==texts.length)throw new Error('Invalid embedding response count')
    let dimensions=config.dimensions
    return vectors.map(vector=>{const result=validVector(vector,dimensions);dimensions??=result.length;return result})
  } finally {if(response.body&&!response.body.locked)await response.body.cancel()}
}
export function cosine(a:number[],b:number[]):number {
  if(a.length!==b.length)throw new Error('Embedding dimensions changed; rebuild the index')
  // Scaling avoids overflow even for finite, unusually large provider values.
  const aMax=Math.max(...a.map(Math.abs)),bMax=Math.max(...b.map(Math.abs))
  let dot=0,aa=0,bb=0
  for(let i=0;i<a.length;i++){const x=a[i]/aMax,y=b[i]/bMax;dot+=x*y;aa+=x*x;bb+=y*y}
  return dot/Math.sqrt(aa*bb)
}
