import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { createExecutionLease } from '../../sandbox/src/index.ts'
import { compileExecutionPolicy } from '../../sandbox-policy/src/index.ts'
import { createExecServiceWithReservation, createWorkflowStepFactory } from '../../exec/src/service.ts'
import { createWorkflowExecutor, createWorkflowJobStore } from '../src/runner.ts'
import { createExecFrameCapture } from '../../output-retention/src/index.ts'

function setup(refused = false, options: { tree?: () => Promise<void>; input?: () => Promise<void>; output?: () => AsyncGenerator<{channel:'stdout';data:Buffer}>; retention?: import('../../exec/src/index.ts').ExecResultRetention } = {}) {
  let commits = 0, rollbacks = 0, allow = false
  const root = Promise.withResolvers<{exitCode:number}>()
  const pair = createExecServiceWithReservation({resultRetention:options.retention,execution:{defaultOwner:{sessionId:'workflow'},
    resolvePolicy:owner=>compileExecutionPolicy({mode:'danger-full-access',owner,authority:{kind:'unbound',revision:'r',workspaceRoot:resolve('.')}}),validateAuthority(){},
    selectBackend:()=>({async probe(){return{id:'controlled',availability:'available',assurance:'unverified',features:{writeIsolation:false,readIsolation:false,denyPaths:false,pipes:true,pty:false,retainedTree:true}}},async prepare(spec,policy){return{policy,async rollback(){rollbacks++;if(!allow)throw false},async commit(check){check();commits++;if(refused)throw undefined
      const lease=createExecutionLease({receipt:{executionId:'owned',backendId:'controlled',policyFingerprint:policy.fingerprint,owner:spec.owner,assurance:'unverified'},rootExited:root.promise,waitTreeEmpty:options.tree??(async()=>{}),async settleIo(){},async releaseResources(){},async terminate(){root.resolve({exitCode:0})}})
      return{...lease,get settled(){return lease.settled},pid:1,io:{async write(){},async endInput(){await options.input?.()},output:options.output?options.output():(async function*(){})()}}
    }}}}),
  }})
  return{pair,root,commits:()=>commits,rollbacks:()=>rollbacks,release:()=>{allow=true}}
}
it('fences retries and continue on original failed rollback and reconciles without another launch',async()=>{
  const f=setup(true),steps=createWorkflowStepFactory(f.pair,command=>command),jobs=createWorkflowJobStore()
  const executor=createWorkflowExecutor({exec:f.pair.service,steps,jobs})
  const h=executor.runWorkflow({name:'w',description:'w',steps:[{name:'a',command:'controlled',retry:{attempts:2},on_failure:'continue'},{name:'b',command:'controlled'}]})
  try{
    expect((await h.join()).cleanup).toBe('recovery-required');expect(f.commits()).toBe(1)
    f.release();expect((await h.reconcile()).cleanup).toBe('clean');expect(f.commits()).toBe(1);expect(f.rollbacks()).toBeGreaterThan(1)
  }finally{f.release();await f.pair.service.dispose()}
})

