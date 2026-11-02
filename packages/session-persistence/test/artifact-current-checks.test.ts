import { expect, it } from 'vitest'
import { assertArtifactCurrent, withArtifactCurrentChecks, createArtifactCurrentGuard, assertHeldWithArtifactGuard } from '../src/coordinator/artifact-path-association.ts'
function proof(check:()=>void=()=>{}) { let calls=0; const capture={kind:'ready' as const,key:'same-key',assertCurrent(){expect(this).toBe(capture);calls++;check()}};return{capture,calls:()=>calls} }
it('checks every distinct original object while deduplicating repeated synchronous requests',()=>{
 const a=proof(),b=proof();withArtifactCurrentChecks(()=>{for(let i=0;i<100;i++){assertArtifactCurrent(a.capture);assertArtifactCurrent(b.capture)}});expect(a.calls()).toBe(1);expect(b.calls()).toBe(1)
})
it('does not merge different old evidence merely because canonical keys are equal',()=>{
 const a=proof(()=>{throw Error('old incarnation')}),b=proof();expect(()=>withArtifactCurrentChecks(()=>{assertArtifactCurrent(b.capture);assertArtifactCurrent(a.capture)})).toThrow('old incarnation');expect(a.calls()).toBe(1);expect(b.calls()).toBe(1)
})
it('validates an inside-guard namespace change before any following effect',()=>{
 let current=true,effects=0;const a=proof(()=>{if(!current)throw Error('changed')});expect(()=>{withArtifactCurrentChecks(()=>{assertArtifactCurrent(a.capture);current=false;assertArtifactCurrent(a.capture)});effects++}).toThrow('changed');expect(effects).toBe(0)
})
it('joins nested pure checks and clears the worklist after throws and failed validation',()=>{
 const a=proof();withArtifactCurrentChecks(()=>{assertArtifactCurrent(a.capture);withArtifactCurrentChecks(()=>assertArtifactCurrent(a.capture))});expect(a.calls()).toBe(1)
 expect(()=>withArtifactCurrentChecks(()=>{assertArtifactCurrent(a.capture);throw undefined})).toThrow();assertArtifactCurrent(a.capture);expect(a.calls()).toBe(2)
 const bad=proof(()=>{throw false});try{withArtifactCurrentChecks(()=>assertArtifactCurrent(bad.capture))}catch(e){expect(e).toBe(false)};assertArtifactCurrent(a.capture);expect(a.calls()).toBe(3)
})
it('revalidates fresh groups after an await and rejects asynchronous guard shapes',async()=>{
 let current=true,called=false;const a=proof(()=>{if(!current)throw Error('changed')});withArtifactCurrentChecks(()=>assertArtifactCurrent(a.capture));await Promise.resolve();current=false;expect(()=>withArtifactCurrentChecks(()=>assertArtifactCurrent(a.capture))).toThrow('changed');expect(a.calls()).toBe(2)
 expect(()=>withArtifactCurrentChecks(async()=>{called=true})).toThrow('synchronous');expect(called).toBe(false)
 expect(()=>withArtifactCurrentChecks((()=>Promise.resolve()) as unknown as ()=>void)).toThrow('synchronously');expect(()=>assertArtifactCurrent(a.capture)).toThrow('changed')
})
it('captures exact assertion methods/receivers and refuses replacement before flush',()=>{
 const a=proof();expect(()=>withArtifactCurrentChecks(()=>{assertArtifactCurrent(a.capture);a.capture.assertCurrent=()=>{}})).toThrow('Changed original artifact assertion');expect(a.calls()).toBe(0)
})
it('combines the captured held proof only with original pure guards; other callbacks stay immediate',()=>{
 const a=proof();const held=()=>assertArtifactCurrent(a.capture),receiver={};const guard=createArtifactCurrentGuard(()=>assertArtifactCurrent(a.capture));assertHeldWithArtifactGuard(held,guard,receiver);expect(a.calls()).toBe(1)
 assertHeldWithArtifactGuard(held,function(this:object){expect(this).toBe(receiver);expect(a.calls()).toBe(2);assertArtifactCurrent(a.capture)},receiver);expect(a.calls()).toBe(3)
})
it('keeps arbitrary fact liveness callbacks outside grouping and revalidates after them',async()=>{
 const {heldFactOwner}=await import('../src/coordinator/fact-owner.ts');let current=true;const a=proof(()=>{if(!current)throw Error('changed')});const ownership={assertHeld(){assertArtifactCurrent(a.capture)}} as unknown as import('../src/coordinator/ownership.ts').Ownership
 const held=heldFactOwner({sessionId:'s',incarnation:'i'},ownership,()=>{assertArtifactCurrent(a.capture);current=false});expect(()=>held.assertHeld()).toThrow('changed');expect(a.calls()).toBe(2)
 current=true;const pure=heldFactOwner({sessionId:'s',incarnation:'i'},ownership,createArtifactCurrentGuard(()=>assertArtifactCurrent(a.capture)));pure.assertHeld();expect(a.calls()).toBe(4);await Promise.resolve();current=false;expect(()=>pure.assertHeld()).toThrow('changed');expect(a.calls()).toBe(5)
})
it('flushes pending proofs and keeps an unknown nested admission callback immediate',()=>{
 let current=false,effects=0;const a=proof(()=>{if(!current)throw Error('changed')});expect(()=>withArtifactCurrentChecks(()=>{assertArtifactCurrent(a.capture);assertHeldWithArtifactGuard(()=>assertArtifactCurrent(a.capture),()=>{effects++},{})})).toThrow('changed');expect(effects).toBe(0)
 current=true;withArtifactCurrentChecks(()=>{assertArtifactCurrent(a.capture);assertHeldWithArtifactGuard(()=>assertArtifactCurrent(a.capture),()=>{effects++;expect(a.calls()).toBe(3)},{})});expect(effects).toBe(1)
})
it('does not defer user liveness assertions nested under an existing pure guard',async()=>{
 const {heldFactOwner}=await import('../src/coordinator/fact-owner.ts');let effects=0;const a=proof(()=>{throw Error('changed')});const ownership={assertHeld(){}} as unknown as import('../src/coordinator/ownership.ts').Ownership
 const held=heldFactOwner({sessionId:'s',incarnation:'i'},ownership,()=>{assertArtifactCurrent(a.capture);effects++});expect(()=>withArtifactCurrentChecks(()=>held.assertHeld())).toThrow('changed');expect(effects).toBe(0)
})

