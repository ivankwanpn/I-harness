import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { createLoopbackProvider, writeSplitSse } from '../../core-agent/test/helpers/provider-loopback.ts'
import { createDesktopHost } from '../src/host.ts'

const complete = { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 6 } } }
function toolCall(name: string, args: object, index = 0) {
  const item = { id: name, call_id: `call-${name}`, type: 'function_call', name, arguments: '' }
  const text = JSON.stringify(args)
  return [
    { type: 'response.output_item.added', output_index: index, item },
    { type: 'response.function_call_arguments.done', item_id: name, arguments: text },
    { type: 'response.output_item.done', output_index: index, item: { ...item, arguments: text } },
  ]
}

it.skipIf(process.platform !== 'win32')('promotes and runs file search through the original private Desktop host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-owned-file-search-')), workspace = join(root, 'workspace')
  const marker = 'needle from real original search reader'
  const toolNames = (body: Record<string, unknown>) => (body.tools as Array<{ name: string }>).map(tool => tool.name)
  const server = await createLoopbackProvider('/v1/responses', [
    async (response, request) => {
      expect(toolNames(request.body)).not.toContain('grep')
      expect(toolNames(request.body)).not.toContain('glob')
      await writeSplitSse(response, [...toolCall('tool_search', { query: 'select:grep,glob' }), complete])
    },
    async (response, request) => {
      expect(toolNames(request.body)).toEqual(expect.arrayContaining(['grep', 'glob']))
      await writeSplitSse(response, [
        ...toolCall('grep', { pattern: 'needle', path: 'files', mode: 'literal' }),
        ...toolCall('glob', { pattern: '*.txt', path: 'files' }, 1), complete,
      ])
    },
    async (response, request) => {
      expect(JSON.stringify(request.body.input)).toContain(marker)
      await writeSplitSse(response, [{ type: 'response.output_text.delta', delta: 'Search finished' }, complete])
    },
  ])
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  try {
    await mkdir(join(workspace, 'files'), { recursive: true })
    await writeFile(join(workspace, 'files', 'one.txt'), marker + '\n')
    const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
    await writeFile(settingsPath, JSON.stringify({
      autoTitle: false, sandboxMode: 'read-only', windowsSandboxBackend: 'legacy', codeMode: { mode: 'off' },
      llm: { defaultModel: { provider: 'fixture', model: 'fixture' }, providers: { fixture: {
        protocol: 'openai-responses', baseURL: server.baseUrl, apiKeyEnv: 'IH_OWNED_SEARCH_FIXTURE', models: [{ id: 'fixture', contextWindow: 128000 }],
      } } },
    }))
    await writeFile(credentialsPath, JSON.stringify({ refs: { IH_OWNED_SEARCH_FIXTURE: 'loopback-only' } }))
    const frames: RpcMessage[] = []
    host = await createDesktopHost({ workspace, settingsPath, credentialsPath, sessionDir: join(root, 'sessions'),
      sessionStore: 'jsonl', onWrite: frame => frames.push(frame) })
    let serial = 0
    async function call(method: string, params: Record<string, unknown> = {}) {
      const id = ++serial
      await host!.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      const frame = frames.find(frame => 'id' in frame && frame.id === id)
      if (!isRpcSuccess(frame)) throw Error(method + ' failed: ' + JSON.stringify(frame))
      return frame.result
    }
    await call('initialize')
    const { sessionId } = await call('session/create') as { sessionId: string }
    await call('desktop/project/sync', { projects: [{ id: 'root', name: 'Root', roots: [workspace], primaryRoot: workspace }] })
    await call('desktop/session/project/bind', { sessionId, projectId: 'root' })
    expect(await call('desktop/session/input/submit', { sessionId, text: 'Search files for a marker', delivery: 'queue', clientToken: 'owned-file-search' }))
      .toMatchObject({ accepted: true })
    await vi.waitFor(() => {
      expect(server.errors).toEqual([])
      expect(frames).toContainEqual(expect.objectContaining({ method: 'session/event', params:
        expect.objectContaining({ sessionId, event: expect.objectContaining({ type: 'turn/end' }) }) }))
    }, { timeout: 25000 })
    expect(server.requests).toHaveLength(3)
    const { events } = await call('session/history', { sessionId, afterSeq: 0, limit: 100 }) as { events: Array<{ type: string; name?: string; output?: unknown; envelope?: { retention?: { value?: unknown } } }> }
    const output = (name: string) => {
      const event = events.find(event => event.type === 'tool/result' && event.name === name)
      return event?.output ?? event?.envelope?.retention?.value
    }
    expect(output('grep')).toMatchObject({ status: 'completed', matches: [expect.objectContaining({ text: marker })] })
    expect(output('glob')).toMatchObject({ status: 'completed', matches: ['one.txt'] })
  } finally {
    try { await host?.close() } finally { await server.close(); await rm(root, { recursive: true, force: true }) }
  }
}, 45000)
