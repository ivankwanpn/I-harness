// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsDraftScope } from '../src/renderer/settings/settings-drafts.tsx'
import { ProviderEditor } from '../src/renderer/settings/ProviderEditor.tsx'
import { McpEditor } from '../src/renderer/settings/McpEditor.tsx'
import { McpSettings } from '../src/renderer/settings/McpSettings.tsx'
import type { DesktopBridge } from '../src/shared/bridge.ts'
import { HookAuthoringEditor } from '../src/renderer/settings/HookAuthoringEditor.tsx'

afterEach(cleanup)
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it('preserves a newer provider edit when a previous mount acknowledges its save', async () => {
  const owner = {}, pending = deferred<void>()
  const provider = { id: 'owned', displayName: 'Original', configured: true }
  const form = () => <SettingsDraftScope owner={owner}><ProviderEditor draftIdentity={['providers', 'scope', 'owned', 'provider']} provider={provider} onSave={() => pending.promise} onClose={() => {}} /></SettingsDraftScope>
  const first = render(form())
  fireEvent.change(screen.getByLabelText('顯示名稱'), { target: { value: 'Submitted' } })
  fireEvent.click(screen.getByRole('button', { name: '儲存' }))
  first.unmount()
  const second = render(form())
  fireEvent.change(screen.getByLabelText('顯示名稱'), { target: { value: 'Newer private draft' } })
  await act(async () => { pending.resolve(); await pending.promise })
  second.unmount()
  render(form())
  expect((screen.getByLabelText('顯示名稱') as HTMLInputElement).value).toBe('Newer private draft')
})

it('preserves a newer MCP edit when a previous mount acknowledges its save', async () => {
  const owner = {}, pending = deferred<void>()
  const row = { enabled: false, revision: 3, config: { transport: 'stdio' as const, serverName: 'owned', command: 'node', args: [] }, secretKeys: [] }
  const form = () => <SettingsDraftScope owner={owner}><McpEditor draftIdentity={['mcp', 'scope', 'owned']} row={row} busy={false} onSave={() => pending.promise} onClose={() => {}} /></SettingsDraftScope>
  const first = render(form())
  fireEvent.change(screen.getByLabelText('執行程式'), { target: { value: 'submitted-node' } })
  fireEvent.click(screen.getByRole('button', { name: '儲存' }))
  first.unmount()
  const second = render(form())
  fireEvent.change(screen.getByLabelText('執行程式'), { target: { value: 'newer-node' } })
  await act(async () => { pending.resolve(); await pending.promise })
  second.unmount()
  render(form())
  expect((screen.getByLabelText('執行程式') as HTMLInputElement).value).toBe('newer-node')
})

it('retains newer unadded MCP private inputs and their original revision after an older save', async () => {
  const owner = {}, pending = deferred<void>()
  const row = { enabled: false, revision: 3, config: { transport: 'stdio' as const, serverName: 'owned', command: 'node', args: [] }, secretKeys: [] }
  const save = vi.fn(() => pending.promise)
  const form = () => <SettingsDraftScope owner={owner}><McpEditor draftIdentity={['mcp', 'private-scope', 'owned']} row={row} busy={false} onSave={save} onClose={() => {}} /></SettingsDraftScope>
  const first = render(form())
  fireEvent.click(screen.getByRole('button', { name: '儲存' }))
  first.unmount()
  const second = render(form())
  fireEvent.click(screen.getByText('環境變數', { selector: 'summary' }))
  fireEvent.change(screen.getByLabelText('私密欄位名稱'), { target: { value: 'OWNED_B' } })
  fireEvent.change(screen.getByLabelText('私密欄位值'), { target: { value: 'private-draft-B' } })
  await act(async () => { pending.resolve(); await pending.promise })
  second.unmount(); row.revision = 9
  render(form())
  fireEvent.click(screen.getByText('環境變數', { selector: 'summary' }))
  expect((screen.getByLabelText('私密欄位值') as HTMLInputElement).value).toBe('private-draft-B')
  fireEvent.click(screen.getByRole('button', { name: '加入' }))
  fireEvent.click(screen.getByRole('button', { name: '儲存' }))
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 3, secrets: { env: { OWNED_B: 'private-draft-B' } } }))
})

it('invalidates an unmounted hook save after a cached config was restored', async () => {
  const owner = {}, pending = deferred<unknown>()
  const request = async (command: { kind: string }) => command.kind === 'desktop/hooks/write-config' ? pending.promise : { body: 'Original', revision: 'a'.repeat(64) }
  const form = () => <SettingsDraftScope owner={owner}><HookAuthoringEditor workspaceId='scope' request={request} onSaved={() => {}} /></SettingsDraftScope>
  const seed = render(form())
  fireEvent.change(await screen.findByLabelText('Hooks 設定 JSON'), { target: { value: 'Submitted' } })
  seed.unmount()
  const first = render(form())
  fireEvent.click(await screen.findByRole('button', { name: '驗證並保存 Hooks' }))
  first.unmount()
  const second = render(form())
  fireEvent.change(await screen.findByLabelText('Hooks 設定 JSON'), { target: { value: 'Newer hook draft' } })
  await act(async () => { pending.resolve({ kind: 'saved', revision: 'b'.repeat(64) }); await pending.promise })
  second.unmount()
  render(form())
  expect((await screen.findByLabelText('Hooks 設定 JSON') as HTMLTextAreaElement).value).toBe('Newer hook draft')
})

it('does not let an older MCP controller close a remounted editor after acknowledgement', async () => {
  const pending = deferred<unknown>()
  const state = { servers: [{ enabled: false, revision: 3, config: { transport: 'stdio', serverName: 'owned', command: 'node', args: [] }, secretKeys: [] }] }
  const bridge: DesktopBridge = { request: async request => request.kind === 'desktop/mcp/mutate' ? pending.promise : state, onEvent: () => () => {} }
  const first = render(<McpSettings bridge={bridge} workspaceId='controller-scope' />)
  fireEvent.click(await screen.findByRole('button', { name: '編輯 MCP 設定' }))
  fireEvent.change(screen.getByLabelText('執行程式'), { target: { value: 'Submitted node' } })
  fireEvent.click(screen.getByRole('button', { name: '儲存' }))
  first.unmount()
  const second = render(<McpSettings bridge={bridge} workspaceId='controller-scope' />)
  fireEvent.change(await screen.findByLabelText('執行程式'), { target: { value: 'Newer node' } })
  await act(async () => { pending.resolve(state); await pending.promise })
  second.unmount()
  render(<McpSettings bridge={bridge} workspaceId='controller-scope' />)
  expect((await screen.findByLabelText('執行程式') as HTMLInputElement).value).toBe('Newer node')
})
