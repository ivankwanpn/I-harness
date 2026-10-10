// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { createCodeRetrievalService } from '../../code-retrieval/src/index.ts'
import { createContextSubsystemSettings, type ContextSubsystemRequest, type ContextSubsystemState } from '../../desktop-gateway/src/context-subsystems.ts'
import { normalizeContextSubsystems } from '../../settings/src/context-subsystems.ts'
import { ContextSubsystemSettings } from '../src/renderer/settings/ContextSubsystemSettings.tsx'

const fixtureBase = resolve('build/plan/context-toggle-ui-fixtures')
const roots: string[] = []
const close: (() => Promise<void>)[] = []
afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  for (const stop of close.splice(0)) await stop()
  for (const root of roots.splice(0)) {
    const owned = relative(fixtureBase, root)
    if (!owned || owned.startsWith('..') || isAbsolute(owned)) throw new Error('Toggle fixture cleanup escaped its repository-owned directory')
    await rm(root, { recursive: true, force: true })
  }
})

function initial(actor = 'durable-context-actor'): ContextSubsystemState {
  const { workspaceOverrides: _, ...saved } = normalizeContextSubsystems(undefined)
  return {
    workspaceId: actor, workspaceKey: `${actor}-key`, source: 'global', saved, global: structuredClone(saved),
    context: { enabled: false, state: 'disabled', config: structuredClone(saved.contextOutput), retainedBytes: 0, results: 0, activeJobs: 0 },
    code: { enabled: false, state: 'disabled', config: structuredClone(saved.codeRetrieval), generation: 0, files: 0, chunks: 0, storedBytes: 0, activeJobs: 0, partial: false, reasons: [] },
  }
}
function host(seed = initial()) {
  let state = seed
  let fail = false
  const requests: ContextSubsystemRequest[] = []
  const request = async (req: ContextSubsystemRequest) => {
    requests.push(structuredClone(req))
    if (req.kind === 'desktop/context-subsystems/configure') {
      if (fail) throw new Error('Cannot apply context setting')
      const contextOutput = { ...state.saved.contextOutput, ...req.patch.contextOutput }
      const codeRetrieval = { ...state.saved.codeRetrieval, ...req.patch.codeRetrieval }
      state = { ...state, source: 'workspace', saved: { ...state.saved, contextOutput, codeRetrieval },
        context: { ...state.context, config: contextOutput, enabled: contextOutput.enabled, state: contextOutput.enabled ? 'ready' : 'disabled' },
        code: { ...state.code, config: codeRetrieval, enabled: codeRetrieval.enabled, state: codeRetrieval.enabled ? 'unindexed' : 'disabled' },
      }
    }
    return structuredClone(state)
  }
  return { request, requests, get state() { return state }, setFail(value: boolean) { fail = value } }
}

it('renders only the two on/off controls with their source aliases', async () => {
  const fixture = host()
  render(<ContextSubsystemSettings bridge={fixture} workspaceId="catalog-id" />)
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '啟用 Context Mode' }) as HTMLInputElement).disabled).toBe(false))
  expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  expect(screen.getByText('Context Mode')).toBeTruthy()
  expect(screen.getByText('Code Context')).toBeTruthy()
  expect(screen.getByText(/設計參考 context-mode/)).toBeTruthy()
  expect(screen.getByText(/設計參考 claude-context/)).toBeTruthy()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('heading')).toBeNull()
})

it('persists each toggle immediately with only the selected workspace enabled field', async () => {
  const seed = initial()
  seed.saved.references = [{ id: 'manual', label: 'Manual', path: 'D:/owned/reference' }]
  seed.saved.codeRetrieval = { ...seed.saved.codeRetrieval, mode: 'hybrid', embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: 'local-model', dimensions: 384, credentialRef: 'EMBEDDING_KEY' }, ignorePatterns: ['node_modules/**'] }
  const fixture = host(seed)
  render(<ContextSubsystemSettings bridge={fixture} workspaceId="catalog-id" />)
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '啟用 Context Mode' }) as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('checkbox', { name: '啟用 Context Mode' }))
  await screen.findByText('設定已儲存')
  fireEvent.click(screen.getByRole('checkbox', { name: '啟用 Code Context' }))
  await waitFor(() => expect(fixture.state.code.enabled).toBe(true))
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '啟用 Code Context' }) as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('checkbox', { name: '啟用 Context Mode' }))
  await waitFor(() => expect(fixture.state.context.enabled).toBe(false))
  expect(fixture.requests.filter(req => req.kind === 'desktop/context-subsystems/configure')).toEqual([
    { kind: 'desktop/context-subsystems/configure', workspaceId: 'catalog-id', patch: { scope: 'workspace', contextOutput: { enabled: true } } },
    { kind: 'desktop/context-subsystems/configure', workspaceId: 'catalog-id', patch: { scope: 'workspace', codeRetrieval: { enabled: true } } },
    { kind: 'desktop/context-subsystems/configure', workspaceId: 'catalog-id', patch: { scope: 'workspace', contextOutput: { enabled: false } } },
  ])
  expect(fixture.state.saved.references).toEqual([{ id: 'manual', label: 'Manual', path: 'D:/owned/reference' }])
  expect(fixture.state.saved.codeRetrieval).toMatchObject({ mode: 'hybrid', ignorePatterns: ['node_modules/**'], embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: 'local-model', dimensions: 384, credentialRef: 'EMBEDDING_KEY' } })
  expect(fixture.state.global?.codeRetrieval.enabled).toBe(false)
})

