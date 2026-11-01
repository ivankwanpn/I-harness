import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { failuresTogether, LeaseRetirement } from '../workspace-mutation.ts'
/** Finite read IO owned by one original transfer scope. No publication authority. */
export function createArtifactQualificationIO(){
 const handles=new Map<FileHandle,LeaseRetirement>(),closing=new Map<FileHandle,Promise<void>>()
 const retain=(handle:FileHandle)=>{
  let original=handles.get(handle)
  if(!original){original=new LeaseRetirement({get held(){return handle.fd>=0},release:()=>handle.close()});handles.set(handle,original)}
  return original
 }
 const retire=(handle:FileHandle)=>{
  const original=retain(handle)
  let flight=closing.get(handle)
  if(!flight){flight=Promise.resolve().then(()=>original.close()).then(()=>{handles.delete(handle)}).finally(()=>{closing.delete(handle)});closing.set(handle,flight)}
  return flight
 }
 return {async open(path:string,flags:string){const handle=await open(path,flags);retain(handle);return handle},retire,
  assertSettled(){if(handles.size)throw Error('Original artifact qualification cleanup owed')},
  async settle(){const results=await Promise.allSettled([...handles.keys()].map(retire));failuresTogether(results.flatMap(result=>result.status==='rejected'?[result.reason]:[]),'Original artifact qualification cleanup failed')},
 }
}
export type ArtifactQualificationIO=ReturnType<typeof createArtifactQualificationIO>
