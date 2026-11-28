import {expect,it} from 'vitest'
import {createManagedEventBridge} from '../../sdk/src/managed-event-bridge.ts'

it('serializes original events, hydrates earlier admission, and fences retirement',async()=>{
 const sent:any[]=[],entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let listener:(event:any)=>void=()=>{}
 const image={mediaType:'image/png',dataBase64:'QUJD'}
 const owner={subscribe(fn:(event:any)=>void){listener=fn;return()=>{}},observe(){return {assertCurrent(){},readHistoryPage:async()=>undefined,inbox:{async admitted(id:string){entered.resolve();await release.promise;return {type:'agent/input/admitted',inputId:id,seq:1,images:[image]}}}}}} as any
 const bridge=createManagedEventBridge(message=>sent.push(message));bridge.attach('s',owner)
 listener({type:'agent/input/admitted',inputId:'i',seq:1,images:[image]})
 listener({type:'user/message',text:'look',imageInputId:'i',seq:2})
 listener({type:'assistant/message',text:'later',seq:3})
 await entered.promise;expect(sent).toHaveLength(1);expect(sent[0].params.event.images).toBeUndefined()
 release.resolve();await new Promise(resolve=>setTimeout(resolve,0));expect(sent.map(x=>x.params.event.type)).toEqual(['agent/input/admitted','user/message','assistant/message']);expect(sent[1].params.event.images).toEqual([image])
 bridge.retire('s');listener({type:'assistant/message',text:'retired'});await bridge.close();expect(sent).toHaveLength(3)
})
it('reports missing image admission rather than emitting an incomplete event',async()=>{
 const sent:any[]=[];let listener:(event:any)=>void=()=>{}
 const owner={subscribe(fn:(event:any)=>void){listener=fn;return()=>{}},observe(){return {assertCurrent(){},readHistoryPage:async()=>undefined,inbox:{async admitted(){return undefined}}}}} as any
 const bridge=createManagedEventBridge(message=>sent.push(message));bridge.attach('s',owner);listener({type:'user/message',text:'x',imageInputId:'missing',seq:2});await new Promise(resolve=>setTimeout(resolve,0));expect(sent[0].method).toBe('session/status');expect(sent[0].params.status).toBe('error');await bridge.close()
})

it('does not retire a replacement owner when an old retirement arrives',async()=>{
 const sent:any[]=[];let first:(event:any)=>void=()=>{},second:(event:any)=>void=()=>{}
 const make=(set:(fn:(event:any)=>void)=>void)=>({subscribe(fn:(event:any)=>void){set(fn);return()=>{}},observe(){throw Error('no image expected')}} as any)
 const old=make(fn=>first=fn),next=make(fn=>second=fn),bridge=createManagedEventBridge(message=>sent.push(message))
 bridge.attach('s',old);bridge.attach('s',next);bridge.retire('s',old);first({type:'assistant/message',text:'old'});second({type:'assistant/message',text:'new'})
 await new Promise(resolve=>setTimeout(resolve,0));expect(sent.map(value=>value.params.event.text)).toEqual(['new']);await bridge.close()
})

it('selects the immutable image admission by message ordinal even when the input ID was reused', async () => {
 const image = {mediaType:'image/png',dataBase64:'QUJD'}
 const user = {type:'user/message',text:'early',imageInputId:'same',seq:2}
 const sent:any[] = []
 let listener:(event:any)=>void = ()=>{}
 const bridge=createManagedEventBridge(message=>sent.push(message))
 const owner={subscribe(fn:typeof listener){listener=fn;return ()=>{}},observe(){return{
   async readHistoryPage(options:unknown){
     expect(options).toEqual({afterSeq:2,limit:1})
     return {events:[user],images:new Map([[2,[image]]])}
   },
   inbox:{async admitted(){throw Error('Consulted newest admission instead of historical read')}},
 }}} as any
 bridge.attach('s',owner)
 listener(user)
 await bridge.flush('s')
 expect(sent).toMatchObject([{method:'session/event',params:{event:{...user,images:[image]}}}])
 await bridge.close()
})

it('bounds repeated live history expiry and continues delivering later notifications', async () => {
 let count=0, listener:(event:any)=>void=()=>{}
 const identity={}, sent:any[]=[]
 const owner={subscribe(fn:typeof listener){listener=fn;return ()=>{}},observe(){return {
   identity,eventCount:++count,readHistoryPage:async()=>{throw Object.assign(new TypeError('Original execution observation expired'),{code:'EXECUTION_OBSERVATION_EXPIRED'})},
 }}} as any
 const bridge=createManagedEventBridge(message=>sent.push(message))
 bridge.attach('s',owner)
 listener({type:'user/message',text:'look',imageInputId:'id',seq:7})
 listener({type:'assistant/message',text:'later',seq:8})
 await bridge.flush('s')
 expect(count).toBe(2)
 expect(sent).toMatchObject([
   {method:'session/status',params:{status:'error',error:expect.stringContaining('session/history at sequence 7')}},
   {method:'session/event',params:{event:{seq:8,text:'later'}}},
 ])
 await bridge.close()
})