it('disables both controls until the initial state arrives', async () => {
  let release!: (value: ContextSubsystemState) => void
  const pending = new Promise<ContextSubsystemState>(resolve => { release = resolve })
  render(<ContextSubsystemSettings bridge={{ request: () => pending }} workspaceId="catalog-id" />)
  expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  expect(screen.getAllByRole('checkbox').every(control => (control as HTMLInputElement).disabled)).toBe(true)
  expect(screen.getByText('正在處理…')).toBeTruthy()
  await act(async () => { release(initial()); await pending })
  expect(screen.getAllByRole('checkbox').every(control => !(control as HTMLInputElement).disabled)).toBe(true)
})

it('shows a read error and retries the state request without changing configuration', async () => {
  let fail = true
  const fixture = host()
  const request = async (req: ContextSubsystemRequest) => {
    if (fail) throw new Error('Context state unavailable')
    return fixture.request(req)
  }
  render(<ContextSubsystemSettings bridge={{ request }} workspaceId="catalog-id" />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Context state unavailable')
  expect(screen.getAllByRole('checkbox').every(control => (control as HTMLInputElement).disabled)).toBe(true)
  fail = false
  fireEvent.click(screen.getByRole('button', { name: '重試' }))
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '啟用 Context Mode' }) as HTMLInputElement).disabled).toBe(false))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(fixture.requests.every(req => req.kind === 'desktop/context-subsystems/state')).toBe(true)
})

it('keeps the failed enabled patch for retry and restores the acknowledged checkbox value', async () => {
  const fixture = host()
  fixture.setFail(true)
  render(<ContextSubsystemSettings bridge={fixture} workspaceId="catalog-id" />)
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '啟用 Code Context' }) as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('checkbox', { name: '啟用 Code Context' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Cannot apply context setting')
  expect((screen.getByRole('checkbox', { name: '啟用 Code Context' }) as HTMLInputElement).checked).toBe(false)
  fixture.setFail(false)
  fireEvent.click(screen.getByRole('button', { name: '重試' }))
  await screen.findByText('設定已儲存')
  expect(screen.queryByRole('alert')).toBeNull()
  expect((screen.getByRole('checkbox', { name: '啟用 Code Context' }) as HTMLInputElement).checked).toBe(true)
  expect(fixture.requests.filter(req => req.kind === 'desktop/context-subsystems/configure').map(req => req.patch)).toEqual([
    { scope: 'workspace', codeRetrieval: { enabled: true } }, { scope: 'workspace', codeRetrieval: { enabled: true } },
  ])
})

