import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { createSessionService, type SessionService } from '@i-harness/session-executor'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { HarnessClient, SdkRunError } from '../src/client.ts'
import { createSdkServer } from '../src/server.ts'
import type { SessionEvent } from '@i-harness/core-session'

it.each(['legacy', 'managed'])('returns just the submitted turn through a %s service and real NDJSON transport', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-sdk-run-'))
  const coordinator = mode === 'managed' ? composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract) : undefined
  await coordinator?.create({ sessionId: 's' })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let step = 0
  const model = controlledModel(async function*() {
    const call = ++step
    if (call === 1) { entered.resolve(); await release.promise }
    yield { type: 'text/chunk', text: 'answer-' + call }
    yield { type: 'end' }
  })
  const service = createSessionService({ workspace: root, model, ...(coordinator ? { coordinator, managedRuntime: { systemPrompt: '', tools: [] } } : {}) })
  const incoming = new PassThrough(), outgoing = new PassThrough()
  const observed: SessionEvent[] = []
  const server = createSdkServer({ ...service, async submit(...args) {
    await service.submit(...args)
    if (args[1] === 'fail after the turn') throw Error('Synthetic post-turn failure')
  } }, { onWrite: frame => {
    if ('method' in frame && frame.method === 'session/event') observed.push((frame.params as {event:SessionEvent}).event)
    incoming.write(JSON.stringify(frame) + '\n')
  } })
  const client = new HarnessClient(incoming, outgoing)
  outgoing.on('data', bytes => { void server.handleLine(String(bytes)) })
  try {
    await client.initialize()
    const submit = () => client.run({ sessionId: 's', prompt: 'deliberately identical', clientToken: 'duplicate-token' })
    const first = submit()
    await Promise.race([entered.promise, first.then(() => { throw Error('Expected first request to wait') })])
    const second = submit()
    release.resolve()
    const pair = await Promise.all([first, second])
    expect(pair.map(result => result.text)).toEqual(['answer-1', 'answer-2'])
    for (const [index, result] of pair.entries()) {
      expect(result.events.filter(event => event.type === 'assistant/message').map(event => event.text)).toEqual(['answer-' + (index + 1)])
      expect(result.events.filter(event => event.type === 'turn/end')).toHaveLength(1)
      expect(result.events.filter(event => event.type === 'agent/input/promoted')).toHaveLength(1)
      expect(result.events.filter(event => event.type === 'assistant/chunk').map(event=>event.text)).toEqual(['answer-' + (index + 1)])
      if (mode === 'managed') expect(result.events.filter(e=>e.type==='context/action'&&e.op==='close')).toHaveLength(1)
    }
    expect(pair[0]!.events.some(e => e.seq !== undefined && pair[1]!.events.some(f => f.seq === e.seq))).toBe(false)
    for (const event of observed.filter(e => e.type === 'step/start' || e.type === 'model/exchange-accepted' || e.type==='context/action' || e.type==='context/attempt')) {
      expect(pair.filter(result=>result.events.some(e=>e.type===event.type && e.seq===event.seq))).toHaveLength(1)
    }
    const invalid = await client.run({ sessionId: 's', prompt: '' }).catch(error => error as SdkRunError)
    expect(invalid).toBeInstanceOf(SdkRunError)
    expect(invalid.events).toEqual([])
    const failure = await client.run({ sessionId: 's', prompt: 'fail after the turn' }).catch(error => error as SdkRunError)
    expect(failure).toBeInstanceOf(SdkRunError)
    expect(failure.events.filter(e=>e.type==='assistant/message').map(e=>e.text)).toEqual(['answer-3'])
    const details = (failure as SdkRunError).data as { events:SessionEvent[] }
    expect(details.events.filter(e=>e.type==='assistant/message').every(e=>e.text==='answer-3')).toBe(true)
  } finally {
    release.resolve(); await client.close(); await server.close(); await service.close(); await coordinator?.close(); await rm(root, { recursive: true, force: true })
  }
}, 60_000)

