import { expect, it, vi } from 'vitest'
import { inspect } from 'node:util'
import { createDeliveryFixture } from './helpers/delivery-fixture.ts'
const original = vi.hoisted(() => ({ events: [] as string[], roles: undefined as import('@i-harness/subagent').RoleRegistry | undefined }))
vi.mock('../../subagent/src/index.ts', async load => {
  const actual = await load<typeof import('../../subagent/src/index.ts')>()
  return { ...actual, registerSubagent(...args: Parameters<typeof actual.registerSubagent>) {
    const mounted = actual.registerSubagent(...args)
    if (args[2].persist?.parentSessionId === 'parent') {
      original.roles = mounted.roles
      const dispose = mounted.dispose.bind(mounted)
      mounted.dispose = async () => { original.events.push('children-requested'); await dispose(); original.events.push('children-joined') }
    }
    return mounted
  } }
})
vi.mock('../../mcp-client/src/index.ts', async load => {
  const actual = await load<typeof import('../../mcp-client/src/index.ts')>()
  return { ...actual, async mountMcpClient() {
    return { serverName: 'ordered-mcp', catalogDirty: () => false, refreshCatalog: async () => {}, async unmount() {
      expect(original.events).toContain('children-joined')
      expect(original.roles?.get('probe')).toBeUndefined()
      original.events.push('mcp-closed')
    } }
  } }
})

it('actual active child keeps its captured role while original child join precedes role and MCP cleanup', async () => {
  original.events = []; original.roles = undefined
  const f = await createDeliveryFixture({ extensionsFor: async () => ({ options: { pluginMcp: [{ transport: 'stdio', serverName: 'ordered-mcp', command: 'controlled', args: [] }] } }) })
  try {
    await f.start()
    expect(f.launchCount(), JSON.stringify((await f.backend.read('parent')).events.filter(e => e.type === 'tool/result'))).toBe(1)
    const role = original.roles!.get('probe')!
    expect(role.systemPrompt).toBe('Return the original result')
    const closing = f.service.close(); void closing.catch(() => {})
    await vi.waitFor(() => expect(original.events).toContain('children-requested'), { timeout: 2000 })
    expect(original.events).not.toContain('mcp-closed')
    f.releaseChild(); await closing
    expect(original.events.indexOf('children-joined')).toBeLessThan(original.events.indexOf('mcp-closed'))
    expect(role.systemPrompt).toBe('Return the original result')
    expect(f.launchCount()).toBe(1)
  } catch (cause) {
    console.info('original-active-child-primary', inspect(cause, { depth: 7 }), JSON.stringify({ launches: f.launchCount(), order: original.events, results: (await f.backend.read('parent')).events.filter(event => event.type === 'tool/result') }))
    throw cause
  } finally { f.releaseChild(); await f.close() }
}, 20000)
