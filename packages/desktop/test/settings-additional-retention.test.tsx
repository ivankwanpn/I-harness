// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsPane } from '../src/renderer/settings/SettingsPane.tsx'
import { useLocale } from '../src/renderer/design/i18n.ts'
import type { DesktopRequest } from '../src/shared/bridge.ts'

beforeEach(() => { localStorage.clear(); useLocale.getState().setLocale('zh-TW') })
afterEach(cleanup)
const saved = { sandboxMode:'workspace-write', approvalMode:'dangerous', autoCompaction:true, windowsSandboxBackend:'legacy', wslExecution:{distribution:'Ubuntu',networkAccess:false,workspaceDependencies:true} }
function mount(handle: (input: DesktopRequest) => unknown = () => undefined, extraCapabilities: Record<string,string[]> = {}) {
  const request = vi.fn(async (input: DesktopRequest) => {
    const value=handle(input)
    if(value!==undefined) return value
    if (input.kind==='desktop/agent-settings/state') return {saved,effective:saved,source:'settings',restartRequired:false}
    if (input.kind==='desktop/approval-rules/state') return {rules:[],candidates:[]}
    if (input.kind==='desktop/subagents/state') return {roles:[],enabled:false,effectiveEnabled:false}
    if (input.kind==='desktop/provider/directory') return []
    if (input.kind==='desktop/plugins/state') return {sources:[],plugins:[]}
    if (input.kind==='desktop/wsl/state') return {distributions:[{name:'Ubuntu',version:2,state:'Stopped'}]}
    if (input.kind==='desktop/local/state') return {notifications:false,notificationsSupported:true}
    if (input.kind==='desktop/global-preferences/state') return {enabled:false}
    return {}
  })
  render(<SettingsPane workspace={{id:'readonly-review',label:'Review',path:'D:/I-harness-main/.tmp/review'}} bridge={{request,onEvent:()=>()=>{}}} capabilities={{'desktop-agent-settings':['1'],'desktop-subagents':['1'],'desktop-plugins':['1'],...extraCapabilities}} onClose={()=>{}} />)
  return request
}
it('keeps the unsaved Execution backend selection after settings navigation',async()=>{
  const request=mount();fireEvent.click(screen.getByRole('button',{name:'執行與權限'}))
  fireEvent.change(await screen.findByRole('combobox',{name:'Windows 執行後端'}),{target:{value:'psec'}})
  fireEvent.click(screen.getByRole('button',{name:'一般'}));fireEvent.click(screen.getByRole('button',{name:'執行與權限'}))
  expect((await screen.findByRole('combobox',{name:'Windows 執行後端'}) as HTMLSelectElement).value).toBe('psec')
  expect(request.mock.calls.some(([input])=>input.kind==='desktop/agent-settings/configure')).toBe(false)
})
it('keeps the unfinished Subagents role name after settings navigation',async()=>{
  mount();fireEvent.click(screen.getByRole('button',{name:'子代理'}))
  fireEvent.click(await screen.findByRole('button',{name:'新增角色配置'}));fireEvent.change(screen.getByRole('textbox',{name:'角色名稱'}),{target:{value:'unfinished-role'}})
  fireEvent.click(screen.getByRole('button',{name:'一般'}));fireEvent.click(screen.getByRole('button',{name:'子代理'}))
  expect((await screen.findByRole('textbox',{name:'角色名稱'}) as HTMLInputElement).value).toBe('unfinished-role')
})
it('keeps the unfinished Plugins source path after settings navigation',async()=>{
  mount();fireEvent.click(screen.getByRole('button',{name:'插件'}));await screen.findByText('尚未加入插件；可先加入市場來源。')
  const summary=screen.getByText('管理市場來源',{selector:'summary'});(summary.parentElement as HTMLDetailsElement).open=true
  fireEvent.change(screen.getByRole('textbox',{name:'來源網址或本機路徑'}),{target:{value:'D:/I-harness-main/.tmp/unsent-owned-market'}})
  fireEvent.click(screen.getByRole('button',{name:'一般'}));fireEvent.click(screen.getByRole('button',{name:'插件'}));await screen.findByText('尚未加入插件；可先加入市場來源。')
  const reopened=screen.getByText('管理市場來源',{selector:'summary'});(reopened.parentElement as HTMLDetailsElement).open=true
  expect((screen.getByRole('textbox',{name:'來源網址或本機路徑'}) as HTMLInputElement).value).toBe('D:/I-harness-main/.tmp/unsent-owned-market')
})

