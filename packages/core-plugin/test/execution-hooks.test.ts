import {expect,it} from 'vitest'
import * as plugin from '../src/index.ts'
it('original owned listeners preserve plain/waterfall/ancestor order and reject legacy Session callbacks',async()=>{
 const register=(plugin as any).onExecutionEvent,waterfall=(plugin as any).waterfallExecutionEvent,capture=(plugin as any).captureExecutionHookChannel
 expect(register).toBeTypeOf('function');expect(waterfall).toBeTypeOf('function');expect(capture).toBeTypeOf('function')
 const parent=plugin.createContext(),child=parent.scope.mount(),seen:string[]=[]
 register(child,'agent/pre-step',()=>{seen.push('child');return{task:'seed'}});waterfall(child,'agent/pre-step',async(input:any,next:any)=>{seen.push(input.task);return next(input)});register(parent,'agent/pre-step',()=>{seen.push('parent')})
 const channel=capture(child),surface=channel.capture();await channel.emit('agent/pre-step',{task:'original'},surface);expect(seen).toEqual(['child','seed','parent'])
 child.on('agent/pre-step',()=>{seen.push('legacy')});expect(()=>channel.assertCurrent(surface)).toThrow();await expect(channel.emit('agent/pre-step',{task:'refuse'})).rejects.toThrow('FULL_SESSION');expect(seen).toEqual(['child','seed','parent'])
})
it('late listener changes refuse before the next original callback and never replay earlier hooks',async()=>{
 const register=(plugin as any).onExecutionEvent,capture=(plugin as any).captureExecutionHookChannel;expect(register).toBeTypeOf('function')
 const ctx=plugin.createContext(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let first=0,second=0
 register(ctx,'agent/pre-step',async()=>{first++;entered.resolve();await release.promise});register(ctx,'agent/pre-step',()=>{second++})
 const channel=capture(ctx),running=channel.emit('agent/pre-step',{});void running.catch(()=>{});await entered.promise;ctx.on('agent/pre-step',()=>{second++});release.resolve();await expect(running).rejects.toThrow();expect(first).toBe(1);expect(second).toBe(0)
})