it.each([undefined,null,false])('pure scoping refusal retains falsey rejection and releases without native effect (%j)',async cause=>{
 const f=setup(),factory=createWorkflowStepFactory(f.pair,()=>{throw cause}),step=factory.create({argv:['controlled']})
 try{await expect(step.run()).rejects.toBe(cause);expect(await step.join()).toMatchObject({kind:'clean',execution:'not-dispatched'});expect(f.commits()).toBe(0);step.release()}
 finally{await f.pair.service.dispose()}
})
it.each(['tree','output','input'] as const)('root exit cannot pass held original %s and Stop keeps cleanup owned',async hold=>{
 const tree=Promise.withResolvers<void>(),output=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>()
 const f=setup(false,{tree:async()=>{if(hold==='tree')await tree.promise},input:async()=>{if(hold==='input')await output.promise},output:async function*(){entered.resolve();if(hold==='output')await output.promise;yield{channel:'stdout',data:Buffer.from('owned')}}})
 const jobs=createWorkflowJobStore(),h=createWorkflowExecutor({exec:f.pair.service,steps:createWorkflowStepFactory(f.pair,c=>c),jobs}).runWorkflow({name:'w',description:'w',steps:[{name:'a',command:'controlled'},{name:'b',command:'controlled'}]})
 await entered.promise;f.root.resolve({exitCode:0});let done=false;const joined=h.join().then(v=>{done=true;return v})
 jobs.kill(h.jobId);await Promise.resolve();expect(done).toBe(false);expect(f.commits()).toBe(1)
 output.resolve();tree.resolve();expect((await joined).status).toBe('killed');expect(f.commits()).toBe(1);await f.pair.service.dispose()
})
it('same original native incomplete settlement is recovered by explicit release without launch',async()=>{
 let allow=false
 const f=setup(false,{tree:async()=>{if(!allow)throw false}}),step=createWorkflowStepFactory(f.pair,c=>c).create({argv:['controlled']})
 f.root.resolve({exitCode:0});await step.run().catch(()=>{});const pending=await step.join();expect(pending.kind).toBe('recovery-required')
 expect(Object.isFrozen(pending)).toBe(true);expect(()=>Object.assign(pending,{kind:'clean'})).toThrow();expect(()=>step.release()).toThrow('not acknowledged')
 allow=true;expect((await step.reconcile()).kind).toBe('clean');expect(f.commits()).toBe(1);step.release();await f.pair.service.dispose()
})
it('original frames distinguish recovery-required storage from a ready unavailable dependency',async()=>{
 let available=false,begins=0
 const f=setup(false,{retention:{begin({sourceId}){begins++;return createExecFrameCapture({sourceId,openArtifact:async()=>({async write(){},async reconcileWrite(){return'ready'},async finish(){return available?{kind:'refused',reason:'storage-refused',observedEncodedBytes:0}:{kind:'recovery-required',operationId:'same'}},async reconcile(){throw Error('unused')}})})},observe:c=>c.settle()}})
 const step=createWorkflowStepFactory(f.pair,c=>c).create({argv:['controlled']})
 f.root.resolve({exitCode:0});await step.run();expect((await step.join()).kind).toBe('recovery-required')
 available=true;expect(await step.reconcile()).toMatchObject({kind:'clean',retained:'unavailable'});expect(begins).toBe(1);expect(f.commits()).toBe(1);step.release();await f.pair.service.dispose()
})
it('same step and original service disposal can join failed admission recovery without another start',async()=>{
 const f=setup(true),step=createWorkflowStepFactory(f.pair,c=>c).create({argv:['controlled']})
 await step.run().catch(()=>{});expect((await step.join()).kind).toBe('recovery-required');f.release()
 const [result]=await Promise.all([step.reconcile(),f.pair.service.dispose()]);expect(result.kind).toBe('clean');expect(f.commits()).toBe(1);step.release()
})
it('refuses copied factories/steps and custom cleanup claims before effects',async()=>{
 const f=setup(),factory=createWorkflowStepFactory(f.pair,c=>c)
 expect(()=>createWorkflowStepFactory({...f.pair},c=>c)).toThrow('Original Exec')
 expect(()=>factory.create.call({...factory},{argv:['controlled']})).toThrow('Foreign')
 const step=factory.create({argv:['controlled']});await expect(step.run.call({...step})).rejects.toThrow();step.discard();step.release()
 expect(()=>createWorkflowExecutor({exec:f.pair.service,steps:{...factory}}).runWorkflow({name:'x',description:'x',steps:[]})).toThrow('Original Workflow')
 expect(f.commits()).toBe(0);await f.pair.service.dispose()
})
it('unstarted joins refuse, discard is no-dispatch and original running join cannot start again',async()=>{
  const f=setup(),factory=createWorkflowStepFactory(f.pair,command=>command),step=factory.create({argv:['controlled']})
  await expect(step.join()).rejects.toThrow('not started');step.discard();expect(await step.join()).toMatchObject({kind:'clean',execution:'not-dispatched',retained:'unsupported'})
  await expect(step.run()).rejects.toThrow();expect(f.commits()).toBe(0)
  const active=factory.create({argv:['controlled']});const running=active.run();expect(active.run()).toBe(running)
  f.root.resolve({exitCode:0});await running;expect(await active.join()).toMatchObject({kind:'clean',execution:'dispatched',retained:'unsupported'})
  active.release();await f.pair.service.dispose()
})
