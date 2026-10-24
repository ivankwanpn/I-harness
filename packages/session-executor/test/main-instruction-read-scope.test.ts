import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AuthorityState } from '@i-harness/sandbox'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createSessionService } from '../src/index.ts'
import { rmWorkspaceSync } from './helpers.ts'
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

it.each(['external', 'canonical-escape', 'mapping-unavailable', 'revoked-during-mapping', 'foreign-session'] as const)('actual registered read preserves content and precise instruction scope: %s', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-read-scope-main-')), workspace = join(root, 'workspace'), outside = join(root, 'outside')
  await mkdir(workspace); await mkdir(outside)
  await writeFile(join(workspace, 'AGENTS.md'), 'SCOPE_CURRENT_ROOT')
  await writeFile(join(outside, 'AGENTS.md'), 'EXTERNAL_POISON_RULE')
  await writeFile(join(outside, 'data.txt'), 'kept actual bytes')
  await writeFile(join(workspace, 'data.txt'), 'kept actual bytes')
  if (mode === 'canonical-escape') await symlink(outside, join(workspace, 'alias'), 'junction')
  const target = mode === 'external' ? join(outside, 'data.txt') : mode === 'canonical-escape' ? join(workspace, 'alias', 'data.txt') : join(workspace, 'data.txt')
  let authority: AuthorityState = { kind: 'unbound', revision: 'first', workspaceRoot: workspace }
  let sends = 0
  const server = createServer(async (request, response) => { for await (const _chunk of request) { /* real transport body consumed */ }; sends++; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing loopback')
  const service = createSessionService({ workspace, executionAuthority: () => authority, model: createOpenAICompatibleClient({ model: 'fixture', apiKey: 'owned-loopback', baseUrl: `http://127.0.0.1:${address.port}` }), contextWindow: 100000, codeMode: { mode: 'off' } })
  const original = fs.realpath
  let active = true
  const mapping = vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
    if (active && String(args[0]) === target) {
      if (mode === 'mapping-unavailable') throw Object.assign(Error('precise real mapping fault'), { code: 'EACCES' })
      if (mode === 'revoked-during-mapping') authority = { kind: 'revoked', revision: 'revoked', reason: 'controlled authority revocation' }
    }
    return original(...args)
  })
  try {
    const assembly = await service.assemblyFor('scope'), tool = assembly.tools.get('read')!
    const result = await tool.execute({ path: target }, { session: mode === 'foreign-session' ? { ...assembly.session } : assembly.session, ctx: assembly.ctx, callId: 'actual-read' } as Parameters<typeof tool.execute>[1])
    expect(result).toMatchObject({ content: 'kept actual bytes' })
    const unavailable = mode === 'mapping-unavailable' || mode === 'revoked-during-mapping'
    expect(result).toMatchObject({ instruction_scope: unavailable ? { status: 'unavailable', reason: 'mapping-unavailable' } : { status: 'reference-only', reason: mode === 'canonical-escape' ? 'canonical-escape' : 'outside-root' } })
    active = false; authority = { kind: 'unbound', revision: 'restored', workspaceRoot: workspace }
    if (unavailable) {
      await expect(assembly.agent.followup('unknown continuation cannot drop failed mapping')).rejects.toThrow()
      expect(sends).toBe(0)
      await service.submit('scope', 'new genuine human task recovers', new AbortController().signal)
    } else await assembly.agent.followup('reference content remains usable')
    expect(sends).toBe(1)
    const current = assembly.session.events.findLast(event => event.type === 'runtime/context')
    expect(JSON.stringify(current)).toContain('SCOPE_CURRENT_ROOT'); expect(JSON.stringify(current)).not.toContain('EXTERNAL_POISON_RULE')
  } finally { active = false; mapping.mockRestore(); await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmWorkspaceSync(root) }
})