it('retries applying the existing global configuration without creating workspace field overrides', async () => {
  let state = initial()
  state.saved.contextOutput.enabled = true
  state.global = structuredClone(state.saved)
  state.context.config = structuredClone(state.saved.contextOutput)
  const requests: ContextSubsystemRequest[] = []
  const request = async (req: ContextSubsystemRequest) => {
    requests.push(req)
    if (req.kind === 'desktop/context-subsystems/configure') {
      state = { ...state, applicationError: undefined, context: { ...state.context, config: structuredClone(state.saved.contextOutput), enabled: true, state: 'ready' } }
    }
    return structuredClone(state)
  }
  render(<ContextSubsystemSettings bridge={{ request }} workspaceId="catalog-id" />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '已儲存設定與有效設定不同，請重新整理或再次儲存以重試。')
  expect((screen.getByRole('checkbox', { name: '啟用 Context Mode' }) as HTMLInputElement).checked).toBe(true)
  expect(screen.queryByText('設定已儲存')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重試' }))
  await screen.findByText('設定已儲存')
  expect(requests.filter(req => req.kind === 'desktop/context-subsystems/configure')).toEqual([{ kind: 'desktop/context-subsystems/configure', workspaceId: 'catalog-id', patch: { scope: 'global' } }])
  expect(state.source).toBe('global')
})

it('does not report success for a returned snapshot whose saved toggle is still not effective', async () => {
  let state = initial()
  const requests: ContextSubsystemRequest[] = []
  const request = async (req: ContextSubsystemRequest) => {
    requests.push(req)
    if (req.kind === 'desktop/context-subsystems/configure' && req.patch.contextOutput) {
      state = { ...state, source: 'workspace', saved: { ...state.saved, contextOutput: { ...state.saved.contextOutput, enabled: true } }, applicationError: 'Cannot apply saved toggle' }
    } else if (req.kind === 'desktop/context-subsystems/configure') {
      state = { ...state, applicationError: undefined, context: { ...state.context, config: structuredClone(state.saved.contextOutput), enabled: true, state: 'ready' } }
    }
    return structuredClone(state)
  }
  render(<ContextSubsystemSettings bridge={{ request }} workspaceId="catalog-id" />)
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '啟用 Context Mode' }) as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('checkbox', { name: '啟用 Context Mode' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Cannot apply saved toggle')
  expect(screen.queryByText('設定已儲存')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重試' }))
  await screen.findByText('設定已儲存')
  expect(requests.filter(req => req.kind === 'desktop/context-subsystems/configure').map(req => req.patch)).toEqual([{ scope: 'workspace', contextOutput: { enabled: true } }, { scope: 'workspace' }])
})

it('keeps a pending toggle owned while hidden and pauses polling after it completes', async () => {
  vi.useFakeTimers()
  const fixture = host()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const request = async (req: ContextSubsystemRequest) => {
    const state = await fixture.request(req)
    if (req.kind === 'desktop/context-subsystems/configure') await pending
    return state
  }
  const view = render(<ContextSubsystemSettings bridge={{ request }} workspaceId="catalog-id" active />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('checkbox', { name: '啟用 Context Mode' }))
  expect(fixture.requests.find(req => req.kind === 'desktop/context-subsystems/configure')).toEqual({ kind: 'desktop/context-subsystems/configure', workspaceId: 'catalog-id', patch: { scope: 'workspace', contextOutput: { enabled: true } } })
  expect(screen.getAllByRole('checkbox').every(control => (control as HTMLInputElement).disabled)).toBe(true)
  expect((screen.getByRole('checkbox', { name: '啟用 Context Mode' }) as HTMLInputElement).checked).toBe(true)
  view.rerender(<ContextSubsystemSettings bridge={{ request }} workspaceId="catalog-id" active={false} />)
  await act(async () => { release(); await pending })
  expect(screen.getByText('設定已儲存')).toBeTruthy()
  expect((screen.getByRole('checkbox', { name: '啟用 Context Mode' }) as HTMLInputElement).checked).toBe(true)
  expect(screen.getAllByRole('checkbox').every(control => !(control as HTMLInputElement).disabled)).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(4500) })
  expect(fixture.requests.filter(req => req.kind === 'desktop/context-subsystems/state')).toHaveLength(1)
  view.rerender(<ContextSubsystemSettings bridge={{ request }} workspaceId="catalog-id" active />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(fixture.requests.filter(req => req.kind === 'desktop/context-subsystems/state')).toHaveLength(2)
})

it('ignores a late state response from the previous catalog scope despite different actor IDs', async () => {
  const first = initial('first-actor')
  first.saved.contextOutput.enabled = true
  const second = initial('second-actor')
  let release!: (value: ContextSubsystemState) => void
  const pending = new Promise<ContextSubsystemState>(resolve => { release = resolve })
  const request = async (req: ContextSubsystemRequest) => req.workspaceId === 'first-catalog' ? pending : structuredClone(second)
  const view = render(<ContextSubsystemSettings bridge={{ request }} workspaceId="first-catalog" />)
  view.rerender(<ContextSubsystemSettings bridge={{ request }} workspaceId="second-catalog" />)
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '啟用 Context Mode' }) as HTMLInputElement).disabled).toBe(false))
  await act(async () => { release(first); await pending })
  expect((screen.getByRole('checkbox', { name: '啟用 Context Mode' }) as HTMLInputElement).checked).toBe(false)
})

