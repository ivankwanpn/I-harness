import { createForkOperationController, createForkCallbackAdapters } from '../../src/renderer/session/fork-operation.ts'
import { ForkOperationError } from '@i-harness/sdk/fork'
import type { DesktopBridge } from '../../src/shared/bridge.ts'

const workspaceId = new URL(location.href).searchParams.get('workspaceId')
if (!workspaceId) throw new Error('Fixture workspace missing')
const bridge = (window as unknown as { ihDesktop: DesktopBridge }).ihDesktop
let selection: object = { workspaceId, sessionId: 'source' }, version = 0
const navigations: { workspaceId: string; sessionId: string }[] = []
const controller = createForkOperationController({ bridge, selection: () => selection, navigationVersion: () => version,
  refresh: async workspaceId => { await bridge.request({ kind: 'session/dashboard', workspaceId }) },
  navigate(workspaceId, sessionId) { version++; selection = { workspaceId, sessionId }; navigations.push({ workspaceId, sessionId }) },
})
const callbacks = createForkCallbackAdapters(controller)
const state = () => {
  const current = controller.state(workspaceId, 'source')
  return { operation: current.operation, outcome: current.outcome, cleanupPending: current.cleanupPending, running: current.running, navigations: [...navigations] }
}
const error = (reason: unknown) => ({ name: reason instanceof Error ? reason.name : typeof reason, message: reason instanceof Error ? reason.message : String(reason),
  ...(reason instanceof ForkOperationError ? { kind: reason.kind, causeMessage: reason.cause instanceof Error ? reason.cause.message : undefined } : {}) })
const run = async (entry: 'sidebar' | 'conversation', action: 'fork' | 'fork-fresh' = 'fork') => {
  try {
    const outcome = await (entry === 'sidebar' ? callbacks.inWorkspace(workspaceId, 'source', action) : callbacks.inSelection(workspaceId, 'source', action))
    return { ok: true, outcome, state: state() }
  } catch (reason) { return { ok: false, error: error(reason), state: state() } }
}
const api = {
  state, run,
  async joined() {
    const results = await Promise.all([run('sidebar'), run('conversation')])
    return { results, state: state() }
  },
  async refresh() { await controller.refresh(workspaceId); return state() },
  aba() { version++; selection = { workspaceId, sessionId: 'other' }; version++; selection = { workspaceId, sessionId: 'source' }; return state() },
}
Object.assign(window, { forkHarness: Object.freeze(api) })
document.body.textContent = 'Production fork controller IPC fixture ready'