it('replies to a managed prompt only after hydrating its queued events while another session can still reply', async () => {
  let publish!: (e:SessionEvent) => void
  const seen: string[] = [], entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<unknown>()
  const owner = {subscribe(fn:typeof publish) { publish=fn;return ()=>{} },observe:()=>({assertCurrent(){},readHistoryPage:async()=>undefined,inbox:{admitted(){entered.resolve();return gate.promise}}})}
  const service = createSessionService({workspace:process.cwd()})
  const server = createSdkServer({...service, onManagedRuntimeLifecycle(fn) {
    fn({ sessionId:'s',kind:'published',owner } as unknown as Parameters<typeof fn>[0]); return ()=>{}
  }, async submit(id) {
    if (id !== 's') return
    publish({type:'user/message',text:'image',seq:2,imageInputId:'image'})
    publish({type:'assistant/message',text:'answer',seq:3})
    publish({type:'turn/end',seq:4})
  }} satisfies SessionService, { onWrite(frame) {
    if ('method' in frame && frame.method==='session/event') seen.push((frame.params as {event:SessionEvent}).event.type)
    else if ('id' in frame) seen.push(String(frame.id))
  }})
  const request=(sessionId:string)=>server.handleLine(JSON.stringify({jsonrpc:'2.0',id:sessionId,method:'session/prompt',params:{sessionId,prompt:'prompt'}}))
  try {
    await server.handleLine(JSON.stringify({jsonrpc:'2.0',id:'hello',method:'initialize',params:{}}))
    seen.length = 0
    const pending=request('s')
    await Promise.race([entered.promise, pending.then(() => { throw Error('Prompt replied before image hydration started') })])
    await request('other')
    expect(seen).toEqual(['other'])
    gate.resolve({inputId:'image',seq:1,images:[{mediaType:'image/png',dataBase64:'aA=='}]})
    await pending
    expect(seen).toEqual(['other','user/message','assistant/message','turn/end','s'])
  } finally { gate.resolve(undefined); await server.close(); await service.close() }
})

it('keeps a single untagged legacy turn and refuses concurrent ambiguity before sending a second prompt', async () => {
  const incoming = new PassThrough(), outgoing = new PassThrough()
  const client = new HarnessClient(incoming, outgoing)
  const frames: { id: string; method: string }[] = []
  outgoing.on('data', bytes => { frames.push(JSON.parse(String(bytes))) })
  const send = (frame:object) => incoming.write(JSON.stringify({jsonrpc:'2.0',...frame}) + '\n')
  const tell = (type:string, fields:object={}) => send({method:'session/event',params:{sessionId:'s',event:{type,...fields}}})
  const first = client.run({sessionId:'s',prompt:'first'})
  await expect(client.run({sessionId:'s',prompt:'second'})).rejects.toThrow(/Concurrent runs/)
  expect(frames).toHaveLength(1)
  tell('turn/start');tell('assistant/message',{text:'first answer'});tell('turn/end')
  send({id:frames[0]!.id,result:{ok:true,sessionId:'s'}})
  expect((await first).text).toBe('first answer')
  const mixed = client.run({sessionId:'s',prompt:'next'})
  tell('turn/start'); tell('turn/end');tell('turn/start');tell('assistant/message',{text:'foreign'});tell('turn/end')
  send({id:frames[1]!.id,result:{ok:true,sessionId:'s'}})
  await expect(mixed).rejects.toThrow(/overlapping session turns/)
  await expect(client.run({sessionId:'s',prompt:'late',timeoutMs:5})).rejects.toThrow(/timed out/i)
  const resumed = client.run({sessionId:'s',prompt:'again'})
  tell('assistant/message',{text:'late old answer'});tell('turn/end')
  tell('turn/start');tell('user/message',{text:'again'});tell('assistant/message',{text:'new answer'});tell('turn/end')
  send({id:frames.at(-1)!.id,result:{ok:true,sessionId:'s'}})
  expect((await resumed).events.filter(e=>e.type==='assistant/message').map(e=>e.text)).toEqual(['new answer'])
  incoming.end();outgoing.end()
})