it('keeps custom source entry accessors on the original immediate fallback',async()=>{
 const {createManagedExecutionSource}=await import('../src/coordinator/managed-execution-source.ts');let reads=0,checks=0,held=0
 const ports={id:'custom',entry:{},ownership:{assertHeld(){held++}},backend:{},transitions:{},loadOwned:async()=>{throw Error('unused')},get assertEntry(){reads++;return ()=>{checks++}}}
 const source=createManagedExecutionSource(ports as unknown as Parameters<typeof createManagedExecutionSource>[0])
 expect(reads).toBe(0);source.assertCurrent();expect({reads,checks,held}).toEqual({reads:1,checks:1,held:1})
})

it.each(['accessors','proxy'] as const)('preserves original source constructor field order for custom %s',async mode=>{
 const {createManagedExecutionSource}=await import('../src/coordinator/managed-execution-source.ts')
 const calls:string[]=[],entry={},ownership={assertHeld(){}}
 const data={id:'custom',entry,ownership,backend:{},transitions:{},loadOwned:async()=>{throw Error('unused')},assertEntry(){}}
 let ports:typeof data
 if(mode==='accessors'){
  ports={...data}
  for(const key of ['entry','id','ownership'] as const)Object.defineProperty(ports,key,{get(){calls.push(key);return data[key]}})
 }else ports=new Proxy(data,{get(target,key,receiver){calls.push(String(key));return Reflect.get(target,key,receiver)},getOwnPropertyDescriptor(target,key){calls.push('descriptor:'+String(key));return Reflect.getOwnPropertyDescriptor(target,key)},ownKeys(target){calls.push('ownKeys');return Reflect.ownKeys(target)}})
 createManagedExecutionSource(ports as unknown as Parameters<typeof createManagedExecutionSource>[0])
 expect(calls).toEqual(['entry','id','ownership'])
})
