import { expect, it, vi } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountMcpClient } from '../src/index.ts'

it('cancels the original SDK stdio catalogue page and immediately permits a fresh read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-mcp-catalogue-abort-'))
  const script = join(root, 'server.cjs'), entered = join(root, 'request'), cancelled = join(root, 'cancelled'), retired = join(root, 'retired-page-cancelled')
  await writeFile(script, `
    const fs = require('node:fs');
    const send = (message) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...message}) + '\\n');
    let pages = 0, heldId;
    require('node:readline').createInterface({input: process.stdin}).on('line', line => {
      const req = JSON.parse(line);
      if (req.method === 'notifications/cancelled') fs.writeFileSync(req.params.requestId === heldId ? ${JSON.stringify(cancelled)} : ${JSON.stringify(retired)}, 'cancelled');
      if (req.id === undefined) return;
      if (req.method === 'initialize') return send({id:req.id,result:{protocolVersion:req.params.protocolVersion,capabilities:{tools:{listChanged:true}},serverInfo:{name:'abort-fixture',version:'1'}}});
      if (req.method !== 'tools/list') throw Error('Unexpected fixture request');
      if (++pages === 2) return send({id:req.id,result:{tools:[],nextCursor:'held'}});
      if (pages === 3 && req.params.cursor === 'held') { heldId = req.id; send({method:'notifications/tools/list_changed'}); fs.writeFileSync(${JSON.stringify(entered)}, 'held'); return; }
      send({id:req.id,result:{tools:[{name:pages === 1 ? 'before' : 'after', inputSchema:{type:'object'}}]}});
    });
  `)
  const ctx = createContext(), tools = createToolRegistry(ctx), stop = new AbortController()
  const fixture = { serverName: 'fixture', transport: 'stdio' as const, command: process.execPath, args: [script], catalogTimeoutMs: 30_000 }
  let mount: Awaited<ReturnType<typeof mountMcpClient>> | undefined, waiting: Promise<unknown> | undefined
  try {
    mount = await mountMcpClient(ctx, tools, fixture)
    waiting = mount.refreshCatalog(stop.signal).catch(error => error)
    await vi.waitFor(() => expect(existsSync(entered)).toBe(true), { timeout: 2_000 })
    stop.abort()
    await vi.waitFor(() => expect(existsSync(cancelled)).toBe(true), { timeout: 1_500 })
    expect(existsSync(retired)).toBe(false)
    expect(await waiting).toBe(stop.signal.reason)
    expect(mount.catalogDirty()).toBe(true)
    expect(tools.get('mcp__fixture__before')).toBeDefined()
    await mount.refreshCatalog()
    expect(tools.get('mcp__fixture__after')).toBeDefined()
    expect(mount.catalogDirty()).toBe(false)
  } finally {
    try { await mount?.unmount(); await waiting } finally { await rm(root, { recursive: true, force: true }) }
  }
}, 10_000)

it('detaches one cancelled observer without cancelling or duplicating the shared read', async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx), stop = new AbortController()
  const page = Promise.withResolvers<{ tools: { name: string }[] }>()
  let lists = 0, wire: AbortSignal | undefined
  const mount = await mountMcpClient(ctx, tools, { serverName: 'fixture', transport: 'stdio', command: 'unused', args: [] }, {
    async connect() {
      return {
        async listTools(_, opts) {
          if (++lists === 1) return { tools: [{ name: 'before' }] }
          wire = opts?.signal
          return page.promise
        },
        async callTool() { return { content: [] } }, async listResources() { return [] }, async readResource() { return {} }, async close() {},
      }
    },
  })
  let stopped = false
  const first = mount.refreshCatalog(stop.signal).catch(error => { stopped = true; return error })
  const stillWaiting = mount.refreshCatalog()
  try {
    stop.abort()
    await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 1_000 })
    expect(await first).toBe(stop.signal.reason)
    expect(wire?.aborted).toBe(false)
    expect(lists).toBe(2)
    page.resolve({ tools: [{ name: 'after' }] })
    await stillWaiting
    expect(tools.get('mcp__fixture__after')).toBeDefined()
  } finally {
    page.resolve({ tools: [] })
    await Promise.allSettled([first, stillWaiting])
    await mount.unmount()
  }
})
