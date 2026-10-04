// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ContextSubsystemSettings } from '../src/renderer/settings/ContextSubsystemSettings.tsx'
import { normalizeContextSubsystems } from '../../settings/src/context-subsystems.ts'
import type { ContextSubsystemRequest, ContextSubsystemState } from '@i-harness/desktop-gateway/src/context-subsystems.ts'
import { configuration } from '../../code-retrieval/src/config.ts'
afterEach(cleanup)
function initial(): ContextSubsystemState {
  const saved = normalizeContextSubsystems(undefined)
  return { workspaceId: 'w', workspaceKey: 'host', source: 'global', saved, context: { enabled: false, state: 'disabled', config: saved.contextOutput, retainedBytes: 0, results: 0, activeJobs: 0 }, code: { enabled: false, state: 'disabled', config: saved.codeRetrieval, generation: 0, files: 0, chunks: 0, storedBytes: 0, activeJobs: 0, partial: false, reasons: [], metrics: { embeddingRequests: 2, embeddingCacheHits: 1, reportedInputTokens: 7, unreportedRequests: 1 } } }
}
it('saves independent toggles in visible scope, reloads errors, and displays attribution and separate measured counters', async () => {
  let state = initial(); let fail = false; const requests: ContextSubsystemRequest[] = []
  const request = async (req: ContextSubsystemRequest) => {
    requests.push(req)
    if (req.kind === 'desktop/context-subsystems/configure') {
      if (fail) throw new Error('Cannot apply saved configuration')
      state = { ...state, source: req.patch.scope, saved: { ...state.saved, contextOutput: { ...state.saved.contextOutput, ...req.patch.contextOutput }, codeRetrieval: { ...state.saved.codeRetrieval, ...req.patch.codeRetrieval } } }
      state.context = { ...state.context, config: state.saved.contextOutput, enabled: state.saved.contextOutput.enabled, state: state.saved.contextOutput.enabled ? 'ready' : 'disabled' }
    }
    return structuredClone(state)
  }
  render(<ContextSubsystemSettings workspaceId="w" bridge={{ request }} />)
  const context = await screen.findByRole('checkbox', { name: '啟用 Context Mode' })
  expect(screen.getByText('設計參考 context-mode')).toBeTruthy(); expect(screen.getByText('設計參考 claude-context')).toBeTruthy()
  expect(screen.getByText(/未回報用量請求：1/)).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: '設定範圍' }), { target: { value: 'workspace' } })
  fireEvent.click(context); fireEvent.click(screen.getByRole('button', { name: '儲存' }))
  await waitFor(() => expect(requests.some(req => req.kind === 'desktop/context-subsystems/configure' && req.patch.scope === 'workspace' && req.patch.contextOutput?.enabled === true && req.patch.codeRetrieval?.enabled === false)).toBe(true))
  await screen.findByText('有效範圍：此工作區')
  fail = true; fireEvent.click(screen.getByRole('checkbox', { name: '啟用 Code Context' })); fireEvent.click(screen.getByRole('button', { name: '儲存' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Cannot apply saved configuration')
  fireEvent.click(screen.getByRole('button', { name: '重新整理' }))
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '啟用 Code Context' }) as HTMLInputElement).checked).toBe(false))
  expect(requests.every(req => req.workspaceId === 'w')).toBe(true)
})
it('edits global defaults independently from workspace values and saves explicit hybrid references', async () => {
  const state = initial(); const global = structuredClone(state.saved)
  state.saved.contextOutput.enabled = true; state.global = global; state.source = 'workspace'
  const requests: ContextSubsystemRequest[] = []
  const request = async (req: ContextSubsystemRequest) => { requests.push(req); return state }
  render(<ContextSubsystemSettings workspaceId="w" bridge={{ request }} />)
  const toggle = await screen.findByRole('checkbox', { name: '啟用 Context Mode' })
  expect((toggle as HTMLInputElement).checked).toBe(true)
  fireEvent.change(screen.getByRole('combobox', { name: '設定範圍' }), { target: { value: 'global' } })
  expect((toggle as HTMLInputElement).checked).toBe(false)
  fireEvent.change(screen.getByRole('combobox', { name: '檢索模式' }), { target: { value: 'hybrid' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Embedding 提供商' }), { target: { value: 'ollama' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Embedding 端點' }), { target: { value: 'http://localhost:11434' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Embedding 模型' }), { target: { value: 'local-model' } })
  fireEvent.change(screen.getByRole('textbox', { name: '憑證引用' }), { target: { value: 'EMBEDDING_KEY' } })
  fireEvent.change(screen.getByRole('textbox', { name: '參考資料夾清單' }), { target: { value: '[{"id":"manual","path":"D:/owned/reference","label":"Manual"}]' } })
  fireEvent.click(screen.getByRole('button', { name: '儲存' }))
  await waitFor(() => expect(requests.find(req => req.kind === 'desktop/context-subsystems/configure')).toMatchObject({ workspaceId: 'w', patch: { scope: 'global', contextOutput: { enabled: false }, codeRetrieval: { mode: 'hybrid', embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: 'local-model', credentialRef: 'EMBEDDING_KEY' } }, references: [{ id: 'manual', path: 'D:/owned/reference', label: 'Manual' }] } }))
  expect(screen.queryByLabelText('API key')).toBeNull()
})
it('sends explicit update rebuild cancel and clear commands from the user controls', async () => {
  const state = initial(); state.code.enabled = true; state.code.state = 'indexing'; state.code.activeJobs = 1
  state.saved.codeRetrieval.enabled = true
  const commands: unknown[] = []
  const request = async (req: ContextSubsystemRequest) => { if (req.kind === 'desktop/context-subsystems/action') commands.push(req.command); return state }
  render(<ContextSubsystemSettings workspaceId="w" bridge={{ request }} />)
  await screen.findByRole('checkbox', { name: '啟用 Code Context' })
  for (const [name, command] of [['更新索引', { target: 'code', action: 'update' }], ['重建索引', { target: 'code', action: 'rebuild' }], ['取消索引', { target: 'code', action: 'cancel' }], ['清除索引', { target: 'code', action: 'clear' }], ['清除輸出資料', { target: 'context', action: 'clear' }]] as const) {
    fireEvent.click(screen.getByRole('button', { name }))
    await waitFor(() => expect(commands.at(-1)).toEqual(command))
    await waitFor(() => expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false))
  }
})
it('saves lexical mode after leaving an incomplete hybrid embedding draft', async () => {
  let state = initial()
  let saved = false
  const request = async (req: ContextSubsystemRequest) => {
    if (req.kind === 'desktop/context-subsystems/configure') {
      const codeRetrieval = configuration(req.patch.codeRetrieval ?? {}, state.saved.codeRetrieval)
      const contextOutput = { ...state.saved.contextOutput, ...req.patch.contextOutput }
      state = { ...state, saved: { ...state.saved, codeRetrieval, contextOutput } }
      state.context = { ...state.context, config: contextOutput, enabled: contextOutput.enabled, state: 'ready' }
      state.code = { ...state.code, config: codeRetrieval }
      saved = true
    }
    return structuredClone(state)
  }
  render(<ContextSubsystemSettings workspaceId="w" bridge={{ request }} />)
  await screen.findByRole('checkbox', { name: '啟用 Context Mode' })
  fireEvent.change(screen.getByRole('combobox', { name: '檢索模式' }), { target: { value: 'hybrid' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Embedding 端點' }), { target: { value: 'http://localhost:11434' } })
  fireEvent.change(screen.getByRole('combobox', { name: '檢索模式' }), { target: { value: 'lexical' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '啟用 Context Mode' }))
  fireEvent.click(screen.getByRole('button', { name: '儲存' }))
  await waitFor(() => expect(saved).toBe(true))
  expect(state.saved.contextOutput.enabled).toBe(true)
  expect(state.saved.codeRetrieval.mode).toBe('lexical')
  expect(state.saved.codeRetrieval.embedding).toBeUndefined()
  expect(screen.queryByRole('alert')).toBeNull()
})
