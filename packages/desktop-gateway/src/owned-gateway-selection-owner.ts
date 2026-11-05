import type {ManagedRegistryConstruction} from '../../session-executor/src/managed-assembly.ts'
import {captureOwnedGatewaySelection} from './owned-gateway-selection.ts'
import {isOriginalOwnedPluginMount,type createOwnedPluginMount} from './owned-plugin-mount.ts'

type Captured=Awaited<ReturnType<typeof captureOwnedGatewaySelection>>
type Mount=ReturnType<typeof createOwnedPluginMount>
/** One selection witness per original runtime. A refresh may replace its witness
 * only after the same original mount accepted exactly those current inputs. */
export function createOwnedGatewaySelectionOwner(options:Parameters<typeof captureOwnedGatewaySelection>[0]) {
 type Row={current:Captured;mount?:Mount;update?:Mount['update'];original?:ManagedRegistryConstruction;refresh?:Promise<void>;retired:boolean;failed:boolean}
 const rows=new Map<string,Row>()
 function check(row:Row){if(row.retired)throw Error('Gateway selection retired');if(row.refresh)throw Error('Gateway plugin refresh pending');if(row.failed)throw Error('Gateway plugin refresh requires recovery');row.current.assertCurrent()}
 return Object.freeze({
  async prepare(id:string){
   const prior=rows.get(id);if(prior?.mount)throw Error('Gateway selection already exists');if(prior)prior.retired=true
   const current=await captureOwnedGatewaySelection(options);current.assertCurrent()
   if(current.kind==='complete')return {kind:'complete' as const,assertCurrent:current.assertCurrent}
   const row:Row={current,retired:false,failed:false};rows.set(id,row)
   return {kind:'managed' as const,assertCurrent(){check(row)}}
  },
  current(id:string){const row=rows.get(id);if(!row)throw Error('Original Gateway selection unavailable');check(row);return row.current},
  bind(original:ManagedRegistryConstruction,mount:Mount){
   const row=rows.get(original.domain.sessionId)
   if(!row||row.retired||row.mount||!isOriginalOwnedPluginMount(mount))throw Error('Original Gateway plugin selection required')
   row.current.assertCurrent();original.assertCurrent();const update=mount.update;row.mount=mount;row.update=update;row.original=original
   try{original.retain(async()=>{row.retired=true;await row.refresh?.catch(()=>{});if(rows.get(original.domain.sessionId)===row)rows.delete(original.domain.sessionId)})}catch(error){row.mount=undefined;row.update=undefined;row.original=undefined;throw error}
  },
  async release(id:string){const row=rows.get(id);if(!row)return;if(row.mount)throw Error('Original Gateway plugin mount remains retained');row.retired=true;await row.refresh?.catch(()=>{});if(rows.get(id)===row)rows.delete(id)},
  refresh(id:string):Promise<void>{
   const row=rows.get(id);if(!row||row.retired||!row.mount||!row.update||!row.original)return Promise.reject(Error('Original Gateway plugin mount unavailable'))
   if(row.refresh)return row.refresh
   const mount=row.mount,update=row.update,original=row.original
   const flight=Promise.resolve().then(async()=>{
    // A refresh can land while the session's previous write is still installing;
    // currentness reports that as 'issued write needs reconciliation'. Wait for
    // the write to settle instead of poisoning the selection permanently.
    for(let attempt=0;;attempt++){
     try{
      original.assertCurrent();const candidate=await captureOwnedGatewaySelection(options);original.assertCurrent();if(candidate.kind!=='managed')throw Error('Physical hooks require complete compatibility before acquisition');candidate.assertCurrent();if(row.retired||row.mount!==mount||mount.update!==update)throw Error('Original Gateway plugin mount changed');await Reflect.apply(update,mount,[candidate.inputs,candidate.directMcp]);original.assertCurrent();candidate.assertCurrent();if(row.retired||row.mount!==mount||mount.update!==update)throw Error('Original Gateway plugin mount changed');row.current=candidate;row.failed=false;return
     }catch(error){
      const message=String((error as Error)?.message??'')
      if(attempt<40&&/issued write needs reconciliation|prefix changed/i.test(message)){await new Promise(resolve=>setTimeout(resolve,25));continue}
      throw error
     }
    }
   }).catch(error=>{row.failed=true;throw error})
   row.refresh=flight;void flight.finally(()=>{if(row.refresh===flight)row.refresh=undefined}).catch(()=>{})
   return flight
  },
 })
}