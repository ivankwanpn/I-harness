import {it,expect,vi} from 'vitest'
import {createTaskRegistry} from '../src/task/registry.ts'
import {createNotificationDrain,DeliverySourcesError} from '../src/task-notification.ts'
import {RecipientDeliveryRecoveryError} from '../../session-executor/src/lifecycle/recipient-delivery.ts'
import {isRetryableDeliveryError} from '../../session-executor/src/service/delivery-drain.ts'
function fixture(source:unknown,readiness:unknown,failSource=true){
 const tasks=createTaskRegistry(),admitTaskDelivery=vi.fn(async()=>{throw Error('Unready notification must not deliver')});tasks.notifications=()=>{throw readiness}
 const drain=createNotificationDrain({tasks,reconcileSources:async()=>{if(failSource)throw source},admit:{admitTaskDelivery,wake(){throw Error('No new wake')},async admit(){}},evidence:()=>undefined})
 return{drain,admitTaskDelivery}
}
it.each([undefined,false])('preserves every nominal source occurrence and falsey readiness refusal (%s)',async readiness=>{
 const nominal=new RecipientDeliveryRecoveryError({kind:'retryable',phase:'original-physical'},false),source=new DeliverySourcesError([false,nominal,undefined,nominal]),f=fixture(source,readiness)
 const error=await f.drain.drain().then(()=>{throw Error('Expected refusal')},error=>error)
 expect(error).toBeInstanceOf(DeliverySourcesError);expect(error.errors).toEqual([false,nominal,undefined,nominal,readiness]);expect(error.errors[1]).toBe(error.errors[3]);expect(isRetryableDeliveryError(error)).toBe(true);expect(f.admitTaskDelivery).not.toHaveBeenCalled()
})
it('does not unwrap a generic aggregate into source retry authority',async()=>{
 const nominal=new RecipientDeliveryRecoveryError({kind:'retryable',phase:'original-physical'}),generic=new AggregateError([nominal]),readiness=Error('ordinary parent unavailable'),f=fixture(generic,readiness)
 const error=await f.drain.drain().then(()=>{throw Error('Expected refusal')},error=>error)
 expect(error.errors).toEqual([generic,readiness]);expect(error.errors[0]).toBe(generic);expect(isRetryableDeliveryError(error)).toBe(false);expect(f.admitTaskDelivery).not.toHaveBeenCalled()
})
it.each([undefined,false])('keeps the exact no-source ordinary acquisition failure (%s)',async readiness=>{
 const f=fixture(undefined,readiness,false);let refused=false;await f.drain.drain().then(()=>{},error=>{refused=true;expect(error).toBe(readiness)});expect(refused).toBe(true);expect(f.admitTaskDelivery).not.toHaveBeenCalled()
})

it('fences only ordinary discovery when the actual mount retires during original reconciliation',async()=>{
 const tasks=createTaskRegistry(),notifications=vi.spyOn(tasks,'notifications'),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let current=true,reconciles=0
 const drain=createNotificationDrain({tasks,current:()=>current,reconcileSources:async()=>{reconciles++;entered.resolve();await release.promise},admit:{wake(){throw Error('No new wake')},async admit(){},async admitTaskDelivery(){throw Error('No new delivery')}},evidence:()=>undefined})
 const pending=drain.drain();await entered.promise;current=false;release.resolve();expect(await pending).toBe(0);expect(reconciles).toBe(1);expect(notifications).not.toHaveBeenCalled()
})
it.each([undefined,false])('retirement never discards the original falsey source failure (%s)',async cause=>{
 const tasks=createTaskRegistry(),notifications=vi.spyOn(tasks,'notifications'),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let current=true
 const drain=createNotificationDrain({tasks,current:()=>current,reconcileSources:async()=>{entered.resolve();await release.promise;throw cause},admit:{wake(){throw Error('No new wake')},async admit(){},async admitTaskDelivery(){throw Error('No new delivery')}},evidence:()=>undefined})
 const pending=drain.drain();await entered.promise;current=false;release.resolve();let refused=false;await pending.then(()=>{},error=>{refused=true;expect(error).toBe(cause)});expect(refused).toBe(true);expect(notifications).not.toHaveBeenCalled()
})
