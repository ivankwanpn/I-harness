import {expect,it} from 'vitest'
import {createContext} from '@i-harness/core-plugin'
import {createToolRegistry,readToolInvocationDomain} from '../src/index.ts'
it('keeps genuine public invocation compatibility explicit and never enrolls copied hook payloads',async()=>{
 const ctx=createContext(),registry=createToolRegistry(ctx);let bodies=0,policy:object|undefined
 ctx.on('tools/pre-execute',input=>{policy=input as object;expect(readToolInvocationDomain(policy)).toBeUndefined();expect(()=>readToolInvocationDomain({...policy})).toThrow('Original tool invocation')})
 ctx.onCascade('tools/execute',async(input,next)=>{expect(readToolInvocationDomain((input as any).exec)).toBeUndefined();return next()})
 registry.register({name:'probe',description:'original public body',inputSchema:{type:'object'},async execute(_args,exec){expect(readToolInvocationDomain(exec)).toBeUndefined();bodies++;return 'original'}})
 expect((await registry.execute({name:'probe',args:{}})).output).toBe('original');expect(bodies).toBe(1);expect(()=>readToolInvocationDomain(policy!)).toThrow('expired')
})
it('foreign lookup inputs never invoke caller getters or accept supplied domain labels',()=>{
 let getters=0;const copied=Object.defineProperty({domain:{},sessionId:'same',callEventSeq:1},'exec',{get(){getters++;throw Error('Caller getter')}})
 expect(()=>readToolInvocationDomain(copied)).toThrow('Original tool invocation');expect(getters).toBe(0)
})
