import { describe, expect, it } from 'vitest'
import { createCodeModeRuntime } from '../src/runtime.js'
import type { CodeModeOrigin, CodeModeRuntimeOptions } from '../src/types.js'
const read = {name:'read',description:'read',inputSchema:{type:'object'}}
const make = (options: Partial<CodeModeRuntimeOptions> = {}) => createCodeModeRuntime({tools:()=>[read],invoke:async()=>({value:7}), ...options})
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

describe('isolated Code Mode runtime', () => {
  it('bounds discovery metadata and complete definitions in the captured catalog', async () => {
    const definitions = Array.from({length:25},(_,i)=>({name:`lookup.${i}`,description:'Find documents '+ 'x'.repeat(2000),inputSchema:{type:'object'}}))
    definitions.push({name:'huge',description:'oversized schema',inputSchema:{type:'object',properties:{body:{description:'s'.repeat(18000)}}}} as typeof definitions[number])
    const r = make({tools:()=>definitions})
    try {
      const out = await r.exec({code:`text(searchTools('documents').length);text(searchTools('documents',999).length);text(searchTools('lookup_0')[0]);text(describeTool('lookup_0').name);for(const fn of [()=>describeTool('huge'),()=>searchTools('x'.repeat(300)),()=>searchTools('find',-1)]){try{fn()}catch(e){text(e.message)}}`})
      expect(out.status).toBe('completed')
      const lines=out.text.split('\n')
      expect(lines.slice(0,2)).toEqual(['8','20'])
      const row=JSON.parse(lines[2]) as {name:string;alias:string;description:string}
      expect(row).toMatchObject({name:'lookup.0',alias:'lookup_0'})
      expect(Buffer.byteLength(row.description)).toBeLessThanOrEqual(320)
      expect(row).not.toHaveProperty('inputSchema')
      expect(lines[3]).toBe('lookup.0')
      expect(lines[4]).toMatch(/definition.*limit/i)
      expect(lines[5]).toMatch(/query.*limit/i)
      expect(lines[6]).toMatch(/limit.*integer/i)
    } finally { await r.dispose() }
  })
  it('does not let mutable discovery results rewrite captured schemas or broker names', async () => {
    const r=make({tools:()=>[{name:'direct.read',description:'Read file',inputSchema:{type:'object',properties:{path:{type:'string'}}}}],invoke:async call=>call.name})
    try {
      const out=await r.exec({code:`const row=describeTool('direct_read');row.name='changed';row.inputSchema.properties.path.type='number';const found=searchTools('READ');found[0].name='changed';text(describeTool('direct.read').inputSchema.properties.path.type);text(await tools.direct_read({path:'a'}));`})
      expect(out.status).toBe('completed');expect(out.text).toBe('string\ndirect.read')
    } finally {await r.dispose()}
  })
  it('keeps search metadata bounded even when an authorized tool name is unusually large', async () => {
    const r=make({tools:()=>[{...read,name:'n'.repeat(4000)},read]})
    try {
      const out=await r.exec({code:`const rows=searchTools('');text(rows.some(row=>row.name==='read'));text(Math.max(...rows.map(row=>JSON.stringify(row).length)));`})
      expect(out.status).toBe('completed')
      const [found,size]=out.text.split('\n')
      expect(found).toBe('true');expect(Number(size)).toBeLessThanOrEqual(1024)
    } finally {await r.dispose()}
  })
  it('awaits a tool in an actual QuickJS worker module', async () => {
    const r = make()
    try {
      const out = await r.exec({code:'const v = await tools.read({}); text(v.value);'})
      expect(out.status).toBe('completed'); expect(out.text).toBe('7')
    } finally { await r.dispose() }
  })
  it('copies guest arguments and results and supports parallel promises and catchable body errors', async () => {
    const values: unknown[] = []
    const r = make({invoke:async c => {values.push(c.args); if ((c.args as {bad?: boolean}).bad) throw new Error('body failed'); return {value:7}}})
    try {
      const out = await r.exec({code:`const a = {x:1}; const p = tools.read(a); a.x = 2; const vs = await Promise.all([p, tools.read({})]); vs[0].value=9; text(vs[1].value); try {await tools.read({bad:true})} catch(e) {text(e.message)}`})
      expect(out.status).toBe('completed'); expect(out.text).toBe('7\nbody failed'); expect(values[0]).toEqual({x:1})
    } finally { await r.dispose() }
  })
  it('has no ambient host authority, rejects module loading, and refreshes globals', async () => {
    const r = make()
    try {
      expect((await r.exec({code:`text([typeof process,typeof require,typeof fetch,typeof console].join(',')); globalThis.secret=1;`})).text).toBe('undefined,undefined,undefined,undefined')
      expect((await r.exec({code:'text(typeof secret)'})).text).toBe('undefined')
      expect((await r.exec({code:`import fs from 'node:fs'; text(fs);`})).status).toBe('failed')
      expect((await r.exec({code:`await import('node:fs')`})).status).toBe('failed')
    } finally { await r.dispose() }
  })
  it('commits JSON store only on successful completion and isolates runtime sessions', async () => {
    const r = make(), other = make()
    try {
      expect((await r.exec({code:`store('k',{x:7}); const v=load('k'); v.x=9; text(load('k').x);`})).text).toBe('7')
      expect((await r.exec({code:`text(load('k').x); store('k',{x:10}); throw Error('no commit')`})).status).toBe('failed')
      expect((await r.exec({code:`text(load('k').x)`})).text).toBe('7')
      expect((await other.exec({code:`text(load('k'))`})).text).toBe('undefined')
    } finally { await r.dispose(); await other.dispose() }
  })
  it('returns only new output across explicit yielding and waiting', async () => {
    const r = make()
    try {
      const first = await r.exec({code:`text('first'); await yield_control(); await new Promise(r=>setTimeout(r,80)); notify('second'); await new Promise(r=>setTimeout(r,80)); text('third');`,yield_time_ms:2000})
      expect(first.status).toBe('running'); expect(first.text).toBe('first')
      const second = await r.wait({cell_id:first.cellId,yield_time_ms:2000})
      expect(second.status).toBe('running'); expect(second.text).toBe('second')
      const final = await r.wait({cell_id:first.cellId,yield_time_ms:2000})
      expect(final.status).toBe('completed'); expect(final.text).toBe('third')
      await expect(r.wait({cell_id:first.cellId})).rejects.toThrow(/unavailable|unknown|retired/i)
    } finally { await r.dispose() }
  })
  it('bounds CPU and heap without charging async wait as CPU work', async () => {
    const r = make({config:{cpuTimeMs:50,memoryLimitMb:8}})
    const heap = make({config:{cpuTimeMs:1000,memoryLimitMb:8}})
    try {
      const cpu=await r.exec({code:'while(true){}',yield_time_ms:2000})
      expect(cpu.status).toBe('failed');expect(cpu.error).toMatch(/CPU|interrupt/i)
      const memory=await heap.exec({code:`new Array(2000000).fill('x')`,yield_time_ms:2000})
      expect(memory.status).toBe('failed'); expect(memory.error).toMatch(/memory|allocation/i)
      expect((await r.exec({code:`await new Promise(r=>setTimeout(r,150)); text('awake')`,yield_time_ms:2000})).text).toBe('awake')
    } finally { await r.dispose(); await heap.dispose() }
  })
  it('rejects concurrent observers and terminates pending work', async () => {
    const r = make()
    try {
      const first = await r.exec({code:'await new Promise(()=>{})',yield_time_ms:0})
      const observing = r.wait({cell_id:first.cellId,yield_time_ms:200})
      await expect(r.wait({cell_id:first.cellId,yield_time_ms:0})).rejects.toThrow(/observer/i)
      expect((await observing).status).toBe('running')
      expect((await r.wait({cell_id:first.cellId,terminate:true})).status).toBe('terminated')
    } finally { await r.dispose() }
  })
  it('bounds source, store, transfers, pending tools and emitted output', async () => {
    const r = make({config:{maxSourceBytes:1024,maxStoreBytes:100,maxResultBytes:100,maxPendingCalls:1},invoke:async()=>{await sleep(30); return {large:'x'.repeat(300)}}})
    try {
      await expect(r.exec({code:' '.repeat(1025)})).rejects.toThrow(/source/i)
      expect((await r.exec({code:`store('k','x'.repeat(200));`})).status).toBe('failed')
      expect((await r.exec({code:`try {await tools.read({})}catch(e){text(e.message)}`})).text).toMatch(/transfer|result|limit/i)
      expect((await r.exec({code:`await Promise.all([tools.read({}),tools.read({})]);`})).status).toBe('failed')
      const bounded = await r.exec({code:`for(let i=0;i<500;i++) text('abcdefghij');`,max_output_tokens:4})
      expect(bounded.text.length).toBeLessThanOrEqual(16); expect(bounded.truncated).toBe(true)
    } finally { await r.dispose() }
  })
  it('cancels unawaited tools and timers and drains late host producers on disposal', async () => {
    let finish!: () => void, aborted = false, completed = false
    const r = make({invoke:async c=>{c.signal.addEventListener('abort',()=>{aborted=true}); await new Promise<void>(r=>{finish=r}); completed=true; return {value:9}}})
    try {
      const out = await r.exec({code:`tools.read({}); setTimeout(()=>text('late'),50); text('done');`})
      expect(out.status).toBe('completed'); expect(out.text).toBe('done'); expect(aborted).toBe(true)
      let disposed = false
      const draining = r.dispose().then(()=>{disposed=true})
      await sleep(20); expect(disposed).toBe(false); finish(); await draining; expect(completed).toBe(true)
      await expect(r.exec({code:'text(1)'})).rejects.toThrow(/disposed/i)
    } finally { finish?.(); await r.dispose() }
  })
  it('owner abort stops a pending cell and late callbacks cannot write its store', async () => {
    const owner = new AbortController()
    const r = make({invoke:async()=>{await sleep(100); return {value:99}}})
    try {
      const first = await r.exec({code:`await tools.read({}); store('late',1);`,yield_time_ms:0},{abortSignal:owner.signal})
      owner.abort('owner stopped')
      expect((await r.wait({cell_id:first.cellId,yield_time_ms:2000})).status).toBe('terminated')
      await sleep(120)
      expect((await r.exec({code:`text(load('late'))`})).text).toBe('undefined')
    } finally { await r.dispose() }
  })
  it('makes policy refusals fatal even when guest catches the rejection', async () => {
    const r = make({invoke:async()=>{throw Object.assign(new Error('guardian denied'),{policyRefusal:true})}})
    try {
      const out = await r.exec({code:`try {await tools.read({})} catch(e) {text('caught');} text('success')`})
      expect(out.status).toBe('terminated'); expect(out.error).toContain('guardian denied'); expect(out).toHaveProperty('policyRefusal',true); expect(out.text).not.toContain('success')
    } finally { await r.dispose() }
  })
  it('discards oversized text and media with truncation before host transfer', async () => {
    const r = make({config:{maxResultBytes:512}})
    try {
      const out = await r.exec({code:`text('x'.repeat(20000)); image({mediaType:'image/png',dataBase64:'YWFh'.repeat(400)}); text('after');`})
      expect(out.status).toBe('completed'); expect(out.text).toBe('after'); expect(out.truncated).toBe(true)
    } finally { await r.dispose() }
  })
  it('preserves valid JSON escaping at argument/result transfer boundaries', async () => {
    const r = make({config:{maxResultBytes:256},invoke:async c=>c.args})
    try {
      const out = await r.exec({code:`const result=await tools.read({value:'"'.repeat(100)}); text(result.value.length);`})
      expect(out.status).toBe('completed'); expect(out.text).toBe('100')
    } finally { await r.dispose() }
  })
  it('forwards bounded image and audio items without duplicating base64 in text', async () => {
    const r = make()
    try {
      const out = await r.exec({code:`image({type:'image',mimeType:'image/png',data:'YQ=='}); audio({type:'audio',mimeType:'audio/wav',data:'YQ=='});`})
      expect(out.status).toBe('completed'); expect(out.text).toBe('')
      expect(out.items).toEqual([{type:'image',image:{mediaType:'image/png',dataBase64:'YQ=='}},{type:'audio',audioUrl:'data:audio/wav;base64,YQ=='}])
      const large=await r.exec({code:`image({mediaType:'image/png',dataBase64:'YWFh'.repeat(8192)});`})
      expect(large.status).toBe('completed');expect(large.truncated).toBe(false);expect(large.text).toBe('')
      expect(large.items[0]).toMatchObject({type:'image',image:{dataBase64:'YWFh'.repeat(8192)}})
    } finally { await r.dispose() }
  })
  it('successful completion wins later termination and commits concurrent store writes in completion order', async () => {
    const r = make()
    try {
      const slow = await r.exec({code:`store('order','slow'); await new Promise(r=>setTimeout(r,200));`,yield_time_ms:0})
      expect((await r.exec({code:`store('order','fast')`})).status).toBe('completed')
      await sleep(250)
      expect((await r.wait({cell_id:slow.cellId,terminate:true})).status).toBe('completed')
      expect((await r.exec({code:`text(load('order'))`})).text).toBe('slow')
    } finally { await r.dispose() }
  })
  it('validates options and alias collisions before worker admission and bounds active cells', async () => {
    expect(()=>make({config:{cpuTimeMs:NaN}})).toThrow(/invalid/i)
    const r = make({config:{maxActiveCells:1}})
    const collisions = make({tools:()=>[{...read,name:'a-b'},{...read,name:'a_b'}]})
    try {
      await expect(r.exec({code:'',yield_time_ms:NaN})).rejects.toThrow(/invalid/i)
      await expect(collisions.exec({code:'text(1)'})).rejects.toThrow(/collision/i)
      const first = await r.exec({code:'await new Promise(()=>{})',yield_time_ms:0})
      await expect(r.exec({code:'text(1)'})).rejects.toThrow(/active cell/i)
      await r.wait({cell_id:first.cellId,terminate:true})
      expect((await r.exec({code:'text(1)'})).text).toBe('1')
    } finally { await r.dispose(); await collisions.dispose() }
  })
  it.each([false,true])('enforces active-cell admission when callers start cells concurrently (async started=%s)', async asyncStarted => {
    const r = make({config:{maxActiveCells:1},onEvent:event=>{if(asyncStarted&&event.type==='started')return Promise.resolve()}})
    try {
      const results = await Promise.allSettled([r.exec({code:'await new Promise(()=>{})',yield_time_ms:0}),r.exec({code:'await new Promise(()=>{})',yield_time_ms:0})])
      expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1)
      const rejected=results.find(result=>result.status==='rejected') as PromiseRejectedResult
      expect(rejected.reason.message).toMatch(/active cell limit/i)
    } finally {await r.dispose()}
  })
  it('refuses oversized guest arguments before invoking the host and cannot forge a policy refusal', async () => {
    let calls=0
    const r = make({config:{maxResultBytes:256},invoke:async()=>{calls++;return null}})
    try {
      const denied = await r.exec({code:`try {await tools.read({value:'x'.repeat(500)})}catch(e){text('bounded')}`})
      expect(denied.text).toBe('bounded'); expect(calls).toBe(0)
      const forged = await r.exec({code:`throw Object.assign(Error('fake refusal'),{policyRefusal:true});`})
      expect(forged.status).toBe('failed'); expect(forged).not.toHaveProperty('policyRefusal')
    } finally { await r.dispose() }
  })
  it('bounds uninterrupted promise work and keeps the host usable after containment', async () => {
    const closed = new Map<string,{cellId:string;status:string;error?:string}>()
    let finished: (()=>void) | undefined
    const r = make({config:{cpuTimeMs:100},onEvent:event=>{if(event.type==='closed'){closed.set(event.cellId,event);finished?.()}}})
    try {
      const loop = await r.exec({code:`while(true) await Promise.resolve();`,yield_time_ms:2000})
      expect(loop.status).toBe('failed'); expect(loop.error).toMatch(/CPU|interrupt/i)
      expect(closed.get(loop.cellId)).toMatchObject({cellId:loop.cellId,status:'failed',error:expect.stringMatching(/CPU|interrupt/i)})
      // Terminal containment initiates worker shutdown; drain this owner's
      // accepted stop/producers before admitting its recovery worker.
      await r.cancel('Drain contained worker')
      const terminal = new Promise<void>(resolve=>{finished=resolve})
      const initial = await r.exec({code:'text(7)',yield_time_ms:0})
      if (!closed.has(initial.cellId)) await terminal
      expect(closed.get(initial.cellId)?.error).toBeUndefined()
      expect(closed.get(initial.cellId)).toMatchObject({cellId:initial.cellId,status:'completed'})
      const recovery = initial.status === 'running' ? await r.wait({cell_id:initial.cellId}) : initial
      expect(recovery.status).toBe('completed'); expect(recovery.error).toBeUndefined()
      expect((initial.status === 'running' ? [initial.text,recovery.text] : [initial.text]).filter(Boolean).join('\n')).toBe('7')
    } finally { await r.dispose() }
  })
  it('honors pragma output limits, successful exit, cleared timers and wait cancellation', async () => {
    const r = make()
    try {
      const out = await r.exec({code:`// @exec: {"yield_time_ms":2000,"max_output_tokens":1}\nconst id=setTimeout(()=>text('bad'),0); clearTimeout(id); text('123456'); store('exit',7); exit(); text('bad');`})
      expect(out.status).toBe('completed'); expect(out.text).toBe('1234'); expect(out.truncated).toBe(true)
      expect((await r.exec({code:`text(load('exit'))`})).text).toBe('7')
      const pending = await r.exec({code:'await new Promise(()=>{})',yield_time_ms:0})
      const abort = new AbortController()
      const observation = r.wait({cell_id:pending.cellId,yield_time_ms:2000},abort.signal)
      abort.abort('stop wait')
      expect((await observation).status).toBe('terminated')
    } finally { await r.dispose() }
  })
  it('stops serializing oversized host results before visiting later properties', async () => {
    const r = make({config:{maxResultBytes:256},invoke:async()=>({large:'x'.repeat(10000),get later(){throw Error('visited past bound')}})})
    try {
      const out = await r.exec({code:`try {await tools.read({})} catch(e) {text(e.message)}`})
      expect(out.status).toBe('completed'); expect(out.text).toMatch(/result transfer limit/i)
    } finally { await r.dispose() }
  })
  it('contains output event failures as observations and always releases the observer', async () => {
    const r = make({onEvent:event=>{if(event.type==='output'||event.type==='closed')throw Error('event sink failed')}})
    try {
      const out = await r.exec({code:`text('x')`})
      expect(out.status).toBe('failed'); expect(out.error).toContain('event sink failed')
    } finally { await r.dispose() }
  })
  it('bounds retained completed cells and truthfully refuses evicted observations', async () => {
    let finished!:()=>void, terminalStatus: string | undefined
    const r = make({config:{maxActiveCells:1},onEvent:event=>{
      if(event.type==='closed'){terminalStatus=event.status;finished()}
    }})
    try {
      let first='', last=''
      for(let i=0;i<5;i++) {
        const terminal=new Promise<void>(resolve=>{finished=resolve})
        const out=await r.exec({code:`text(${i});await yield_control();`,yield_time_ms:0})
        if(!i)first=out.cellId
        last=out.cellId
        await terminal
        expect(terminalStatus).toBe('completed')
      }
      await expect(r.wait({cell_id:first})).rejects.toThrow(/retired|unavailable/i)
      expect((await r.wait({cell_id:last})).status).toBe('completed')
    } finally { await r.dispose() }
  })
  it('blocks new admission during cancellation and reopens once tracked tools drain', async () => {
    let release!:()=>void
    let invokeStarted!:()=>void
    const started=new Promise<void>(resolve=>{invokeStarted=resolve})
    const r = make({invoke:async()=>{
      await new Promise<void>(resolve=>{release=resolve;invokeStarted()});return null
    }})
    try {
      const first=await r.exec({code:'await tools.read({})',yield_time_ms:0})
      expect(first.status).toBe('running')
      await started
      const cancelling=r.cancel('stop')
      await expect(r.exec({code:'text(1)'})).rejects.toThrow(/cancel/i)
      release();await cancelling
      let reopened=await r.exec({code:'text(2)',yield_time_ms:0})
      const output=[reopened.text]
      while(reopened.status==='running') {
        reopened=await r.wait({cell_id:reopened.cellId});output.push(reopened.text)
      }
      expect(reopened.status).toBe('completed');expect(output.filter(Boolean).join('\n')).toBe('2')
    } finally {release?.();await r.dispose()}
  })
  it('does not run unawaited promise continuations after the module has completed', async () => {
    let calls=0
    const r = make({invoke:async()=>{calls++;return null}})
    try {
      const out=await r.exec({code:`Promise.resolve().then(()=>tools.read({})); text('done');`})
      expect(out.status).toBe('completed'); expect(out.text).toBe('done'); expect(calls).toBe(0)
    } finally {await r.dispose()}
  })
  it('observes completion on the final job of a promise-pump batch', async () => {
    let finished!:()=>void, closed: {cellId:string;status:string} | undefined
    const r = make({onEvent:event=>{if(event.type==='closed'){closed=event;finished()}}})
    try {
      for(const jobs of [62,63,64,65]) {
        const terminal = new Promise<void>(resolve=>{finished=resolve})
        const initial=await r.exec({code:`for(let i=0;i<${jobs};i++)await Promise.resolve();text('done')`,yield_time_ms:0})
        await terminal
        expect(closed).toMatchObject({cellId:initial.cellId,status:'completed'})
        const final=await r.wait({cell_id:initial.cellId})
        expect(final.status).toBe('completed'); expect([initial.text,final.text].filter(Boolean).join('\n')).toBe('done')
      }
    } finally {await r.dispose()}
  })
  it('rejects concurrent commits that would overflow the session store without losing prior data', async () => {
    const r = make({config:{maxStoreBytes:80}})
    try {
      const slow=await r.exec({code:`store('slow','s'.repeat(40)); await new Promise(r=>setTimeout(r,200))`,yield_time_ms:0})
      expect((await r.exec({code:`store('fast','f'.repeat(40))`})).status).toBe('completed')
      const failed=await r.wait({cell_id:slow.cellId,yield_time_ms:1000})
      expect(failed.status).toBe('failed'); expect(failed.error).toMatch(/store.*limit/i)
      expect((await r.exec({code:`text(load('slow')); text(load('fast').length)`})).text).toBe('undefined\n40')
    } finally {await r.dispose()}
  })
  it('keeps admitted ownership metadata and the original abort signal after caller mutation', async () => {
    const owner = new AbortController(), replacement = new AbortController()
    const origin: CodeModeOrigin = {sessionId:'owner-session',callId:'owner-call',callEventSeq:7,abortSignal:owner.signal}
    let received: CodeModeOrigin | undefined
    const r = make({invoke:async call=>{received=call.origin;return {value:7}}})
    try {
      const first=await r.exec({code:`await yield_control(); await new Promise(r=>setTimeout(r,80)); text((await tools.read({})).value);`,yield_time_ms:2000},origin)
      expect(first.status).toBe('running')
      origin.sessionId='other-session'; origin.callId='other-call'; origin.callEventSeq=99; origin.abortSignal=replacement.signal
      replacement.abort('replacement signal must not own the cell')
      const final=await r.wait({cell_id:first.cellId,yield_time_ms:2000})
      expect(final.status).toBe('completed'); expect(final.text).toBe('7')
      expect(received).toMatchObject({sessionId:'owner-session',callId:'owner-call',callEventSeq:7})
      expect(received?.abortSignal).toBe(owner.signal)
    } finally {await r.dispose()}
  })
  it('bounds guest, host callback and event-sink errors with explicit truncation', async () => {
    const closedErrors: string[]=[]
    const r=make({config:{maxResultBytes:512},onEvent:e=>{if(e.type==='closed')closedErrors.push(e.error??'')},invoke:async()=>{throw Error('h'.repeat(1000000))}})
    const sink=make({onEvent:e=>{if(e.type==='output'||e.type==='closed')throw Error('s'.repeat(1000000))}})
    try {
      const guest=await r.exec({code:`throw Error('x'.repeat(1000000))`,max_output_tokens:0})
      expect(guest.status).toBe('failed'); expect(guest.error?.length).toBe(0);expect(guest.truncated).toBe(true)
      expect(Buffer.byteLength(closedErrors[0])).toBeLessThanOrEqual(512)
      const host=await r.exec({code:'await tools.read({})'})
      expect(host.status).toBe('failed');expect(Buffer.byteLength(host.error??'')).toBeLessThanOrEqual(512);expect(host.truncated).toBe(true)
      const event=await sink.exec({code:`text('x')`,max_output_tokens:2})
      expect(event.status).toBe('failed');expect(Buffer.byteLength((event.error??'')+event.text)).toBeLessThanOrEqual(8);expect(event.truncated).toBe(true)
    } finally {await r.dispose();await sink.dispose()}
  })
  it('decodes host tool results with captured intrinsics after guest replaces JSON helpers', async () => {
    const r=make()
    try {
      const out=await r.exec({code:`JSON.parse=()=>({value:99});JSON.stringify=()=>'{"value":99}';const value=await tools.read({actual:1});text(value.value);store('intrinsic',value);text(load('intrinsic').value);`})
      expect(out.status).toBe('completed');expect(out.text).toBe('7\n7')
    } finally {await r.dispose()}
  })
})
