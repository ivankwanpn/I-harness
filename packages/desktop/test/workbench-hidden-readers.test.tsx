// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Workbench } from '../src/renderer/shell/Workbench.tsx'
import { useUiStore } from '../src/renderer/shell/ui-store.ts'
import type { DesktopBridge } from '../src/shared/bridge.ts'

afterEach(() => { cleanup(); vi.useRealTimers(); useUiStore.setState({ reviewOpen: false, surface: 'conversation', locale: 'zh-TW' }) })
it.each([
  ['Code Mode', 'desktop/session/execution/read'],
  ['Agent 程序', 'desktop/session/processes/read'],
])('pauses hidden %s polling after another retained host has been visited', async (tab, method) => {
  vi.useFakeTimers()
  useUiStore.setState({ reviewOpen: true, surface: 'conversation', locale: 'zh-TW' })
  const request = vi.fn(async (input: { kind: string }) => {
    if (input.kind === 'desktop/capabilities') return {}
    if (input.kind === 'desktop/schedule/list') return { schedules: [] }
    if (input.kind === 'desktop/session/execution/read') return { sessionId: 's', live: true, cells: [], total: 0, offset: 0, hasMore: false }
    if (input.kind === 'desktop/session/processes/read') return { sessionId: 's', live: true, terminals: [], jobs: [] }
    return undefined
  })
  const bridge: DesktopBridge = { request, onEvent: () => () => {} }
  render(<Workbench bridge={bridge} workspaces={[{ id: 'w', path: 'D:/owned', label: 'Owned' }]} selectedWorkspaceId='w' selectedSessionId='s' capabilities={{ 'desktop-schedule': ['1'], 'desktop-execution': ['1'], 'desktop-agent-processes': ['1'] }} onSelectWorkspace={() => {}} onSelectSession={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '工作台工具' }))
  fireEvent.click(screen.getByRole('button', { name: '提醒' }))
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: '工作台工具' }))
  fireEvent.click(screen.getByRole('button', { name: tab }))
  await act(async () => {})
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: method, sessionId: 's' }))
  request.mockClear()
  fireEvent.click(screen.getByRole('button', { name: '關閉成果面板' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(4500) })
  expect(request.mock.calls.filter(([input]) => input.kind === method)).toHaveLength(0)
})
