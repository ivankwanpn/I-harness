import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createSession, createNondurableFactOwner, committedFactSeqs } from '@i-harness/core-session'
import * as tools from '../src/index.ts'
import type { Tool, ToolExec, PreparedCall } from '../src/types.ts'
import { preparedExecutionOwnerContext } from '../src/registry/prepared-body.ts'
import { createToolResultRetention } from '../../session-executor/src/lifecycle/result-retention.ts'
import { resultSourceBinding } from '../../session-executor/src/lifecycle/result-sources.ts'

type ParentFixture = {ctx:ReturnType<typeof createContext>;view:ReturnType<typeof createSession>;registry:ReturnType<typeof tools.createToolRegistry>;id:string}
function fixture(parent?: ParentFixture, sameSession = false, omitContext = false) {
  const ctx = parent ? parent.ctx.scope.mount() : createContext()
  const view = sameSession ? parent!.view : createSession(), owner = createNondurableFactOwner(view)
  const action = owner.beginAction(), source = action.registerSettlementSource(async () => {})
  const context = { view, factOwner: owner, context: ctx, sessionId: sameSession ? parent!.id : parent ? 'child' : 'parent' }
  const registry = tools.createToolRegistry(ctx, { ...(!omitContext ? { executionOwner: context } : {}), ...(parent ? { inheritResultRetention: parent.registry } : {}) } as any)
  return { ctx,view,owner,action,source,registry,id:context.sessionId,context,
    async prepare(name: string, resultConsumer?: 'code') {
      const callId = `${context.sessionId}-${view.events.length}`
      const [callEventSeq] = committedFactSeqs(await action.facts.tools.call({ type:'tool/call',name,callId,args:{} }))
      committedFactSeqs(await action.facts.tools.dispatch(callId,{kind:'prior',seq:callEventSeq!,expectedType:'tool/call'}))
      return registry.prepare({name,args:{}},action.signal,{session:view,sessionId:context.sessionId,callId,callEventSeq,settlementSource:source,...resultConsumer?{resultConsumer}:{}})
    },
    async close() { await source.close(); action.finish(); await ctx.scope.unmount() },
  }
}
const bind = (tool: Tool, leaf: Tool['execute']) => {
  expect((tools as any).bindPreparedShellLeaf).toBeTypeOf('function')
  return (tools as any).bindPreparedShellLeaf(tool,leaf)
}

it('refuses a shaped execution owner and accessor context before invoking hooks', async () => {
  const ctx=createContext(),view=createSession(),owner=createNondurableFactOwner(view)
  let reads=0
  const fake={...owner}, accessor=Object.defineProperty({factOwner:owner,context:ctx},'view',{enumerable:true,get(){reads++;return view}})
  for(const value of [{view,factOwner:fake,context:ctx},{view:{...view},factOwner:owner,context:ctx},accessor]) expect(()=>tools.createToolRegistry(ctx,{executionOwner:value} as any)).toThrow()
  expect(reads).toBe(0); await ctx.scope.unmount()
})

it('claims the actual prepared leaf once and expires it on body completion', async () => {
  const f=fixture(); let entry:any,claim:any,effects=0
  const leaf:Tool['execute']=async(_args,exec)=>{claim=entry.enter(exec);claim.assertCurrent();claim.consume();effects++;expect(()=>claim.consume()).toThrow();return 'done'}
  const tool:Tool={name:'shell',description:'',inputSchema:{},execute:leaf}; entry=bind(tool,leaf); f.registry.register(tool)
  try {
    const prepared=await f.prepare('shell');expect(await f.registry.dispatch(prepared)).toBe('done')
    expect(claim.context.view).toBe(f.view);expect(claim.context.factOwner).toBe(f.owner)
    expect(()=>claim.assertCurrent()).toThrow();await expect(f.registry.dispatch(prepared)).rejects.toThrow();expect(effects).toBe(1)
  } finally { await f.close() }
})

