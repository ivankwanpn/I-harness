import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { PluginContext } from '@i-harness/core-plugin'
import { createContextOutputService } from '@i-harness/context-output'
import { registerApprovalAnswerer } from '@i-harness/interaction'
import type { SandboxMode } from '@i-harness/sandbox'
import type { TerminalService } from '@i-harness/terminal'
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createAssemblyExecutionRuntime } from '../src/execution-runtime.ts'
import { originalManagedRuntimeFor } from '../src/host-managed-execution.ts'
import { createOwnedMetadataFold } from '../src/lifecycle/owned-metadata-fold.ts'
import { createSessionService } from '../src/service.ts'
import { rmWorkspaceSync } from './helpers.ts'

const terminalNames = [
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  'process_spawn', 'process_kill', 'process_resize_pty',
]
const echo = [
  "process.stdin.on('data', d => { process.stdout.write('ECHO:' + d.toString().trim() + String.fromCharCode(10)) })",
  "process.stdout.write('CWD:' + process.cwd() + String.fromCharCode(10))",
  "process.stdout.write('READY' + String.fromCharCode(10))",
].join('\n')
const command = { command: process.execPath, args: ['-e', echo] }

it('runs the original nine Terminal tools after a deferred warm on one managed native owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-owned-terminal-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root, 'sessions')), {
    lock: { enabled: true }, originalExecutionFoldFactory: createOwnedMetadataFold,
  }, taskDocumentStorageContract)
  const contexts = new Map<string, PluginContext>()
  const nativeOwners = new Map<string, ReturnType<typeof createAssemblyExecutionRuntime>>()
  const escalationPrompts: string[] = []
  let mode: SandboxMode = 'danger-full-access', revision = 0
  let pending: { name: string; args: unknown; id: string } | undefined
  const server = await createLoopbackProvider('/v1/chat/completions', Array.from({ length: 16 }, () => async response => {
    const call = pending
    pending = undefined
    const delta = call
      ? { tool_calls: [{ index: 0, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
      : { content: 'finished' }
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  }))
  const service = createSessionService({
    workspace: root, coordinator, contextWindow: 16000, maxOutputTokens: 256,
    model: createOpenAICompatibleClient({ apiKey: 'loopback', model: 'terminal-fixture', baseUrl: server.baseUrl }),
    managedRuntime: {
      systemPrompt: 'fixture', tools: [], originalApproval: true, approvalMode: 'full-access',
      mountRegistry(original) {
        contexts.set(original.domain.sessionId, original.ctx)
        registerApprovalAnswerer(original.ctx, async request => {
          escalationPrompts.push(request.name)
          return { approved: true }
        })
      },
      ownedShell: {
        async acquireExecution(sessionId, retain, attachment) {
          const runtime = createAssemblyExecutionRuntime({
            owner: { sessionId }, managedExecution: attachment,
            authority: () => ({ kind: 'unbound', revision: 'test', workspaceRoot: root }),
            standing: () => ({ mode, generation: String(revision) }),
          })
          nativeOwners.set(sessionId, runtime)
          retain(() => runtime.execution.dispose!())
          return runtime.execution
        },
        acquireOutput(sessionId, retain) {
          const output = createContextOutputService({ root: join(root, 'results'), workspaceId: sessionId, config: { enabled: false } })
          retain(() => output.close())
          return { service: output }
        },
        agentShell: () => ({ id: 'fixture', label: 'fixture', command: 'cmd', dialect: 'cmd' }),
      },
    },
  })
  async function submit(sessionId: string, name?: string, args?: unknown) {
    const index = server.requests.length
    if (name) pending = { name, args, id: 'call-' + index }
    await service.submit(sessionId, name ?? 'only reply', new AbortController().signal)
    const next = server.requests[index + 1]?.body.messages as { role: string; content: string }[] | undefined
    if (name) return JSON.parse(next!.filter(message => message.role === 'tool').at(-1)!.content)
  }

  try {
    await coordinator.create({ sessionId: 'first' })
    await coordinator.create({ sessionId: 'second' })
    expect(await service.warmSession!('first')).toEqual({ ready: false, deferred: true })
    expect(nativeOwners.size).toBe(0)
    const { id, pid } = await submit('first', 'terminal_open', command)
    expect(pid).toBeGreaterThan(0)
    expect(id).toMatch(/^term-[0-9a-f]{8}-[0-9a-f-]{27}$/)
    const listed = (server.requests[0]!.body.tools as { function: { name: string } }[]).map(tool => tool.function.name)
    expect(listed.filter(name => terminalNames.includes(name)).sort()).toEqual([...terminalNames].sort())
    expect(service.hasAssembly('first')).toBe(false)
    const original = originalManagedRuntimeFor(service, 'first')!
    expect(original.terminals()).toMatchObject([{ id, pid, ownerSessionId: 'first', status: 'running' }])
    expect(service.inspectActivity!('first').active).toBe(true)
    await vi.waitFor(() => expect(original.readTerminal(id)?.data).toContain('READY'), { timeout: 15000 })
    expect(original.readTerminal(id)?.data.toLowerCase()).toContain(('CWD:' + root).toLowerCase())
    expect(await submit('first', 'terminal_send', { id, data: 'managed input\r' })).toEqual({ id, sentChars: 14 })
    await vi.waitFor(() => expect(original.readTerminal(id)?.data).toContain('ECHO:managed input'), { timeout: 15000 })
    expect(await submit('first', 'terminal_read', { id })).toMatchObject({ id, data: expect.stringContaining('ECHO:managed input') })

    await submit('second')
    const second = originalManagedRuntimeFor(service, 'second')!
    expect(second.readTerminal(id)).toBeUndefined()
    expect(await second.closeTerminal(id)).toBeUndefined()
    const terminal = contexts.get('first')!.services.get<TerminalService>('terminal/service')
    expect(() => terminal.read(id, { sessionId: 'second' })).toThrow('TERMINAL_OWNER_MISMATCH')
    await expect(async () => terminal.open(command, { sessionId: 'first' })).rejects.toThrow('Original managed Terminal invocation required')
    await expect(original.tools.get('terminal_send')!.execute({ id, data: 'unprepared' }, { sessionId: 'first' }))
      .rejects.toThrow('Original managed Terminal invocation required')
    expect(original.terminals()).toHaveLength(1)

    mode = 'read-only'
    revision++
    expect(await submit('first', 'terminal_send', { id, data: 'refused\r' })).toMatchObject({ denial: { surface: 'terminal' } })
    expect(original.readTerminal(id)?.data).not.toContain('ECHO:refused')
    expect(await submit('first', 'terminal_close', { id })).toMatchObject({ id, settlement: { kind: 'settled', resourcesReleased: true } })
    expect(original.terminals()).toEqual([])
    expect(nativeOwners.get('first')!.execution.supervisor?.list()).toHaveLength(0)

    const approvedCommand = {
      ...command, sandbox_permissions: 'danger-full-access', justification: 'Start the isolated echo fixture',
    }
    const secondPty = await submit('first', 'process_spawn', approvedCommand)
    expect(secondPty.id).not.toBe(id)
    expect(escalationPrompts).toEqual(['process_spawn'])
    expect(mode).toBe('read-only')
    await vi.waitFor(() => expect(original.readTerminal(secondPty.id)?.data).toContain('READY'), { timeout: 15000 })
    expect(nativeOwners.get('first')!.execution.supervisor?.list()).toHaveLength(1)
    expect(server.errors).toEqual([])
    await service.closeSession('first')
    expect(nativeOwners.get('first')!.execution.supervisor?.list()).toHaveLength(0)
    expect(() => original.terminals()).toThrow(/retired/)
    expect(originalManagedRuntimeFor(service, 'first')).toBeUndefined()

    const reopenedPty = await submit('first', 'process_spawn', approvedCommand)
    const reopened = originalManagedRuntimeFor(service, 'first')!
    expect(reopened.domain).not.toBe(original.domain)
    expect(reopenedPty.id).not.toBe(secondPty.id)
    expect(reopened.readTerminal(secondPty.id)).toBeUndefined()
    expect(await reopened.closeTerminal(secondPty.id)).toBeUndefined()
    expect(reopened.terminals()).toMatchObject([{ id: reopenedPty.id, status: 'running' }])
    await service.closeSession('first')
    expect(nativeOwners.get('first')!.execution.supervisor?.list()).toHaveLength(0)
  } finally {
    try { await service.close() }
    finally {
      try { await coordinator.close() }
      finally { await server.close(); rmWorkspaceSync(root) }
    }
  }
}, 60000)
