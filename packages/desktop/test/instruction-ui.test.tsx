// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InstructionSettings } from '../src/renderer/settings/InstructionSettings.tsx'
import { InstructionsPane } from '../src/renderer/session/InstructionsPane.tsx'
import { createHostFixtureModel } from '../../desktop-gateway/test/host-fixture-model.ts'
import { useLocale } from '../src/renderer/design/i18n.ts'
const originalLocale = useLocale.getState().locale
beforeEach(() => useLocale.setState({ locale: 'en' }))
afterEach(() => { cleanup(); useLocale.setState({ locale: originalLocale }) })
it('keeps the dirty settings draft when the original save rejects', async () => {
  const request = vi.fn(async (input: { kind: string }) => { if (input.kind === 'desktop/instructions/settings') return { saved: { enabled: true, maxBytes: 24000 } }; throw new Error('saved write failed') })
  render(<InstructionSettings workspaceId="w" bridge={{ request: request as never, onEvent: () => () => {} }} />)
  fireEvent.change(await screen.findByRole('spinbutton', { name: 'Maximum bytes' }), { target: { value: '12' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect((await screen.findByRole('alert')).textContent).toContain('saved write failed')
  expect((screen.getByRole('spinbutton', { name: 'Maximum bytes' }) as HTMLInputElement).value).toBe('12')
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
})
it('renders published metadata and removes it on the matching revocation', async () => {
  let listener: ((event: any) => void) | undefined
  const request = vi.fn(async (input: { kind: string }) => input.kind === 'desktop/instructions/subscribe' ? { subscriptionId: 's', scope: { sessionId: 'p' }, cursor: { epoch: 'e', revision: 1 }, report: { state: 'ready', publication: { fingerprint: 'fp', bytes: 4, sources: [{ path: '/rules/AGENTS.md', kind: 'AGENTS.md', state: 'loaded', bytes: 4 }] } } } : {})
  render(<InstructionsPane workspaceId="w" sessionId="p" bridge={{ request: request as never, onEvent: callback => { listener = callback; return () => { listener = undefined } } }} />)
  expect(await screen.findByText('/rules/AGENTS.md')).toBeTruthy()
  listener!({ kind: 'sdk/notification', workspaceId: 'w', method: 'desktop/instructions/changed', params: { subscriptionId: 's', scope: { sessionId: 'p' }, cursor: { epoch: 'e', revision: 2 }, reason: 'revoked' } })
  await waitFor(() => expect(screen.queryByText('/rules/AGENTS.md')).toBeNull())
  expect(screen.getByRole('status').textContent).toContain('revoked')
})
it('clears a disconnected scope and resubscribes on a later connection notification', async () => {
  let listener: ((event: any) => void) | undefined, subscriptions = 0
  const request = vi.fn(async (input: { kind: string }) => input.kind === 'desktop/instructions/subscribe' ? { subscriptionId: `s${++subscriptions}`, scope: { sessionId: 'p' }, cursor: { epoch: `e${subscriptions}`, revision: 1 }, report: { state: 'not-published' } } : {})
  render(<InstructionsPane workspaceId="w" sessionId="p" bridge={{ request: request as never, onEvent: callback => { listener = callback; return () => { listener = undefined } } }} />)
  await screen.findByText('No source metadata has been published for this session.')
  listener!({ kind: 'sdk/disconnected', workspaceId: 'w', message: 'closed' })
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('unavailable'))
  listener!({ kind: 'sdk/notification', workspaceId: 'w', method: 'session/status', params: {} })
  await waitFor(() => expect(subscriptions).toBe(2))
  expect(request.mock.calls.filter(([input]) => input.kind === 'desktop/instructions/unsubscribe')).toHaveLength(0)
})

it('renders metadata from an actual live gateway RPC and refreshes without another provider request', async () => {
  const { transferableAbortController } = await import('node:util'), nativeController = transferableAbortController()
  const previousController = globalThis.AbortController, previousSignal = globalThis.AbortSignal
  globalThis.AbortController = nativeController.constructor as typeof AbortController; globalThis.AbortSignal = nativeController.signal.constructor as typeof AbortSignal
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const { createDesktopHost } = await import('../../desktop-gateway/src/host.ts'), { createLoopbackProvider } = await import('../../core-agent/test/helpers/provider-loopback.ts')
  const root = await mkdtemp(join(tmpdir(), 'ih-i6-ui-host-')), workspace = join(root, 'workspace'); await mkdir(workspace); await writeFile(join(workspace, 'AGENTS.md'), 'LIVE_UI_RULE')
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: `${server.baseUrl}/v1`, apiKeyEnv: 'IH_I6_UI_KEY', models: [{ id: 'fixture', contextWindow: 272000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } })); await writeFile(credentialsPath, JSON.stringify({ refs: { IH_I6_UI_KEY: 'fixture' } }))
  const frames: any[] = [], listeners = new Set<(event: any) => void>(), host = await createDesktopHost({ workspace, sessionDir: join(root, 'sessions'), settingsPath, credentialsPath, buildProviderClient: createHostFixtureModel(server.baseUrl), onWrite: frame => { frames.push(frame); if ('method' in frame) for (const listener of listeners) listener({ kind: 'sdk/notification', workspaceId: 'w', method: frame.method, params: frame.params }) } })
  let nextId = 0
  const refreshed = Promise.withResolvers<void>()
  const rpc = async (method: string, params: unknown = {}) => { const id = ++nextId; await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params })); const frame = frames.find(value => value.id === id); if (frame?.error) throw new Error(JSON.stringify(frame.error)); return frame?.result }
  const bridge = { request: async (input: any) => { const { kind, workspaceId: _, ...params } = input; const result = await rpc(kind, params); if (kind === 'desktop/instructions/refresh') refreshed.resolve(); return result }, onEvent: (listener: (event: any) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  try {
    await rpc('initialize'); const { sessionId } = await rpc('session/create'); await rpc('session/prompt', { sessionId, prompt: 'hello' })
    const rendered = render(<InstructionsPane workspaceId="w" sessionId={sessionId} bridge={bridge} />)
    expect(await screen.findByText(join(workspace, 'AGENTS.md'))).toBeTruthy(); expect(screen.queryByText('LIVE_UI_RULE')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await refreshed.promise; expect(server.requests).toHaveLength(1)
    rendered.unmount(); await waitFor(() => expect(listeners.size).toBe(0)); expect(server.errors).toEqual([])
  } finally { cleanup(); await host.close(); await server.close(); globalThis.AbortController = previousController; globalThis.AbortSignal = previousSignal; await rm(root, { recursive: true, force: true }) }
}, 20000)

it('mounts instruction observation only while its workbench pane is visible', async () => {
  const { Workbench } = await import('../src/renderer/shell/Workbench.tsx'), { useUiStore } = await import('../src/renderer/shell/ui-store.ts')
  const request = vi.fn(async (input: { kind: string }) => input.kind === 'desktop/instructions/subscribe' ? { subscriptionId: 's', scope: { sessionId: 'p' }, cursor: { epoch: 'e', revision: 1 }, report: { state: 'not-published' } } : {})
  useUiStore.setState({ reviewOpen: false, surface: 'conversation' })
  try {
    const view = render(<Workbench projects={[]} bridge={{ request: request as never, onEvent: () => () => {} }} workspaces={[{ id: 'w', path: 'D:/workspace', label: 'workspace' }]} selectedWorkspaceId="w" selectedSessionId="p" capabilities={{ 'desktop-instructions': ['1'] }} onSelectWorkspace={() => {}} onSelectSession={() => {}} conversation={{ rows: [], canSend: false, running: false, pending: [], onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />)
    expect(request.mock.calls.some(([input]) => input.kind === 'desktop/instructions/subscribe')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /workbench tools/i })); fireEvent.click(screen.getByRole('button', { name: 'Instructions' }))
    await screen.findByText('No source metadata has been published for this session.')
    view.unmount(); await waitFor(() => expect(request.mock.calls.some(([input]) => input.kind === 'desktop/instructions/unsubscribe')).toBe(true))
  } finally { useUiStore.setState({ reviewOpen: false, surface: 'conversation', sidebarCollapsed: false }) }
}, 15000)

it('mounts instruction settings in the existing execution settings section', async () => {
  const { SettingsPane } = await import('../src/renderer/settings/SettingsPane.tsx')
  const request = vi.fn(async (input: { kind: string }) => input.kind === 'desktop/instructions/settings' ? { saved: { enabled: true, maxBytes: 24000 } } : {})
  render(<SettingsPane workspace={{ id: 'w', path: 'D:/workspace', label: 'workspace' }} bridge={{ request: request as never, onEvent: () => () => {} }} capabilities={{ 'desktop-instructions': ['1'] }} onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Execution and permissions' }))
  expect(await screen.findByRole('heading', { name: 'Instruction settings' })).toBeTruthy()
  expect(request).toHaveBeenCalledWith({ kind: 'desktop/instructions/settings', workspaceId: 'w' })
})
