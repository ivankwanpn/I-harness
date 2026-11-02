import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {dirname} from 'node:path'
import {loadHooksConfig} from '@i-harness/hooks'
import {createAuthoredHookApprovals} from './hook-authoring.ts'
import {installedPluginHookRoot} from './plugin-hook-root.ts'

/** Original plugin owner supplies the live input-list witness. The same hook
 * parser used by the registry decides whether physical compatibility is needed. */
export async function classifyOwnedGatewayHooks(options:{configDir:string;hookConfigs:readonly string[];assertInputsCurrent():void}) {
 options.assertInputsCurrent()
 const paths=[...options.hookConfigs],hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex')
 const revisions=new Map<string,string>()
 let complete=false
 for(const path of paths){
  options.assertInputsCurrent()
  if(installedPluginHookRoot(options.configDir,path)){complete=true;continue}
  try{
   const before=hash(path),loaded=await loadHooksConfig(path,dirname(path),createAuthoredHookApprovals(options.configDir,path)),after=hash(path)
   options.assertInputsCurrent()
   if(before!==after)throw Error('Hook configuration changed during selection')
   revisions.set(path,after)
   if(loaded.some(row=>row.spec.claude!==undefined))complete=true
  }catch{complete=true}
 }
 options.assertInputsCurrent()
 return Object.freeze({kind:complete?'complete' as const:'managed' as const,assertCurrent(){options.assertInputsCurrent();for(const [path,revision] of revisions)if(hash(path)!==revision)throw Error('Hook configuration changed after selection')}})
}
