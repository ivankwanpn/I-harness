import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { Transform } from 'node:stream'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { HarnessClient } from '@i-harness/sdk'
import { readForkOutcome, createForkOperation, type ForkOutcome, type ForkOperation } from '@i-harness/sdk/fork'
import { createSessionCoordinator } from '../../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../../session-persistence-jsonl/src/index.ts'
import { createWorkspaceCatalog } from '../../src/main/workspaces.ts'
import { createProjectCatalog } from '../../src/main/projects.ts'
import { createWorkspaceRuntimeManager } from '../../src/main/sdk-runtime.ts'
import { projectRuntimeContexts } from '../../src/main/project-runtime.ts'
import { registerDesktopIpc } from '../../src/main/ipc.ts'

const config = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as { root: string; repoRoot: string; preload: string; renderer: string; output: string }
// The synchronous Electron bootstrap isolates user-data before app readiness.
assert.equal(app.getPath('userData'), join(config.root, 'user-data'))
app.on('window-all-closed', () => {})
let window: BrowserWindow | undefined, manager: ReturnType<typeof createWorkspaceRuntimeManager> | undefined, removeIpc: (() => void) | undefined
let fault: 'drop' | 'hold' | 'cleanup' | 'mismatch' | 'malformed' | undefined, refreshFailures = 1
let hold: { line: string; push(line: string): void } | undefined
let held = Promise.withResolvers<void>(), dropped = Promise.withResolvers<void>()
const wire: { method: string; operation?: ForkOperation }[] = [], successes: ForkOutcome[] = [], stages: unknown[] = []
const children: { pid?: number; code?: number | null; signal?: string | null; stderr: string; exited: Promise<void> }[] = []
let result: Record<string, unknown> = { ok: false }
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Actual IPC boundary pending: ' + label)), milliseconds) })]) }
  finally { clearTimeout(timer!) }
}
try { await bounded((async () => {
  assert.equal(process.type, 'browser')
  await app.whenReady()
  const workspacePath = join(config.root, 'workspace'); await mkdir(workspacePath, { recursive: true })
  const catalog = createWorkspaceCatalog(join(config.root, 'workspaces.json')), workspace = await catalog.open(workspacePath)
  const projects = createProjectCatalog(join(config.root, 'projects.json'), catalog)
  const project = await projects.save({ name: 'IPC Project', workspaceIds: [workspace.id], primaryWorkspaceId: workspace.id })
  const sessionsRoot = join(config.root, 'sessions'), sessionDir = join(sessionsRoot, workspace.id)
  const source = createSessionCoordinator(createJsonlBackend(sessionDir), { lock: { enabled: true } })
  await source.create({ sessionId: 'source', title: 'IPC source' }); await source.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'IPC conversation' }, { type: 'turn/end' }]); await source.close()
  const originalSourceBytes = await readFile(join(sessionDir, 'source.jsonl'))
  manager = createWorkspaceRuntimeManager({ sessionsRoot, projectContexts: () => projectRuntimeContexts(projects, catalog), launch(entry, directory) {
    const child = spawn(process.execPath, ['--import', pathToFileURL(join(config.repoRoot, 'node_modules/tsx/dist/loader.mjs')).href,
      join(config.repoRoot, 'packages/desktop-gateway/src/cli.ts'), '--session-dir', directory], {
      cwd: entry.path, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'pipe',
    })
    const record: (typeof children)[number] = { pid: child.pid, stderr: '', exited: new Promise<void>(resolve => { child.once('exit', (code, signal) => { Object.assign(record, { code, signal }); resolve() }); child.once('error', error => { record.stderr += String(error); resolve() }) }) }
    children.push(record); child.stderr.on('data', chunk => { record.stderr += String(chunk) })
    let buffer = ''
    const output = new Transform({ transform(chunk, _encoding, callback) {
      buffer += String(chunk)
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        let frame: any
        try { frame = JSON.parse(line) } catch { this.push(line + '\n'); continue }
        if (frame.result?.operation && ['ready', 'adopted'].includes(frame.result.kind)) {
          const outcome = readForkOutcome(frame.result, frame.result.operation); successes.push(outcome)
          const mode = fault; fault = undefined
          if (mode === 'drop') { dropped.resolve(); continue }
          if (mode === 'hold') { hold = { line: line + '\n', push: value => this.push(value) }; held.resolve(); continue }
          if (mode === 'cleanup' || mode === 'mismatch' || mode === 'malformed') {
            const operation = mode === 'mismatch' ? createForkOperation(outcome.operation.prepared, { operationId: outcome.operation.invocation.operationId, createdAt: outcome.operation.invocation.createdAt, targetSessionId: 'wrong-target' }) : outcome.operation
            const lastOutcome = mode === 'mismatch' ? { ...outcome, operation, sessionId: operation.invocation.targetSessionId, receipt: { ...(outcome as any).receipt, invocation: operation.invocation } } : outcome
            frame = { jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: 'Session fork unavailable', data: { version: 1, kind: 'session-fork-error', operation, capture: 'captured', reason: 'cleanup-incomplete', lastOutcome,
              ...(mode === 'malformed' ? { privatePayload: 'PRIVATE-DO-NOT-CROSS' } : {}) } } }
          }
        }
        this.push(JSON.stringify(frame) + '\n')
      }
      callback()
    } })
    child.stdout.pipe(output)
    const client = new HarnessClient(output, child.stdin, { child }), request = client.request.bind(client), dashboard = client.dashboard.bind(client)
    client.request = (method, params, timeoutMs) => { wire.push({ method, ...(method.startsWith('session/fork/') && params && typeof params === 'object' && 'operation' in params ? { operation: (params as { operation: ForkOperation }).operation } : {}) }); return request(method, params, method === 'session/fork/begin' && fault === 'drop' ? 250 : timeoutMs) }
    client.dashboard = async () => { if (refreshFailures) { refreshFailures--; throw new Error('Fixture dashboard refresh failed') } return dashboard() }
    return { client, exited: record.exited }
  } })
  const runtime = await bounded(manager.get(workspace), 'first actual Gateway start', 30000)
  assert.deepEqual(runtime.info.capabilities['session-fork-bootstrap'], ['1'])
  await runtime.client.request('desktop/session/project/bind', { sessionId: 'source', projectId: project.id })
  window = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { preload: config.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const consoleMessages: string[] = []
  window.webContents.on('console-message', (_event, _level, message) => { consoleMessages.push(message) })
  removeIpc = registerDesktopIpc(window, { catalog, projects, runtimes: manager }, ipcMain)
  await window.loadFile(config.renderer, { query: { workspaceId: workspace.id } })
  const evaluate = (expression: string): Promise<any> => window!.webContents.executeJavaScript(expression)
  for (let i = 0; !await evaluate('!!window.forkHarness'); i++) { if (i > 100) throw new Error('Production renderer fixture did not initialize: ' + consoleMessages.join('\n')); await new Promise(resolve => setTimeout(resolve, 20)) }
  const targets = async () => {
    const backend = createJsonlBackend(sessionDir), rows: { id: string; operationId?: string; archived?: boolean }[] = []
    for (const id of await backend.list()) { const { meta } = await backend.profile(id); if (meta.origin === 'fork') rows.push({ id, operationId: meta.semanticSeed?.operationId, archived: meta.archived }) }
    return rows
  }
  fault = 'drop'; const lost = await evaluate('window.forkHarness.joined()')
  assert.equal(lost.results.length, 2); assert(lost.results.every((value: any) => !value.ok && value.error.kind === 'transport'))
  await bounded(dropped.promise, 'actual post-READY dropped reply')
  const original = lost.state.operation as ForkOperation
  assert(original); assert.equal(lost.state.navigations.length, 0); assert.equal((await targets()).length, 1)
  assert.equal(wire.filter(row => row.method === 'session/fork/prepare').length, 1); assert.equal(wire.filter(row => row.method === 'session/fork/begin').length, 1)
  assert.deepEqual(await readFile(join(sessionDir, 'source.jsonl')), originalSourceBytes)
  stages.push({ phase: 'actual joined callbacks, READY response dropped', lost, targets: await targets() })
  const refreshFailed = await evaluate('window.forkHarness.run("conversation")')
  assert.equal(refreshFailed.ok, false); assert.equal(refreshFailed.state.outcome.kind, 'adopted'); assert.equal(refreshFailed.state.navigations.length, 0)
  const beforeRefresh = wire.filter(row => row.method.startsWith('session/fork/')).length
  await evaluate('window.forkHarness.refresh()'); assert.equal(wire.filter(row => row.method.startsWith('session/fork/')).length, beforeRefresh)
  stages.push({ phase: 'current success saved before real IPC refresh rejection; pure refresh', refreshFailed })
  await runtime.client.request('desktop/session/manage', { sessionId: 'source', action: 'archive' })
  assert(manager.invalidate, 'Actual runtime manager must support invalidation')
  await manager.invalidate(workspace.id); await children[0]!.exited
  assert.equal(children[0]!.code, 0)
  held = Promise.withResolvers<void>(); fault = 'hold'
  const pending = evaluate('window.forkHarness.run("sidebar")'); await bounded(Promise.race([held.promise, pending.then(value => { throw new Error('Actual reply was not held: ' + JSON.stringify(value)) })]), 'current qualification reply')
  await evaluate('window.forkHarness.aba()'); hold!.push(hold!.line); hold = undefined
  const stale = await pending; assert.equal(stale.ok, true); assert.equal(stale.state.navigations.length, 0); assert.deepEqual(stale.state.operation, original)
  const recovered = await evaluate('window.forkHarness.run("conversation")')
  assert.equal(recovered.ok, true); assert.equal(recovered.outcome.kind, 'adopted'); assert.deepEqual(recovered.state.operation, original); assert.equal(recovered.state.navigations.length, 1); assert.equal(children.length, 2)
  assert.equal((await targets()).length, 1)
  stages.push({ phase: 'new actual Gateway process, archived source, ABA guard then passive qualification', stale, recovered })
  const current = await manager.get(workspace)
  await current.client.request('desktop/session/manage', { sessionId: 'source', action: 'restore' })
  const fresh = await evaluate('window.forkHarness.run("sidebar","fork-fresh")')
  assert.equal(fresh.ok, true); assert.notEqual(fresh.state.operation.invocation.targetSessionId, original.invocation.targetSessionId); assert.equal((await targets()).length, 2)
  const freshOperation = fresh.state.operation as ForkOperation, navigations = fresh.state.navigations.length
  fault = 'cleanup'; const cleanup = await evaluate('window.forkHarness.run("conversation")')
  assert.equal(cleanup.error.kind, 'cleanup'); assert.equal(cleanup.state.cleanupPending, true); assert.equal(cleanup.state.outcome.kind, 'adopted'); assert.equal(cleanup.state.navigations.length, navigations)
  const beforeFresh = wire.length, deniedFresh = await evaluate('window.forkHarness.run("sidebar","fork-fresh")')
  assert.equal(deniedFresh.ok, false); assert.equal(wire.length, beforeFresh); assert.deepEqual(deniedFresh.state.operation, freshOperation)
  fault = 'mismatch'; const mismatch = await evaluate('window.forkHarness.run("sidebar")')
  assert.equal(mismatch.ok, false); assert.equal(mismatch.state.cleanupPending, true); assert.deepEqual(mismatch.state.operation, freshOperation)
  fault = 'malformed'; const malformed = await evaluate('window.forkHarness.run("conversation")')
  assert.equal(malformed.ok, false); assert.equal(malformed.state.cleanupPending, true); assert(!JSON.stringify(malformed).includes('PRIVATE-DO-NOT-CROSS'))
  const cleanupRecovered = await evaluate('window.forkHarness.run("sidebar")')
  assert.equal(cleanupRecovered.ok, true); assert.equal(cleanupRecovered.state.cleanupPending, false); assert.deepEqual(cleanupRecovered.state.operation, freshOperation)
  await current.client.request('desktop/session/manage', { sessionId: freshOperation.invocation.targetSessionId, action: 'archive' })
  const deniedTarget = await evaluate('window.forkHarness.run("conversation")')
  assert.equal(deniedTarget.error.kind, 'outcome'); assert.equal(deniedTarget.state.outcome.reason, 'target-policy'); assert.equal(deniedTarget.state.navigations.length, cleanupRecovered.state.navigations.length)
  assert.equal((await targets()).length, 2)
  stages.push({ phase: 'explicit fresh; existing safe error DTO over actual invoke; malformed/mismatch; current target denial', fresh, cleanup, deniedFresh, mismatch, malformed, cleanupRecovered, deniedTarget })
  result = { ok: true, root: config.root, electron: process.versions.electron, node: process.versions.node, sandboxed: true, contextIsolation: true, preload: config.preload, workspace, project, sourceSessionDir: sessionDir, wire, successes, stages, targets: await targets(), consoleMessages }
})(), 'whole controlled scenario', 60000)
} catch (error) { result = { ...result, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error), stages, wire, successes } }
finally {
  try { await manager?.close(); await Promise.all(children.map(child => child.exited)) } catch (error) { result = { ...result, ok: false, cleanupError: String(error) } }
  removeIpc?.()
  for (let index = 0; index < children.length; index++) await writeFile(join(config.root, `gateway-${index + 1}.stderr.log`), children[index]!.stderr)
  Object.assign(result, { children: children.map(({ exited: _exited, stderr: _stderr, ...data }) => data) })
  await writeFile(config.output, JSON.stringify(result, null, 2))
  window?.destroy()
  app.exit(result.ok ? 0 : 1)
}
