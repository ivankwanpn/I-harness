import { statSync } from 'node:fs'
import { open } from 'node:fs/promises'

export type RetainedOutputReader = (access: { maxBytes: number; signal: AbortSignal }) => Promise<{ text: string; complete: boolean; originalBytes?: number }>
// Only host producers can register object identities. JSON/path fields never
// confer permission to open a file. Entries vanish with the returned object.
const retained = new WeakMap<object, RetainedOutputReader>()
export function registerRetainedOutput(output: object, reader: RetainedOutputReader): void { retained.set(output, reader) }
export function retainedOutputReader(output: unknown): RetainedOutputReader | undefined {
  return output !== null && typeof output === 'object' ? retained.get(output) : undefined
}

export function execOutputReader(streams: readonly { text: string; spillPath?: string; lossy: boolean }[]): RetainedOutputReader {
  const snapshots = streams.map(stream => {
    try{return {...stream,stat:stream.spillPath?statSync(stream.spillPath):undefined}}
    catch{return {...stream,spillPath:undefined,stat:undefined,lossy:true}}
  })
  return async ({maxBytes,signal}) => {
    signal.throwIfAborted()
    let remaining=maxBytes, complete=true, originalBytes=0
    const parts:string[]=[]
    for(const [index,stream] of snapshots.entries()) {
      const label=index===0?'stdout:\n':'\nstderr:\n'
      const prefix=Buffer.from(label).subarray(0,remaining);parts.push(prefix.toString());remaining-=prefix.length;originalBytes+=Buffer.byteLength(label)
      let bytes:Buffer
      if(stream.spillPath && stream.stat) {
        originalBytes+=stream.stat.size
        const handle=await open(stream.spillPath,'r')
        try {
          const before=await handle.stat()
          if(!before.isFile()||before.dev!==stream.stat.dev||before.ino!==stream.stat.ino||before.size!==stream.stat.size||before.mtimeMs!==stream.stat.mtimeMs) throw new Error('Producer spill changed')
          bytes=Buffer.alloc(Math.min(remaining,before.size))
          let used=0
          while(used<bytes.length){signal.throwIfAborted();const read=await handle.read(bytes,used,bytes.length-used,used);if(!read.bytesRead)break;used+=read.bytesRead}
          bytes=bytes.subarray(0,used)
          const after=await handle.stat()
          if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('Producer spill changed')
          complete &&= used===before.size
        } finally { await handle.close() }
      } else {
        const full=Buffer.from(stream.text);originalBytes+=full.length;bytes=full.subarray(0,remaining)
        complete &&= !stream.lossy && bytes.length===full.length
      }
      signal.throwIfAborted()
      // Streaming decode drops an incomplete trailing UTF-8 sequence.
      const decoded=new TextDecoder().decode(bytes,{stream:true})
      const encoded=Buffer.from(decoded)
      const text=new TextDecoder().decode(encoded.subarray(0,remaining),{stream:true});parts.push(text);remaining-=Buffer.byteLength(text)
      complete &&= Buffer.byteLength(text)===bytes.length && prefix.length===Buffer.byteLength(label)
    }
    const text=parts.join('')
    return {text,complete,originalBytes:Math.max(originalBytes,Buffer.byteLength(text))}
  }
}
