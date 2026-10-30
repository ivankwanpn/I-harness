import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { failuresTogether } from '../workspace-mutation.ts'
/** Finite read IO owned by one original transfer scope. No publication authority. */
export function createArtifactQualificationIO(){
 const handles=new Set<FileHandle>(),closing=new Map<FileHandle,Promise<void>>()
 const retire=(handle:FileHandle)=>{
  handles.add(handle)
  let flight=closing.get(handle)
  if(!flight){flight=Promise.resolve().then(()=>handle.close()).then(()=>{handles.delete(handle)}).finally(()=>{closing.delete(handle)});closing.set(handle,flight)}
  return flight
 }
 return {async open(path:string,flags:string){const handle=await open(path,flags);handles.add(handle);return handle},retire,
  assertSettled(){if(handles.size)throw Error('Original artifact qualification cleanup owed')},
  async settle(){const results=await Promise.allSettled([...handles].map(retire));failuresTogether(results.flatMap(result=>result.status==='rejected'?[result.reason]:[]),'Original artifact qualification cleanup failed')},
 }
}
export type ArtifactQualificationIO=ReturnType<typeof createArtifactQualificationIO>
