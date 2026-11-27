import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectedMcpClient, McpMountDeps, McpServerConfig } from '@i-harness/mcp-client'
import { createRoleRegistry } from '@i-harness/subagent'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createOwnedPluginCatalog } from '../src/owned-plugin-catalog.ts'
import { createSessionService } from '../src/service.ts'
import { controlledModel } from './controlled-model.ts'

const direct = vi.hoisted(() => ({ connect: undefined as McpMountDeps['connect'] }))
vi.mock('@i-harness/mcp-client', async load => {
  const actual = await load<typeof import('@i-harness/mcp-client')>()
  return { ...actual, mountMcpClient(...[ctx, tools, config, deps]: Parameters<typeof actual.mountMcpClient>) {
    return actual.mountMcpClient(ctx, tools, config, config.serverName === 'direct-fixture' ? { ...deps, connect: direct.connect } : deps)
  } }
})

it.each(['managed plugin', 'compatibility direct'] as const)('retries the original unpublished MCP owner from service close (%s)', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-mcp-cleanup-owner-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } }, taskDocumentStorageContract)
  const startup = new Error('Original MCP catalogue refused'), refusal = new Error('Original MCP transport close refused')
  let connects = 0, attempts = 0, allowClose = false, publishedResult: boolean | undefined, sends = 0
  const connect = async (): Promise<ConnectedMcpClient> => {
    connects++
    return {
      async listTools() { throw startup },
      async callTool() { return { content: [] } }, async listResources() { return [] }, async readResource() { return {} },
      async close() { attempts++; if (!allowClose) throw refusal },
    }
  }
  const config: McpServerConfig = { serverName: mode === 'managed plugin' ? 'plugin-fixture' : 'direct-fixture', transport: 'stdio', command: 'fixture-only', args: [], failOnStartupError: false }
  direct.connect = connect
  const service = createSessionService({ workspace: root, coordinator, model: controlledModel(async function* () { sends++; yield { type: 'end' } }), contextWindow: 4096, maxOutputTokens: 128,
    ...(mode === 'managed plugin' ? { managedRuntime: { systemPrompt: 'system', tools: [], async mountRegistry(original) {
      const catalog = createOwnedPluginCatalog({ ctx: original.ctx, tools: original.tools, roles: createRoleRegistry(), workspace: root, globalSkillDir: root, report() {}, mcpDeps: { connect } })
      original.retain(() => catalog.close())
      await catalog.capabilities.update({ pluginMcp: [config] }, false)
      publishedResult = catalog.mcpResults.get(config.serverName)
    } } } : { mcp: [config] }),
  })
  try {
    await coordinator.create({ sessionId: 'main' })
    if (mode === 'managed plugin') {
      await service.submit('main', 'follow up normally', new AbortController().signal)
      expect(publishedResult).toBe(false)
      expect(sends).toBe(1)
    } else {
      await expect(service.assemblyFor('main')).rejects.toThrow('Assembly construction and cleanup failed')
      expect(sends).toBe(0)
    }
    expect(connects).toBe(1)
    const beforeClose = attempts
    await expect(service.closeSession('main')).rejects.toThrow(/Original MCP transport close refused|Assembly process cleanup incomplete/)
    expect(attempts).toBe(beforeClose + 1)
    await expect(service.submit('main', 'must await original cleanup', new AbortController().signal)).rejects.toThrow(mode === 'managed plugin' ? /cleanup incomplete/ : 'FACT_CLOSED')
    expect(connects).toBe(1)
    allowClose = true
    await service.close()
    expect(attempts).toBe(beforeClose + 2)
    expect(connects).toBe(1)
  } finally {
    direct.connect = undefined
    allowClose = true
    try { await service.close() } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
  }
}, 30_000)

it.each(['managed plugin', 'compatibility direct'] as const)('stops a turn waiting on an MCP catalogue page (%s)', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-mcp-step-abort-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } }, taskDocumentStorageContract)
  const held = Promise.withResolvers<{ tools: { name: string }[] }>()
  let announce: (() => void) | undefined, wire: AbortSignal | undefined, lists = 0, sends = 0
  const connect: NonNullable<McpMountDeps['connect']> = async (_config, options) => {
    announce = options?.onToolsChanged
    return {
      async listTools(_, opts) {
        if (++lists === 2) {
          wire = opts?.signal
          wire?.addEventListener('abort', () => held.reject(wire?.reason), { once: true })
          return held.promise
        }
        return { tools: [{ name: lists === 1 ? 'before' : 'after' }] }
      },
      async callTool() { return { content: [] } }, async listResources() { return [] }, async readResource() { return {} }, async close() {},
    }
  }
  const serverConfig: McpServerConfig = { serverName: mode === 'managed plugin' ? 'plugin-fixture' : 'direct-fixture', transport: 'stdio', command: 'fixture-only', args: [], catalogTimeoutMs: 30_000 }
  direct.connect = connect
  const reports: string[] = []
  const service = createSessionService({ workspace: root, coordinator, model: controlledModel(async function* () { sends++; yield { type: 'end' } }), contextWindow: 32_000, maxOutputTokens: 128,
    ...(mode === 'managed plugin' ? { managedRuntime: { systemPrompt: 'system', tools: [], async mountRegistry(original) {
      const catalog = createOwnedPluginCatalog({ ctx: original.ctx, tools: original.tools, roles: createRoleRegistry(), workspace: root, globalSkillDir: root, report: message => reports.push(message), mcpDeps: { connect } })
      original.retain(() => catalog.close())
      await catalog.capabilities.update({ pluginMcp: [serverConfig] })
    } } } : { mcp: [serverConfig] }),
  })
  try {
    await coordinator.create({ sessionId: 'main' })
    const signal = new AbortController().signal
    await service.submit('main', 'first turn warms the MCP owner', signal)
    announce!()
    let settled = false
    void service.submit('main', 'stop this while listing tools', signal).then(() => { settled = true }, () => { settled = true })
    await vi.waitFor(() => expect(lists).toBe(2))
    expect(service.cancelRunning!('main')).toEqual({ cancelled: true })
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_500 })
    expect(wire?.aborted).toBe(true)
    expect(sends).toBe(1)
    expect(reports).toEqual([])
    await service.submit('main', 'fresh turn retries the cancelled catalogue', signal)
    expect(lists).toBe(3)
    expect(sends).toBe(2)
  } finally {
    direct.connect = undefined
    held.resolve({ tools: [] })
    try { await service.close() } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
  }
}, 30_000)
