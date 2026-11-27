import { afterEach, expect, it, vi } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { mountMcpClient, readMcpFailedMountCleanup, type ConnectedMcpClient, type McpServerConfig } from '../src/index.ts'

afterEach(() => vi.useRealTimers())

function fixture(override: Partial<McpServerConfig> = {}) {
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const config: McpServerConfig = { serverName: 'fixture', transport: 'stdio', command: 'unused-fake-only', args: [], ...override } as McpServerConfig
  const mount = (connect: () => Promise<ConnectedMcpClient>) => mountMcpClient(ctx, tools, config, { connect, onStatus() {} })
  return { tools, mount }
}

function generation(closeGate?: Promise<void>) {
  let onDisconnect = () => {}
  const client = {
    listTools: vi.fn(async () => ({ tools: [{ name: 'read', inputSchema: {} }] })),
    async callTool() { return { content: [] } }, async listResources() { return [] }, async readResource() { return {} },
    close: vi.fn(async () => { await closeGate }),
    onDisconnect(callback: () => void) { onDisconnect = callback },
  } satisfies ConnectedMcpClient
  return { client, down: () => onDisconnect() }
}

it('joins concurrent unmount calls while the original generation is closing', async () => {
  vi.useFakeTimers()
  const { mount, tools } = fixture(), gate = Promise.withResolvers<void>()
  const old = generation(gate.promise), handle = await mount(async () => old.client)
  const first = handle.unmount(), second = handle.unmount()
  let completed = false
  void first.then(() => { completed = true })
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(second).toBe(first)
    expect(completed).toBe(false)
    expect(old.client.close).toHaveBeenCalledTimes(1)
    expect(tools.get('mcp__fixture__read')).toBeUndefined()
  } finally { gate.resolve(); await Promise.all([first, second]) }
})

it('retains the name after close times out and releases it on the original late receipt', async () => {
  vi.useFakeTimers()
  const { mount, tools } = fixture(), gate = Promise.withResolvers<void>()
  const old = generation(gate.promise), handle = await mount(async () => old.client)
  const replacement = generation(), connect = vi.fn(async () => replacement.client)
  const closing = expect(handle.unmount()).rejects.toMatchObject({ code: 'MCP_CLEANUP_PENDING' })
  try {
    await vi.advanceTimersByTimeAsync(5001)
    await closing
    await expect(mount(connect)).rejects.toThrow(/serverName.*reserved/)
    expect(connect).not.toHaveBeenCalled()
    expect(old.client.close).toHaveBeenCalledTimes(1)
  } finally { gate.resolve(); await vi.advanceTimersByTimeAsync(0) }

  const next = await mount(connect)
  await handle.unmount()
  expect(tools.get('mcp__fixture__read')).toBeDefined()
  expect(replacement.client.close).not.toHaveBeenCalled()
  await next.unmount()
})

it('owns a reconnect still in flight at teardown and never publishes its late catalogue', async () => {
  vi.useFakeTimers()
  const { mount, tools } = fixture({ reconnect: { enabled: true, initialDelayMs: 5, maxDelayMs: 100, maxRetries: 1 } })
  const lateConnection = Promise.withResolvers<ConnectedMcpClient>(), gate = Promise.withResolvers<void>()
  const initial = generation(), late = generation(gate.promise)
  const connect = vi.fn().mockResolvedValueOnce(initial.client).mockReturnValueOnce(lateConnection.promise)
  const replacementConnect = vi.fn(async () => generation().client)
  const handle = await mount(connect)
  initial.down()
  await vi.advanceTimersByTimeAsync(5)
  expect(connect).toHaveBeenCalledTimes(2)
  const closing = expect(handle.unmount()).rejects.toMatchObject({ code: 'MCP_CLEANUP_PENDING' })
  try {
    await vi.advanceTimersByTimeAsync(5001)
    await closing
    await expect(mount(replacementConnect)).rejects.toThrow(/serverName.*reserved/)
    lateConnection.resolve(late.client)
    await vi.advanceTimersByTimeAsync(0)
    expect(late.client.close).toHaveBeenCalledTimes(1)
    expect(late.client.listTools).not.toHaveBeenCalled()
    expect(tools.get('mcp__fixture__read')).toBeUndefined()
    await expect(mount(replacementConnect)).rejects.toThrow(/serverName.*reserved/)
    expect(replacementConnect).not.toHaveBeenCalled()
  } finally { lateConnection.resolve(late.client); gate.resolve(); await vi.advanceTimersByTimeAsync(0) }
  const next = await mount(replacementConnect)
  await next.unmount()
})

