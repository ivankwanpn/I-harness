import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createSessionService } from '../src/index.ts'
import { rmWorkspaceSync } from './helpers.ts'
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

it('opposite real list completion order selects identical complete instruction text in a deterministic lexical order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-order-instructions-')), a = join(root, 'a'), b = join(root, 'b')
  await mkdir(a); await mkdir(b)
  await writeFile(join(root, 'AGENTS.md'), 'ORDER_REQUIRED_CWD')
  await writeFile(join(a, 'AGENTS.md'), 'ORDER_SCOPE_A'); await writeFile(join(b, 'AGENTS.md'), 'ORDER_SCOPE_B')
  const bodies: string[] = [], server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; bodies.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing loopback')
  const service = createSessionService({ workspace: root, model: createOpenAICompatibleClient({ model: 'fixture', apiKey: 'owned-loopback', baseUrl: `http://127.0.0.1:${address.port}` }), contextWindow: 100000, codeMode: { mode: 'off' } })
  const texts: string[] = [], original = fs.realpath
  let blocked = '', entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const mapping = vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => { if (String(args[0]) === blocked) { entered.resolve(); await release.promise }; return original(...args) })
  try {
    for (const [index, delayed] of [a, b].entries()) {
      const assembly = await service.assemblyFor(`order-${index}`), tool = assembly.tools.get('list_dir')!, exec = { session: assembly.session, ctx: assembly.ctx, callId: `read-${index}` } as Parameters<typeof tool.execute>[1]
      blocked = delayed; entered = Promise.withResolvers<void>(); release = Promise.withResolvers<void>()
      const order: string[] = [], first = tool.execute({ path: delayed }, exec).then(value => { order.push(delayed); return value })
      await entered.promise
      const other = delayed === a ? b : a
      expect(await tool.execute({ path: other }, exec)).toMatchObject({ instruction_scope: { status: 'queued' } }); order.push(other)
      blocked = ''; release.resolve(); expect(await first).toMatchObject({ instruction_scope: { status: 'queued' } })
      expect(order).toEqual([other, delayed])
      await assembly.agent.followup('same parallel read task')
      const current = assembly.session.events.findLast(event => event.type === 'runtime/context')
      if (current?.type !== 'runtime/context') throw Error('Missing owned current context')
      texts.push(current.sections.find(section => section.name === 'instructions')!.text)
    }
    expect(bodies).toHaveLength(2)
    expect(texts[0]).toBe(texts[1])
    for (const text of texts) {
      expect(text.split('ORDER_REQUIRED_CWD')).toHaveLength(2)
      expect(text.split('ORDER_SCOPE_A')).toHaveLength(2); expect(text.split('ORDER_SCOPE_B')).toHaveLength(2)
      expect(text.indexOf('ORDER_SCOPE_A')).toBeLessThan(text.indexOf('ORDER_SCOPE_B'))
    }
  } finally { blocked = ''; release.resolve(); mapping.mockRestore(); await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmWorkspaceSync(root) }
})
