import {registerCodeMode,type CodeModeConfig,type CodeModeMount} from '@i-harness/code-mode'
import type {ContextCapture,ContextOutputService} from '@i-harness/context-output'
import type {ManagedRegistryConstruction} from './managed-assembly.ts'
import type {OriginalManagedCodeSurface} from './host-managed-execution.ts'
import {createCodeTextRetention} from './lifecycle/code-text-retention.ts'
import {createCodeFinalOutputRetention} from './lifecycle/code-final-output-retention.ts'

/** The caller retains the output lease before invoking this mount. */
export interface OwnedCodeOutput {
 readonly service:ContextOutputService
 sourceFor(sessionId:string):Promise<ContextCapture['source']>
}
export async function mountOwnedCode(original:ManagedRegistryConstruction,output:OwnedCodeOutput,config:CodeModeConfig):Promise<{mount:CodeModeMount;surface?:OriginalManagedCodeSurface}>{
 original.assertCurrent()
 const mount=registerCodeMode(original.ctx,original.tools,{kind:'managed-execution',execution:original.execution,domain:original.domain,sessionId:original.domain.sessionId,config,
  retainText:createCodeTextRetention({service:output.service,sourceFor:output.sourceFor,sessionId:original.domain.sessionId}),
  finalOutput:createCodeFinalOutputRetention({service:output.service,sourceFor:output.sourceFor})})
 original.retain(()=>mount.dispose())
 await mount.ready?.()
 original.assertCurrent()
 const {liveCells,surfaceState,onSurfaceChanged,terminateCell}=mount
 if(!liveCells||!surfaceState||!onSurfaceChanged)return {mount}
 const assertOriginal=()=>{
  original.assertLifetimeCurrent()
  if(mount.liveCells!==liveCells||mount.surfaceState!==surfaceState||mount.onSurfaceChanged!==onSurfaceChanged||mount.terminateCell!==terminateCell)throw Error('Original Code surface changed')
 }
 const surface:OriginalManagedCodeSurface=Object.freeze({effectiveMode:config.mode??'off',
  surfaceState(){try{assertOriginal();return surfaceState.call(mount)}catch{return 'retired'}},
  onSurfaceChanged(listener:()=>void){assertOriginal();return onSurfaceChanged.call(mount,listener)},
  liveCells(){assertOriginal();const cells=liveCells.call(mount);assertOriginal();return cells},
  ...(terminateCell?{async terminateCell(cellId:string){
   assertOriginal();original.assertCurrent()
   if(!liveCells.call(mount).some(cell=>cell.id===cellId))throw Error('Cell has no live execution owner; cold history cannot be stopped')
   assertOriginal();await terminateCell.call(mount,cellId);assertOriginal()
  }}:{}),
 })
 return {mount,surface}
}