it('can retry the original cleanup after a client rejects close', async () => {
  vi.useFakeTimers()
  const { mount } = fixture(), old = generation()
  const failure = Error('Unproved close')
  old.client.close.mockRejectedValueOnce(failure)
  const handle = await mount(async () => old.client)
  const result = handle.unmount()
  expect(handle.unmount()).toBe(result)
  const closing = expect(result).rejects.toBe(failure)
  await vi.advanceTimersByTimeAsync(0)
  await closing
  expect(old.client.close).toHaveBeenCalledTimes(1)
  const retryGate = Promise.withResolvers<void>()
  old.client.close.mockReturnValueOnce(retryGate.promise)
  const retry = handle.unmount(), replacement = vi.fn(async () => generation().client)
  try {
    await expect(mount(replacement)).rejects.toThrow(/serverName.*reserved/)
    expect(replacement).not.toHaveBeenCalled()
  } finally { retryGate.resolve(); await retry }
  expect(old.client.close).toHaveBeenCalledTimes(2)
  const next = await mount(replacement)
  await next.unmount()
})

it('does not fail-soft on startup when the exact acquired generation is still closing', async () => {
  vi.useFakeTimers()
  const { mount } = fixture({ failOnStartupError: false }), gate = Promise.withResolvers<void>()
  const old = generation(gate.promise), nextConnect = vi.fn(async () => generation().client)
  old.client.listTools.mockRejectedValueOnce(Error('Startup catalogue failed'))
  const starting = expect(mount(async () => old.client)).rejects.toMatchObject({
    cause: expect.objectContaining({ message: 'Startup catalogue failed' }),
    errors: [expect.any(Error), expect.objectContaining({ code: 'MCP_CLEANUP_PENDING' })],
  })
  try {
    await vi.advanceTimersByTimeAsync(10001)
    await starting
    await expect(mount(nextConnect)).rejects.toThrow(/serverName.*reserved/)
    expect(nextConnect).not.toHaveBeenCalled()
    expect(old.client.close).toHaveBeenCalledTimes(1)
  } finally { gate.resolve(); await vi.advanceTimersByTimeAsync(0) }
  const next = await mount(nextConnect)
  await next.unmount()
})

it('exposes only exact failed-startup cleanup and never retries due to a rejected replacement', async () => {
  const { mount } = fixture({ failOnStartupError: false }), old = generation()
  const startup = new Error('Original startup catalogue failed'), refusal = new Error('Original transport refused close')
  old.client.listTools.mockRejectedValueOnce(startup)
  old.client.close.mockRejectedValue(refusal)
  const failure = await mount(async () => old.client).catch((error: unknown) => error)
  expect(failure).toMatchObject({ cause: startup, errors: [startup, refusal] })
  const cleanup = readMcpFailedMountCleanup(failure)
  expect(cleanup).toBeTypeOf('function')
  expect(readMcpFailedMountCleanup(new AggregateError([startup, refusal], 'copy', { cause: startup }))).toBeUndefined()
  const connect = vi.fn(async () => generation().client), originalAttempts = old.client.close.mock.calls.length
  await expect(mount(connect)).rejects.toThrow(/serverName.*reserved/)
  expect(old.client.close).toHaveBeenCalledTimes(originalAttempts)
  expect(connect).not.toHaveBeenCalled()
  await expect(cleanup!()).rejects.toBe(refusal)
  old.client.close.mockResolvedValue(undefined)
  await cleanup!()
  const replacement = await mount(connect)
  await replacement.unmount()
})