it('keeps an authenticated child independent and a same-view workflow nested', async () => {
  const parent=fixture(),child=fixture(parent),nested=fixture(parent,true),absent=fixture(parent,false,true)
  let entry:any;const received:any[]=[]
  const leaf:Tool['execute']=async(_args,exec)=>{const claim=entry.enter(exec);received.push(claim?.context.view);return 'shell'}
  const shell:Tool={name:'shell',description:'',inputSchema:{},execute:leaf};entry=bind(shell,leaf)
  child.registry.register(shell);nested.registry.register(shell);absent.registry.register(shell)
  parent.registry.register({name:'workflow',description:'',inputSchema:{},async execute(){await child.registry.dispatch(await child.prepare('shell'));await nested.registry.dispatch(await nested.prepare('shell'));await absent.registry.dispatch(await absent.prepare('shell'));return 'workflow'}})
  try { await parent.registry.dispatch(await parent.prepare('workflow'));expect(received).toEqual([child.view,undefined,undefined]) }
  finally { await absent.close();await nested.close();await child.close();await parent.close() }
})

it.each(['fulfilled','false-rejection'] as const)('retains expired Workflow ancestry for detached same-view work after %s', async outcome => {
  const parent=fixture(),nested=fixture(parent,true),child=fixture(parent)
  const release=Promise.withResolvers<void>();let detached:Promise<void>|undefined,entry:any
  const received:unknown[]=[]
  const leaf:Tool['execute']=async(_args,exec)=>{received.push(entry.enter(exec)?.context.view);return 'shell'}
  const shell:Tool={name:'shell',description:'',inputSchema:{},execute:leaf};entry=bind(shell,leaf)
  nested.registry.register(shell);child.registry.register(shell)
  parent.registry.register({name:'workflow',description:'',inputSchema:{},async execute(){
    detached=release.promise.then(async()=>{await nested.registry.dispatch(await nested.prepare('shell'));await child.registry.dispatch(await child.prepare('shell'))})
    if(outcome==='false-rejection')throw false
    return 'workflow'
  }})
  try {
    const outer=parent.registry.dispatch(await parent.prepare('workflow'))
    if(outcome==='false-rejection')await expect(outer).rejects.toBe(false)
    else expect(await outer).toBe('workflow')
    expect(received).toEqual([]);release.resolve();await detached
    expect(received).toEqual([undefined,child.view])
  }finally{release.resolve();await detached;await child.close();await nested.close();await parent.close()}
})

it.each(['session','sessionId','callId','callEventSeq','resultConsumer','modelGeneration'] as const)('refuses changed %s across the original retention descriptor await', async field => {
  for(const getter of [false,true]){
    const f=fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
    let prepared:PreparedCall|undefined,reads=0
    const original=createToolResultRetention({} as any,async()=>{entered.resolve();await release.promise;return undefined})
    const retention={...original,prepare(call:PreparedCall,context?:tools.ToolExecutionOwnerContext){prepared=call;return original.prepare!(call,context)}}
    const registry=tools.createToolRegistry(f.ctx,{resultRetention:retention,executionOwner:f.context})
    registry.register({name:'shell',description:'',inputSchema:{},async execute(){return 'unused'}})
    const pending=registry.prepare({name:'shell',args:{}},f.action.signal,{session:f.view,sessionId:f.id,callId:'original',callEventSeq:0,settlementSource:f.source})
    void pending.catch(()=>{})
    try{
      await entered.promise
      const replacement=field==='session'?createSession():field==='callEventSeq'?9:field==='resultConsumer'?'code':'changed'
      Object.defineProperty(prepared!.exec,field,{enumerable:true,configurable:true,...getter?{get(){reads++;return replacement}}:{value:replacement,writable:true}})
      expect(()=>preparedExecutionOwnerContext(prepared!)).toThrow()
      release.resolve();await expect(pending).rejects.toThrow()
      expect(resultSourceBinding(prepared!.exec)).toBeUndefined();expect(reads).toBe(0)
    }finally{release.resolve();await pending.catch(()=>{});await f.close()}
  }
})

