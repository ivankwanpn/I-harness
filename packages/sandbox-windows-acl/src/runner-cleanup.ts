import type { AclSandbox, AclSandboxSpawnOptions } from './index.ts'

/** Preserve the tagged primary work result/error, reporting cleanup separately.
 * A retained sandbox debt never authorizes removal of its standalone temp. */
export async function withRunnerCleanup<T>(work:()=>Promise<T>,owners:()=>{sandbox?:{disposeAsync():Promise<void>};temp?:string},report:(error:unknown)=>void,remove:(path:string)=>void):Promise<T>{
 try{return await work()}finally{
  const {sandbox,temp}=owners();let acknowledged=!sandbox
  if(sandbox){try{await sandbox.disposeAsync();acknowledged=true}catch(error){report(error)}}
  if(acknowledged&&temp!==undefined){try{remove(temp)}catch(error){report(error)}}
 }
}
export async function runInheritedCommand(sandbox:Pick<AclSandbox,'init'|'spawn'>,options:AclSandboxSpawnOptions,afterInit:()=>void){
 await sandbox.init();afterInit()
 const child=await sandbox.spawn({...options,stdio:'inherit'})
 return child.wait()
}
