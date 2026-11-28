import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { fromJSONL } from '@i-harness/core-session'
import { HarnessClient } from '@i-harness/sdk'
import { createLoopbackProvider, writeSplitSse } from '../../core-agent/test/helpers/provider-loopback.ts'
import { createDesktopHost } from '../src/host.ts'

it('recovers Responses text and native reasoning for a real tool continuation and cold SDK history', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'ih-responses-history-'))
  const project = join(workspace, 'project'), sessions = join(workspace, 'sessions')
  const marker = 'actual contents of the fixture file', narration = 'Reading the file. 檢查中。', answer = '檔案已讀取。'
  const message = (id: string, text: string, phase: string) => ({ type: 'message', id, role: 'assistant', status: 'completed', phase,
    content: [{ type: 'output_text', text, annotations: [] }] })
  const complete = (output: object[]) => ({ type: 'response.completed', response: { status: 'completed', output } })
  const thought = { type: 'reasoning', id: 'rs_file', summary: [], encrypted_content: 'opaque-native-fixture' }
  const call = { type: 'function_call', id: 'fc_file', call_id: 'call_file', name: 'read', arguments: '{"path":"sample.txt"}', status: 'completed' }
  const readMessage = message('msg_read', narration, 'commentary')
  const answerMessage = message('msg_answer', answer, 'final_answer')
  const round = (input: unknown) => {
    const rows = input as Array<Record<string, unknown>>
    const first = rows.findIndex(row => row.type === 'reasoning' && row.id === thought.id)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(rows.slice(first, first + 4)).toMatchObject([
      thought, { role: 'assistant', content: narration, phase: 'commentary' },
      { type: 'function_call', call_id: call.call_id, name: 'read', arguments: call.arguments },
      { type: 'function_call_output', call_id: call.call_id, output: expect.stringContaining(marker) },
    ])
  }
  const provider = await createLoopbackProvider('/v1/responses', [
    async res => writeSplitSse(res, [
      { type: 'response.output_text.delta', output_index: 1, item_id: readMessage.id, content_index: 0, delta: 'Reading' },
      { type: 'response.output_item.done', output_index: 2, item: call },
      complete([thought, readMessage, call]),
    ]),
    async res => writeSplitSse(res, [complete([answerMessage])]),
    async res => writeSplitSse(res, [
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_cold', delta: 'confirmed' },
      complete([message('msg_cold','confirmed','final_answer')]),
    ]),
  ])
  const settingsPath = join(workspace,'settings.json'), credentialsPath = join(workspace,'keys.json')
  async function open() {
    const input = new PassThrough(), output = new PassThrough()
    const host = await createDesktopHost({workspace:project,sessionDir:sessions,settingsPath,credentialsPath,
      onWrite: frame => { input.write(JSON.stringify(frame)+'\n') }})
    output.on('data', line => { void host.handleLine(String(line)) })
    const client = new HarnessClient(input, output)
    return { client, async close() { await host.close(); input.end(); output.end() } }
  }
  let peer: Awaited<ReturnType<typeof open>> | undefined
  try {
    await mkdir(project); await writeFile(join(project,'sample.txt'),marker)
    await writeFile(settingsPath,JSON.stringify({autoTitle:false,sandboxMode:'read-only',codeMode:{mode:'off'},compaction:{auto:false},
      llm:{defaultModel:{provider:'fixture',model:'fixture-text'},providers:{fixture:{protocol:'openai-responses',baseURL:provider.baseUrl,
        apiKeyEnv:'IH_SNAPSHOT_FIXTURE',models:[{id:'fixture-text',contextWindow:128000,maxTokens:2048}]}}}}))
    await writeFile(credentialsPath,JSON.stringify({refs:{IH_SNAPSHOT_FIXTURE:'local-test-only'}}))
    const sync = (client: HarnessClient) => client.request('desktop/project/sync',{projects:[{id:'p',name:'Project',roots:[project],primaryRoot:project}]})
    peer = await open(); await peer.client.initialize(); await sync(peer.client)
    const {sessionId} = await peer.client.request('session/create',{}) as {sessionId:string}
    await peer.client.request('desktop/session/project/bind',{sessionId,projectId:'p'})
    const result = await peer.client.run({sessionId,prompt:'Read sample.txt and report the result.'})
    expect(result.text).toBe(answer)
    expect(result.events.flatMap(e=>e.type==='assistant/chunk'?[e.text]:[]).join('')).toBe(narration+answer)
    expect(provider.requests).toHaveLength(2)
    round(provider.requests[1]!.body.input)
    await peer.close(); peer = undefined
    const durable = fromJSONL(await readFile(join(sessions,sessionId+'.jsonl'),'utf8'))
    expect(durable.events.filter(e=>e.type==='tool/dispatch')).toHaveLength(1)
    expect(durable.events.filter(e=>e.type==='tool/result'&&e.callId===call.call_id)).toHaveLength(1)
    peer = await open(); await peer.client.initialize(); await sync(peer.client)
    const cold = await peer.client.history(sessionId,{limit:1000})
    expect(cold.events.filter(e=>e.type==='assistant/message')).toEqual(durable.events.filter(e=>e.type==='assistant/message'))
    expect(cold.events.filter(e=>e.type==='assistant/message').map(e=>e.text)).toEqual([narration,answer])
    expect((await peer.client.run({sessionId,prompt:'Confirm the previous result.'})).text).toBe('confirmed')
    expect(provider.requests).toHaveLength(3)
    const replay = provider.requests[2]!.body.input
    round(replay)
    expect(replay).toContainEqual({ role:'assistant',content:answer,phase:'final_answer' })
    expect(provider.errors).toEqual([])
  } finally { await peer?.close(); await provider.close(); await rm(workspace,{recursive:true,force:true}) }
}, 60000)