it('does not apply a previous workspace mutation or success message to the new workspace', async () => {
  const first = host(initial('first-actor'))
  const second = host(initial('second-actor'))
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const request = async (req: ContextSubsystemRequest) => {
    const next = await (req.workspaceId === 'first-catalog' ? first.request(req) : second.request(req))
    if (req.kind === 'desktop/context-subsystems/configure') await pending
    return next
  }
  const view = render(<ContextSubsystemSettings bridge={{ request }} workspaceId="first-catalog" />)
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '啟用 Context Mode' }) as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('checkbox', { name: '啟用 Context Mode' }))
  expect(first.requests.some(req => req.kind === 'desktop/context-subsystems/configure')).toBe(true)
  view.rerender(<ContextSubsystemSettings bridge={{ request }} workspaceId="second-catalog" />)
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '啟用 Context Mode' }) as HTMLInputElement).disabled).toBe(false))
  await act(async () => { release(); await pending })
  expect((screen.getByRole('checkbox', { name: '啟用 Context Mode' }) as HTMLInputElement).checked).toBe(false)
  expect(screen.queryByText('設定已儲存')).toBeNull()
  expect(second.requests.every(req => req.kind === 'desktop/context-subsystems/state')).toBe(true)
})

it('preserves real gateway metadata and existing overrides when toggling both services through a catalog ID', async () => {
  await mkdir(fixtureBase, { recursive: true })
  const root = await mkdtemp(join(fixtureBase, 'owned-'))
  roots.push(root)
  const settingsPath = join(root, 'settings.json')
  const contextOutput = createContextOutputService({ root, workspaceId: 'native-context-actor' })
  const codeRetrieval = createCodeRetrievalService({ root, workspaceId: 'native-context-actor', reader: { async *snapshots() {}, async revalidate() { return true } } })
  close.push(() => contextOutput.close(), () => codeRetrieval.close())
  const controller = createContextSubsystemSettings({ settingsPath, workspaceId: 'native-context-actor', workspaceKey: 'native-context-key', contextOutput, codeRetrieval })
  await controller.configure({ scope: 'global', contextOutput: { maxDiskBytes: 536870913 }, codeRetrieval: { mode: 'hybrid', embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: 'local-model', dimensions: 384, credentialRef: 'EMBEDDING_KEY' }, ignorePatterns: ['node_modules/**'] }, references: [{ id: 'manual', label: 'Manual', path: root }] })
  await controller.configure({ scope: 'workspace', codeRetrieval: { maxFiles: 500 } })
  const requests: ContextSubsystemRequest[] = []
  const request = (req: ContextSubsystemRequest) => {
    requests.push(req)
    if (req.workspaceId !== 'desktop-catalog-uuid') throw new Error('Actor identity was used as the catalog routing identity')
    return req.kind === 'desktop/context-subsystems/state' ? controller.state() : req.kind === 'desktop/context-subsystems/configure' ? controller.configure(req.patch) : controller.action(req.command)
  }
  render(<ContextSubsystemSettings bridge={{ request }} workspaceId="desktop-catalog-uuid" />)
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '啟用 Context Mode' }) as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('checkbox', { name: '啟用 Context Mode' }))
  await screen.findByText('設定已儲存')
  fireEvent.click(screen.getByRole('checkbox', { name: '啟用 Code Context' }))
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '啟用 Code Context' }) as HTMLInputElement).disabled).toBe(false))
  const state = await controller.state()
  expect(state.workspaceId).toBe('native-context-actor')
  expect(state.context.enabled).toBe(true)
  expect(state.code.enabled).toBe(true)
  expect(state.saved.contextOutput.maxDiskBytes).toBe(536870913)
  expect(state.saved.references).toEqual([{ id: 'manual', label: 'Manual', path: root }])
  expect(state.saved.codeRetrieval).toMatchObject({ mode: 'hybrid', maxFiles: 500, ignorePatterns: ['node_modules/**'], embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: 'local-model', dimensions: 384, credentialRef: 'EMBEDDING_KEY' } })
  const document = JSON.parse(await readFile(settingsPath, 'utf8'))
  expect(document.contextSubsystems.workspaceOverrides['native-context-key']).toEqual({ contextOutput: { enabled: true }, codeRetrieval: { maxFiles: 500, enabled: true } })
  expect(document.contextSubsystems.contextOutput.enabled).toBe(false)
  expect(document.contextSubsystems.codeRetrieval.enabled).toBe(false)
  expect(state.code.metrics?.embeddingRequests).toBe(0)
  expect(requests.filter(req => req.kind === 'desktop/context-subsystems/configure').map(req => req.patch)).toEqual([{ scope: 'workspace', contextOutput: { enabled: true } }, { scope: 'workspace', codeRetrieval: { enabled: true } }])
})