it.each(['exec','tool','call'] as const)('refuses replacement %s references during retention preparation without reading getters', async field => {
  const f=fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  let prepared:PreparedCall|undefined,exec:ToolExec|undefined,reads=0
  const original=createToolResultRetention({} as any,async()=>{entered.resolve();await release.promise;return undefined})
  const retention={...original,prepare(call:PreparedCall,context?:tools.ToolExecutionOwnerContext){prepared=call;exec=call.exec;return original.prepare!(call,context)}}
  const registry=tools.createToolRegistry(f.ctx,{resultRetention:retention,executionOwner:f.context})
  registry.register({name:'shell',description:'',inputSchema:{},async execute(){return 'unused'}})
  const pending=registry.prepare({name:'shell',args:{}},f.action.signal,{session:f.view,sessionId:f.id,callId:'original',settlementSource:f.source})
  void pending.catch(()=>{})
  try{
    await entered.promise
    Object.defineProperty(prepared!,field,{enumerable:true,configurable:true,get(){reads++;return {}}})
    release.resolve();await expect(pending).rejects.toThrow()
    expect(resultSourceBinding(exec!)).toBeUndefined();expect(reads).toBe(0)
  }finally{release.resolve();await pending.catch(()=>{});await f.close()}
})

it('reads a defined execution context without invoking policy callbacks or checking body activity or Stop', async () => {
  const f=fixture()
  f.registry.register({name:'shell',description:'',inputSchema:{},async execute(){return 'unused'}})
  try{
    const prepared=await f.prepare('shell');let policyReads=0
    prepared.bindingValidation=()=>{policyReads++;throw Error('policy must not run')}
    f.action.stop()
    const context=preparedExecutionOwnerContext(prepared)
    expect(context?.view).toBe(f.view)
    tools.assertPreparedExecutionOwnerContext(prepared,context)
    expect(policyReads).toBe(0)
  }finally{await f.close()}
})

it('rejects a pre-prepare wrapper invoking the saved leaf before any body effect', async () => {
  const f=fixture();let entry:any,effects=0
  const leaf:Tool['execute']=async(_args,exec)=>{entry.enter(exec);effects++;return 'unreachable'}
  const tool:Tool={name:'shell',description:'',inputSchema:{},execute:leaf};entry=bind(tool,leaf)
  tool.execute=async(args,exec)=>leaf(args,exec);f.registry.register(tool)
  try { await expect(f.registry.dispatch(await f.prepare('shell'))).rejects.toThrow();expect(effects).toBe(0) }
  finally { await f.close() }
})

it('keeps ordinary instruction denial available but refuses a foreign execution context at privileged entry', async () => {
  const parent=fixture(),child=fixture(parent);let entry:any,effects=0
  const leaf:Tool['execute']=async(_args,exec)=>{entry.enter(exec);effects++;return 'bad'}
  const tool:Tool={name:'shell',description:'',inputSchema:{},execute:leaf};entry=bind(tool,leaf);child.registry.register(tool)
  try {
    const prepared=await child.registry.prepare({name:'shell',args:{}},parent.action.signal,{session:parent.view,sessionId:parent.id,callId:'foreign',settlementSource:parent.source})
    await expect(child.registry.dispatch(prepared)).rejects.toThrow(/Foreign prepared execution context/)
    expect(effects).toBe(0)
  }finally{await child.close();await parent.close()}
})

it('passes the actual child context through inherited retention preparation', async () => {
  const ctx=createContext(),childCtx=ctx.scope.mount(), seen:any[]=[]
  const retention={prepare:async(_prepared:unknown,context:unknown)=>{seen.push(context)},capture(){throw Error('unused')},captureSynthetic(){throw Error('unused')}}
  const parent=tools.createToolRegistry(ctx,{resultRetention:retention})
  const view=createSession(),owner=createNondurableFactOwner(view),action=owner.beginAction(),source=action.registerSettlementSource(async()=>{})
  const child=tools.createToolRegistry(childCtx,{inheritResultRetention:parent,executionOwner:{view,factOwner:owner,context:childCtx,sessionId:'child'}} as any)
  child.register({name:'shell',description:'',inputSchema:{},async execute(){return 'unused'}})
  try { await child.prepare({name:'shell',args:{}},action.signal,{session:view,sessionId:'child',settlementSource:source});expect(seen[0]).toMatchObject({view,factOwner:owner,context:childCtx,sessionId:'child'}) }
  finally { await source.close();action.finish();await childCtx.scope.unmount();await ctx.scope.unmount() }
})

