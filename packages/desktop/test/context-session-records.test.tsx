// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ContextSessionRecords } from "../src/renderer/session/ContextSessionRecords.tsx"
import type { DesktopBridge } from "../src/shared/bridge.ts"

afterEach(cleanup)

it("fetches the gap before a disjoint live arrival and visits the same legacy page in either direction", async () => {
  const source = Array.from({length:401},(_,i)=>({type:"user/message" as const,text:"old record "+i}))
  const request = vi.fn<DesktopBridge["request"]>(async input => {
    if(input.kind !== 'session/history') throw Error('Expected session history')
    const end = typeof input.beforeSeq === 'number' ? Math.min(input.beforeSeq,source.length) : Math.min(input.afterSeq+input.limit,source.length)
    const start = typeof input.beforeSeq === 'number' ? Math.max(0,end-input.limit) : input.afterSeq
    return {events:source.slice(start,end),nextSeq:end,...(input.beforeSeq===undefined?{}:{startSeq:start,headSeq:source.length})}
  })
  render(<ContextSessionRecords bridge={{request,onEvent:()=>()=>{}}} workspaceId="w" sessionId="s" instructions={false}
    recent={[{...source[2]!,seq:2},{...source[400]!,seq:400}]}/>)
  expect(screen.queryByText('#2')).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'較早記錄'}))
  await screen.findByText('#300')
  expect(screen.getByText('#399')).toBeTruthy()
  fireEvent.click(screen.getByText('#300'))
  expect(screen.getByText(/old record 300/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'較早記錄'}))
  await screen.findByText('#200')
  fireEvent.click(screen.getByRole('button',{name:'較新記錄'}))
  await screen.findByText('#300')
  expect(screen.getByText('#399')).toBeTruthy()
})

it("bounds the raw record DOM and reaches every cached page without disk reads while live history grows", async () => {
  const request = vi.fn<DesktopBridge["request"]>()
  const bridge: DesktopBridge = {request,onEvent:()=>()=>{}}
  const history = Array.from({length:20000},(_,seq)=>({type:'user/message' as const,seq,text:'record '+seq}))
  const props = {bridge,workspaceId:'w',sessionId:'s',instructions:false}
  const view = render(<ContextSessionRecords {...props} recent={history}/>)
  expect(view.container.querySelectorAll('details')).toHaveLength(100)
  expect(screen.getByText('#19900')).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'較早記錄'}))
  expect(screen.getByText('#19800')).toBeTruthy()
  view.rerender(<ContextSessionRecords {...props} recent={[...history,{type:'assistant/message',seq:20000,text:'new'}]}/>)
  expect(screen.getByText('#19800')).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'較新記錄'}))
  expect(screen.getByText('#19900')).toBeTruthy()
  expect(screen.getByText('#19999')).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'較新記錄'}))
  expect(screen.getByText('#20000')).toBeTruthy()
  expect(view.container.querySelectorAll('details')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button',{name:'返回最新記錄'}))
  expect(view.container.querySelectorAll('details')).toHaveLength(100)
  expect(screen.getByText('#19901')).toBeTruthy()
  expect(request).not.toHaveBeenCalled()
})

it("reads earlier public records on demand and can return to the live window", async () => {
  const request = vi.fn<DesktopBridge["request"]>().mockResolvedValue({ startSeq: 0, nextSeq: 2, events: [
    { type: "user/message", seq: 0, text: "Earlier public input" },
    { type: "user/message", seq: 1, text: "Internal input", internal: true },
  ] })
  const bridge: DesktopBridge = { request, onEvent: () => () => {} }
  render(<ContextSessionRecords bridge={bridge} workspaceId="workspace" sessionId="session"
    recent={[{ type: "assistant/message", seq: 2, text: "Recent reply" }]} instructions={false} />)
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText("assistant"))
  expect(screen.getByText(/Recent reply/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "較早記錄" }))
  await waitFor(() => expect(screen.getByText("user")).toBeTruthy())
  expect(request).toHaveBeenCalledExactlyOnceWith({ kind: "session/history", workspaceId: "workspace", sessionId: "session", afterSeq: 0, beforeSeq: 2, limit: 100 })
  expect(screen.queryByText("#1")).toBeNull()
  expect(screen.queryByText(/Earlier public input/)).toBeNull()
  fireEvent.click(screen.getByText("user"))
  expect(screen.getByText(/Earlier public input/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "返回最新記錄" }))
  expect(screen.getByText("#2")).toBeTruthy()
  expect(screen.queryByText(/Earlier public input/)).toBeNull()
})
