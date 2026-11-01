import { expect, it } from 'vitest'
import { withRunnerCleanup, runInheritedCommand } from '../src/runner-cleanup.ts'
it.each(['init','spawn','wait'])('retains primary falsey %s failure while waiting for cleanup and retains temp on refusal',async stage=>{
 let reject!:(e:unknown)=>void;const cleanup=new Promise<void>((_a,b)=>{reject=b}),trace:unknown[]=[]
 const sandbox={async init(){trace.push('init');if(stage==='init')throw 0},async spawn(){trace.push('spawn');if(stage==='spawn')throw 0;return {pid:1,async wait(){trace.push('wait');throw 0}}},async disposeAsync(){trace.push('dispose');await cleanup}}
 const outcome=withRunnerCleanup(()=>runInheritedCommand(sandbox,{command:'cmd'},()=>trace.push('environment')),()=>({sandbox,temp:'owned'}),e=>trace.push(e),()=>trace.push('remove'))
 void outcome.catch(()=>{});await new Promise(r=>setImmediate(r));expect(trace).toContain('dispose');expect(trace).not.toContain('remove');if(stage==='init')expect(trace).not.toContain('spawn');if(stage==='spawn')expect(trace).not.toContain('wait');reject(false);await expect(outcome).rejects.toBe(0);expect(trace).toContain(false);expect(trace).not.toContain('remove')
})
it('preserves child DWORD and removes temp only after acknowledged async cleanup',async()=>{
 let resolve!:()=>void;const gate=new Promise<void>(r=>{resolve=r}),trace:string[]=[]
 const result=withRunnerCleanup(async()=>259,()=>({sandbox:{async disposeAsync(){trace.push('dispose');await gate}},temp:'owned'}),()=>{},()=>trace.push('remove'));await Promise.resolve();await Promise.resolve();expect(trace).toEqual(['dispose']);resolve();expect(await result).toBe(259);expect(trace).toEqual(['dispose','remove'])
})
it('construction failure leaves no sandbox debt and still cleans standalone temp',async()=>{
 let removed=false;const result=withRunnerCleanup(async()=>{throw undefined},()=>({temp:'owned'}),()=>{},()=>{removed=true});await expect(result).rejects.toBeUndefined();expect(removed).toBe(true)
})
