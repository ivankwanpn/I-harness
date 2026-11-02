import {isAbsolute,posix,relative,resolve,sep,win32} from 'node:path'
import {types} from 'node:util'
import type {PersistenceBackend} from './types.ts'
import {createArtifactCurrentGuard,type OriginalArtifactPaths} from './artifact-path-association.ts'

// Constructor identity only: no path proof or successful check is cached here.
const originalQueryOwners=new WeakSet<object>()
export function isOriginalCanonicalPathOwner(owner:object):boolean{return originalQueryOwners.has(owner)}

/** The original JSONL computation, shared by real IO and native path capture. */
export function createOriginalJsonlPathResolution(root:string){
 const rootPath=resolve(root)
 const artifactPath=(id:string,suffix:string):string=>{
  const portableId=id.replace(/\\/g,'/'),candidate=resolve(rootPath,`${portableId}${suffix}`),fromRoot=relative(rootPath,candidate)
  if(posix.isAbsolute(portableId)||win32.parse(id).root!==''||fromRoot==='..'||fromRoot.startsWith(`..${sep}`)||isAbsolute(fromRoot))throw new Error(`artifact ${JSON.stringify(id)} is outside the JSONL store root`)
  return candidate
 }
 const session=(id:string)=>artifactPath(id,'.jsonl'),document=(key:string)=>artifactPath(key,'.doc.jsonl'),taskForParent=(id:string)=>document('task-'+id)
 const resolution=Object.freeze({rootPath,artifactPath,session,document,taskForParent,
  bindBackend(backend:PersistenceBackend,preparations:{prepareRoot():Promise<void>;prepareDocumentParents(key:string):Promise<void>}):OriginalArtifactPaths{
   if(this!==resolution||!backend||types.isProxy(backend)||!preparations||types.isProxy(preparations))throw TypeError('Original path constructor required')
   const rootPreparation=Object.getOwnPropertyDescriptor(preparations,'prepareRoot'),documentPreparation=Object.getOwnPropertyDescriptor(preparations,'prepareDocumentParents')
   if(!rootPreparation||!documentPreparation||!('value'in rootPreparation)||!('value'in documentPreparation)||typeof rootPreparation.value!=='function'||typeof documentPreparation.value!=='function')throw TypeError('Original path preparation required')
   const descriptors=Object.getOwnPropertyDescriptors(backend)
   // No caller check callback can claim this query computation is pure.
   const assertOriginal=createArtifactCurrentGuard(()=>{for(const key of Object.keys(descriptors)){const current=Object.getOwnPropertyDescriptor(backend,key),original=descriptors[key]!;if(!current||!('value'in current)||current.value!==original.value)throw Error('PROCESS_READ_UNAVAILABLE')}})
   const prepare=(key:'prepareRoot'|'prepareDocumentParents',field:PropertyDescriptor,args:unknown[])=>{
    const now=Object.getOwnPropertyDescriptor(preparations,key);if(!now||!('value'in now)||now.value!==field.value)throw TypeError('Changed original path preparation')
    return Reflect.apply(field.value,preparations,args) as Promise<void>
   }
   const owner:OriginalArtifactPaths=Object.freeze({root(){assertOriginal();return rootPath},session(id:string){assertOriginal();return session(id)},document(key:string){assertOriginal();return document(key)},taskForParent(id:string){assertOriginal();return taskForParent(id)},prepareRoot(){return prepare('prepareRoot',rootPreparation,[])},prepareDocumentParents(key:string){return prepare('prepareDocumentParents',documentPreparation,[key])},assertOriginal})
   originalQueryOwners.add(owner);return owner
  },
 });return resolution
}