it('routes to the same source plugin repeatedly without replacing a source draft or pending owner',async()=>{
  let release!: ()=>void
  const pending=new Promise<void>(resolve=>{release=resolve})
  const request=mount(input=>{
    if(input.kind==='desktop/plugins/state') return {sources:[],plugins:[{id:'owned-plugin-id',name:'Owned plugin',installed:true,enabled:false}]}
    if(input.kind==='desktop/plugins/mutate') return pending
    if(input.kind==='desktop/resources/list') return {items:input.resourceKind==='skills'?[{name:'owned-plugin-skill',source:'plugin',pluginId:'owned-plugin-id',effective:true}]:[],total:input.resourceKind==='skills'?1:0,diagnostics:[]}
    if(input.kind==='desktop/resources/read') return {name:input.name,source:'plugin',pluginId:'owned-plugin-id',body:'Owned inert plugin content',rawBody:'Owned inert plugin content',effective:true,truncated:false}
    return undefined
  },{'desktop-resources':['1']})
  fireEvent.click(screen.getByRole('button',{name:'插件'}));await screen.findByRole('button',{name:'查看插件詳情 Owned plugin'})
  const summary=screen.getByText('管理市場來源',{selector:'summary'});(summary.parentElement as HTMLDetailsElement).open=true
  const source=screen.getByRole('textbox',{name:'來源網址或本機路徑'}) as HTMLInputElement
  fireEvent.change(source,{target:{value:'D:/I-harness-main/.tmp/unfinished-source'}})
  fireEvent.click(screen.getByRole('button',{name:'啟用'}))
  await waitFor(()=>expect(source.disabled).toBe(true))
  fireEvent.click(screen.getByRole('button',{name:'資源'}));fireEvent.click(await screen.findByRole('button',{name:'owned-plugin-skill'}))
  fireEvent.click(await screen.findByRole('button',{name:'管理來源插件'}))
  expect((screen.getByRole('searchbox',{name:'搜尋插件'}) as HTMLInputElement).value).toBe('owned-plugin-id')
  expect(screen.getByRole('textbox',{name:'來源網址或本機路徑'})).toBe(source)
  expect(source.value).toBe('D:/I-harness-main/.tmp/unfinished-source')
  expect(source.disabled).toBe(true)
  expect((screen.getByRole('button',{name:'啟用'}) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByRole('searchbox',{name:'搜尋插件'}),{target:{value:'different-filter'}})
  fireEvent.click(screen.getByRole('button',{name:'資源'}));fireEvent.click(screen.getByRole('button',{name:'管理來源插件'}))
  expect((screen.getByRole('searchbox',{name:'搜尋插件'}) as HTMLInputElement).value).toBe('owned-plugin-id')
  expect(request.mock.calls.filter(([input])=>input.kind==='desktop/plugins/state')).toHaveLength(1)
  await act(async()=>release())
  await waitFor(()=>expect(source.disabled).toBe(false))
  expect(source.value).toBe('D:/I-harness-main/.tmp/unfinished-source')
  expect(request.mock.calls.filter(([input])=>input.kind==='desktop/plugins/mutate')).toHaveLength(1)
})

it('keeps a hidden Execution page bound to its own session and pending Code Mode owner',async()=>{
  let release!: ()=>void
  const pending=new Promise<void>(resolve=>{release=resolve})
  const savedModes=new Map<string,string>()
  const request=vi.fn(async(input: DesktopRequest)=>{
    if(input.kind==='desktop/code-mode/state') return {saved:{mode:savedModes.get(input.workspaceId)??'off'},effective:'off'}
    if(input.kind==='desktop/code-mode/configure') {await pending;savedModes.set(input.workspaceId,input.patch.mode??'off');return {saved:{mode:savedModes.get(input.workspaceId)},effective:'off'}}
    if(input.kind==='desktop/local/state') return {notifications:false,notificationsSupported:true}
    if(input.kind==='desktop/global-preferences/state') return {enabled:false}
    return {}
  })
  const bridge={request,onEvent:()=>()=>{}}
  const a={id:'workspace-a',label:'A',path:'D:/I-harness-main/.tmp/a'},b={id:'workspace-b',label:'B',path:'D:/I-harness-main/.tmp/b'}
  const props={bridge,capabilities:{'desktop-code-mode-settings':['1']},onClose:()=>{}}
  const view=render(<SettingsPane {...props} workspace={a} sessionId="session-a" />)
  fireEvent.click(screen.getByRole('button',{name:'執行與權限'}))
  const mode=await screen.findByRole('combobox',{name:'Code Mode'}) as HTMLSelectElement
  await waitFor(()=>expect(mode.disabled).toBe(false))
  fireEvent.change(mode,{target:{value:'only'}})
  await waitFor(()=>expect(mode.disabled).toBe(true))
  view.rerender(<SettingsPane {...props} workspace={b} sessionId="session-b" />)
  await waitFor(()=>expect(request).toHaveBeenCalledWith({kind:'desktop/code-mode/state',workspaceId:'workspace-b',sessionId:'session-b'}))
  expect(request.mock.calls.some(([input])=>'workspaceId' in input&&'sessionId' in input&&input.workspaceId==='workspace-a'&&input.sessionId==='session-b')).toBe(false)
  view.rerender(<SettingsPane {...props} workspace={a} sessionId="session-a" />)
  expect(screen.getByRole('combobox',{name:'Code Mode'})).toBe(mode)
  expect(mode.disabled).toBe(true)
  expect(request.mock.calls.filter(([input])=>input.kind==='desktop/code-mode/state'&&input.workspaceId==='workspace-a')).toHaveLength(1)
  await act(async()=>release())
  await waitFor(()=>expect(mode.disabled).toBe(false))
  expect(mode.value).toBe('only')
  expect(request.mock.calls.filter(([input])=>input.kind==='desktop/code-mode/configure')).toHaveLength(1)
})
