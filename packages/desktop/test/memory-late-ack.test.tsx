// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { DesktopBridge } from '../src/shared/bridge.ts'
import { MemoryPane } from '../src/renderer/memory/MemoryPane.tsx'

afterEach(cleanup)
it('retains the visible Memory form draft after the hidden Settings Memory owner saves', async () => {
  let resolve!: (value: unknown) => void
  const pending = new Promise<unknown>(done => { resolve = done })
  const bridge: DesktopBridge = {
    request: async request => request.kind === 'desktop/memory/state' ? { enabled: true } : request.kind === 'desktop/memory/note' ? pending : { notes: [] },
    onEvent: () => () => {},
  }
  const settings = render(<MemoryPane bridge={bridge} workspaceId='owned' embedded />)
  fireEvent.click(await screen.findByRole('button', { name: '新增筆記' }))
  fireEvent.change(screen.getByLabelText('標題'), { target: { value: 'Submitted A' } })
  fireEvent.change(screen.getByLabelText('內容'), { target: { value: 'Submitted body A' } })
  fireEvent.click(screen.getByRole('button', { name: '儲存筆記' }))
  settings.rerender(<MemoryPane bridge={bridge} workspaceId='owned' embedded active={false} />)
  const standalone = render(<MemoryPane bridge={bridge} workspaceId='owned' />)
  const visible = within(standalone.container)
  fireEvent.click(await visible.findByRole('button', { name: '新增筆記' }))
  fireEvent.change(visible.getByLabelText('標題'), { target: { value: 'Newer B' } })
  fireEvent.change(visible.getByLabelText('內容'), { target: { value: 'Newer body B' } })
  await act(async () => { resolve({ note: { id: 'a', title: 'Submitted A', text: 'Submitted body A' } }); await pending })
  fireEvent.click(visible.getByRole('button', { name: '取消' }))
  fireEvent.click(visible.getByRole('button', { name: '新增筆記' }))
  expect((visible.getByLabelText('內容') as HTMLTextAreaElement).value).toBe('Newer body B')
})

it('retains a newer note search field after another owner completes its save', async () => {
  let resolve!: (value: unknown) => void
  const pending = new Promise<unknown>(done => { resolve = done })
  const bridge: DesktopBridge = { request: async request => request.kind === 'desktop/memory/state' ? { enabled: true } : request.kind === 'desktop/memory/note' ? pending : { notes: [] }, onEvent: () => () => {} }
  const first = render(<MemoryPane bridge={bridge} workspaceId='owned-query' />)
  fireEvent.click(await screen.findByRole('button', { name: '新增筆記' }))
  fireEvent.change(screen.getByLabelText('標題'), { target: { value: 'Submitted' } })
  fireEvent.change(screen.getByLabelText('內容'), { target: { value: 'Submitted body' } })
  fireEvent.click(screen.getByRole('button', { name: '儲存筆記' }))
  first.rerender(<MemoryPane bridge={bridge} workspaceId='owned-query' active={false} />)
  const second = render(<MemoryPane bridge={bridge} workspaceId='owned-query' />)
  fireEvent.change(within(second.container).getByLabelText('搜尋筆記'), { target: { value: 'Newer search' } })
  await act(async () => { resolve({}); await pending })
  second.unmount(); first.unmount()
  render(<MemoryPane bridge={bridge} workspaceId='owned-query' />)
  expect((screen.getByLabelText('搜尋筆記') as HTMLInputElement).value).toBe('Newer search')
})