it('binds the actual registry context through original result retention and refuses a copied override', async () => {
  const ctx=createContext(),view=createSession(),owner=createNondurableFactOwner(view),action=owner.beginAction(),source=action.registerSettlementSource(async()=>{})
  const retention=createToolResultRetention(undefined), context={view,factOwner:owner,context:ctx,sessionId:'owned'}
  const registry=tools.createToolRegistry(ctx,{resultRetention:retention,executionOwner:context} as any)
  registry.register({name:'shell',description:'',inputSchema:{},async execute(){return 'unused'}})
  try {
    const prepared=await registry.prepare({name:'shell',args:{}},action.signal,{session:view,sessionId:'owned',callId:'c',settlementSource:source})
    const actual=(resultSourceBinding(prepared.exec) as any)?.executionOwner
    expect(actual?.factOwner).toBe(owner);expect(actual?.view).toBe(view)
    await expect(retention.prepare!(prepared,{...actual})).rejects.toThrow()
    expect((resultSourceBinding(prepared.exec) as any).executionOwner).toBe(actual)
  } finally {await source.close();action.finish();await ctx.scope.unmount()}
})

it('does not grant a hook the saved leaf or reset a claimed body through twice-next', async () => {
  const f=fixture();let entry:any,effects=0,hook=false
  const leaf:Tool['execute']=async(_args,exec)=>{entry.enter(exec)?.consume();effects++;return 'done'}
  const tool:Tool={name:'shell',description:'',inputSchema:{},execute:leaf};entry=bind(tool,leaf);f.registry.register(tool)
  f.ctx.onCascade('tools/execute',async(input:any,next)=>{if(hook)return leaf({},input.exec);await next();return next()})
  try {
    hook=true;await expect(f.registry.dispatch(await f.prepare('shell'))).rejects.toThrow();expect(effects).toBe(0)
    hook=false;await expect(f.registry.dispatch(await f.prepare('shell'))).rejects.toThrow();expect(effects).toBe(1)
  } finally { await f.close() }
})

it('keeps code consumers ordinary and refuses borrowed or expired privileged receivers', async () => {
  const f=fixture();let entry:any,claimed:any,seen:unknown
  const leaf:Tool['execute']=async(_args,exec)=>{seen=entry.enter(exec);claimed=seen;return 'done'}
  const tool:Tool={name:'shell',description:'',inputSchema:{},execute:leaf};entry=bind(tool,leaf);f.registry.register(tool)
  try {
    expect(entry.enter({} as ToolExec)).toBeUndefined()
    await f.registry.dispatch(await f.prepare('shell','code'));expect(seen).toBeUndefined()
    await f.registry.dispatch(await f.prepare('shell'));expect(claimed).toBeDefined()
    expect(()=>claimed.consume.call({})).toThrow();expect(()=>claimed.consume()).toThrow()
  } finally { await f.close() }
})

it('validates own exec fields and the original validation function without invoking replacement getters', async () => {
  for(const field of ['exec','validation'] as const){
    const f=fixture();let entry:any,prepared:PreparedCall,reads=0,effects=0
    const leaf:Tool['execute']=async(_args,exec)=>{const claim=entry.enter(exec);Object.defineProperty(field==='exec'?exec:prepared,field==='exec'?'sessionId':'bindingValidation',{configurable:true,enumerable:true,get(){reads++;return field==='exec'?f.id:()=>true}});claim.consume();effects++;return 'bad'}
    const tool:Tool={name:'shell',description:'',inputSchema:{},execute:leaf};entry=bind(tool,leaf);f.registry.register(tool)
    try {prepared=await f.prepare('shell');await expect(f.registry.dispatch(prepared)).rejects.toThrow();expect(reads).toBe(0);expect(effects).toBe(0)}finally{await f.close()}
  }
})

it('invalidates a held claim on Stop and expires detached work after a throwing body', async () => {
  const f=fixture();let entry:any,claimed:any
  const reached=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  const leaf:Tool['execute']=async(_args,exec)=>{claimed=entry.enter(exec);reached.resolve();await release.promise;claimed.consume();return 'bad'}
  const tool:Tool={name:'shell',description:'',inputSchema:{},execute:leaf};entry=bind(tool,leaf);f.registry.register(tool)
  try {
    const dispatch=f.registry.dispatch(await f.prepare('shell'));void dispatch.catch(()=>{});await reached.promise;f.action.stop();release.resolve()
    await expect(dispatch).rejects.toThrow();expect(()=>claimed.consume()).toThrow()
  } finally {release.resolve();await f.close()}
})
