import {expect,it} from 'vitest'
import * as plugin from '../src/index.ts'

function fixture(){
 const ctx=plugin.createContext(),seen:string[]=[],domain={}
 const service={drainContextExecution(actual:object){expect(actual).toBe(domain);seen.push('drain');return ['original feedback']},async beforeStopExecution(input:any){expect(input.domain).toBe(domain);seen.push('stop');return {reason:'original continuation'}}}
 ctx.services.register('hooks/claude-runtime',service)
 return {ctx,service,seen,domain}
}
it('recognizes only original registered service and preserves callback receiver, ordering and surface disposal',async()=>{
 const f=fixture(),register=(plugin as any).registerExecutionHookRuntime
 expect(register).toBeTypeOf('function');expect(()=>plugin.captureExecutionHookChannel(f.ctx)).toThrow('FULL_SESSION_REQUIRED')
 const dispose=register(f.ctx,f.service),channel=plugin.captureExecutionHookChannel(f.ctx),surface=channel.capture()
 expect(channel.drainContext(f.domain,surface)).toEqual(['original feedback'])
 expect(await channel.beforeStop({domain:f.domain,sessionId:'original',turns:1,finalText:'done',stopHookActive:false},surface)).toEqual({reason:'original continuation'})
 expect(f.seen).toEqual(['drain','stop']);dispose();expect(()=>channel.assertCurrent(surface)).toThrow('SURFACE_CHANGED')
})
it('refuses copied services and captures original descriptors without invoking substituted getters',()=>{
 const f=fixture(),register=(plugin as any).registerExecutionHookRuntime;expect(register).toBeTypeOf('function')
 expect(()=>register(f.ctx,{...f.service})).toThrow();register(f.ctx,f.service)
 const channel=plugin.captureExecutionHookChannel(f.ctx),surface=channel.capture();let getter=0
 Object.defineProperty(f.service,'drainContextExecution',{get(){getter++;return()=>[]}})
 expect(()=>channel.drainContext(f.domain,surface)).toThrow('SURFACE_CHANGED');expect(getter).toBe(0);expect(f.seen).toEqual([])
})
it('checks a late runtime method replacement after awaiting the captured original callback',async()=>{
 const f=fixture(),register=(plugin as any).registerExecutionHookRuntime;expect(register).toBeTypeOf('function')
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let replacement=0
 f.service.beforeStopExecution=async()=>{entered.resolve();await release.promise;return {reason:'must not publish'}}
 register(f.ctx,f.service);const channel=plugin.captureExecutionHookChannel(f.ctx),running=channel.beforeStop({domain:f.domain,sessionId:'original',turns:1,finalText:'done',stopHookActive:false});void running.catch(()=>{})
 await entered.promise;f.service.beforeStopExecution=async()=>{replacement++;return undefined as never};release.resolve()
 await expect(running).rejects.toThrow('SURFACE_CHANGED');expect(replacement).toBe(0)
})
it('uses the same original inherited slot while child shadowing invalidates the captured surface',()=>{
 const f=fixture(),register=(plugin as any).registerExecutionHookRuntime;expect(register).toBeTypeOf('function');register(f.ctx,f.service)
 const child=f.ctx.scope.mount(),channel=plugin.captureExecutionHookChannel(child),surface=channel.capture()
 expect(channel.drainContext(f.domain,surface)).toEqual(['original feedback'])
 child.services.register('hooks/claude-runtime',{...f.service});expect(()=>channel.assertCurrent(surface)).toThrow('SURFACE_CHANGED')
})
it('a genuine registered service in a foreign scope is not an owned compatibility registration for that scope',()=>{
 const f=fixture(),register=(plugin as any).registerExecutionHookRuntime;register(f.ctx,f.service)
 const foreign=plugin.createContext();foreign.services.register('hooks/claude-runtime',f.service)
 expect(()=>plugin.captureExecutionHookChannel(foreign)).toThrow('FULL_SESSION_REQUIRED');expect(f.seen).toEqual([])
})
it('preserves an original falsey callback failure without invoking its replacement or replaying it',async()=>{
 const f=fixture(),register=(plugin as any).registerExecutionHookRuntime;let calls=0
 f.service.beforeStopExecution=async()=>{calls++;throw undefined};register(f.ctx,f.service)
 const channel=plugin.captureExecutionHookChannel(f.ctx)
 await expect(channel.beforeStop({domain:f.domain,sessionId:'original',turns:1,finalText:'done',stopHookActive:false})).rejects.toBeUndefined()
 expect(calls).toBe(1)
})
