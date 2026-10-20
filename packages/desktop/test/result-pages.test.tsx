// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
vi.mock("@tanstack/react-virtual", () => ({ elementScroll: () => {}, useVirtualizer: (options: { count: number }) => ({ getTotalSize: () => 400, getVirtualItems: () => Array.from({length:options.count}, (_,index) => ({index,start:index*56})), measureElement: () => {}, scrollToIndex: () => {}, scrollToOffset: () => {} }) }))
import type { ResultPageQuery, ResultPageResult } from "@i-harness/sdk"
import { projectTimeline, type RecordedResultEnvelope as Envelope, type WireEvent } from "../src/renderer/session/project.ts"
import { Timeline } from "../src/renderer/session/Timeline.tsx"
import { ToolActivity } from "../src/renderer/session/ToolActivity.tsx"
import { SessionHistoryView } from "../src/renderer/session/SessionHistoryView.tsx"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"

afterEach(() => { cleanup(); useUiStore.setState({locale:"zh-TW",surface:"conversation",reviewOpen:false}) })
const ref = {version:1 as const,id:"ctxv1_"+"a".repeat(64),revision:"b".repeat(64),codec:"text-utf8-v1" as const,encodedBytes:100,contentDigest:"c".repeat(64),completeness:"source-limited" as const}
const envelope: Envelope = {version:1,execution:{outcome:"succeeded",dispatch:"dispatched"},preview:"saved preview",media:[],retention:{kind:"artifact",ref}}
const page = (text:string, offset=0, nextOffset:number|null=null, target:ResultPageQuery["ref"]=ref):ResultPageResult => ({ref:target,offset,nextOffset,eof:nextOffset===null,data:{kind:"text",text}})
const reader = (readPage:(query:ResultPageQuery)=>Promise<ResultPageResult>, workspaceId="w",sessionId="s") => ({workspaceId,sessionId,readPage})
const read = () => fireEvent.click(screen.getByRole("button",{name:"讀取已保存頁面"}))

it.each(["normal","grouped","nested","code"])("explicitly reads one page through the actual %s Timeline route",async route=>{
  const readPage=vi.fn(async()=>page("first fragment",0,20))
  const event:WireEvent = route==="code" ? {type:"code/output",cellId:"cell",envelope} : route==="nested" ? {type:"code/result",cellId:"cell",callId:"a",name:"bash",envelope} : {type:"tool/result",callId:"a",name:"bash",envelope}
  const events = route==="grouped" ? [event,{type:"tool/result" as const,callId:"b",name:"bash",envelope}] : [event]
  render(<Timeline rows={projectTimeline(events)} resultReader={reader(readPage)} />)
  if(route==="grouped") fireEvent.click(screen.getByRole("button",{name:"終端操作 2"}))
  fireEvent.click(screen.getAllByRole("button",{name:route==="code" ? "Code Mode 輸出 cell" : "工具詳情 bash"})[0]!)
  expect(readPage).not.toHaveBeenCalled(); read()
  expect(await screen.findByText("first fragment")).toBeTruthy()
  expect(readPage).toHaveBeenCalledExactlyOnceWith({ref,maxBytes:16384})
  readPage.mockResolvedValueOnce(page("second fragment",20))
  fireEvent.click(screen.getByRole("button",{name:"下一個已保存頁面"}))
  expect(await screen.findByText("second fragment")).toBeTruthy()
  expect(screen.queryByText("first fragment")).toBeNull()
  expect(readPage).toHaveBeenLastCalledWith({ref,maxBytes:16384,offset:20})
  expect(screen.getByText("已到已保存內容結尾")).toBeTruthy()
  expect(screen.getByText("部分保留 · source-limited")).toBeTruthy()
  fireEvent.click(screen.getByRole("button",{name:"重新讀取第一頁"}))
  expect(await screen.findByText("first fragment")).toBeTruthy()
  expect(readPage).toHaveBeenLastCalledWith({ref,maxBytes:16384})
})

it("keeps unavailable/capability-absent output inert and binds the historical Timeline",async()=>{
  const readPage=vi.fn(async()=>page("historical bytes"))
  const view=render(<ToolActivity name="bash" envelope={envelope} expanded />)
  expect(screen.queryByRole("button",{name:"讀取已保存頁面"})).toBeNull(); view.unmount()
  render(<SessionHistoryView selection={{workspaceId:"w",sessionId:"s",seq:0}} request={async()=>({events:[{type:"tool/result",seq:0,callId:"a",name:"bash",envelope}],nextSeq:1})} onLatest={()=>{}} resultReader={reader(readPage)} />)
  await screen.findByText("saved preview"); expect(readPage).not.toHaveBeenCalled(); read()
  expect(await screen.findByText("historical bytes")).toBeTruthy()
})

it("switches the single page holder to an explicit catalog without following catalog refs",async()=>{
  const catalog={...ref,id:"ctxv1_"+"d".repeat(64),codec:"json-utf8-v1" as const}
  const readPage=vi.fn(async(query:ResultPageQuery)=> query.ref.id===catalog.id ? page('{"entries":[',0,null,catalog) : page("primary fragment"))
  render(<ToolActivity name="bash" expanded envelope={{...envelope,dependencies:{kind:"artifact-set",ref:catalog,count:1}}} resultReader={reader(readPage)} />)
  read(); await screen.findByText("primary fragment")
  fireEvent.click(screen.getByRole("button",{name:"相依輸出目錄"}))
  expect(screen.queryByText("primary fragment")).toBeNull(); expect(readPage).toHaveBeenCalledTimes(1)
  read(); await screen.findByText('{"entries":[')
  expect(readPage).toHaveBeenCalledTimes(2); expect(readPage).toHaveBeenLastCalledWith({ref:catalog,maxBytes:16384})
  fireEvent.click(screen.getByRole("button",{name:"主要輸出"}))
  expect(screen.queryByText('{"entries":[')).toBeNull()
})

it.each(["workspace","session","id","revision","version","digest","bytes","codec","completeness","capability","unmount"])("discards late fulfillment and rejection after %s changes",async field=>{
  for(const reject of [false,true]) {
    let resolve!:(page:ResultPageResult)=>void, fail!:(error:Error)=>void
    const readPage=vi.fn(()=>new Promise<ResultPageResult>((yes,no)=>{resolve=yes;fail=no}))
    const initial=reader(readPage), view=render(<ToolActivity name="bash" expanded envelope={envelope} resultReader={initial} />)
    read()
    const changed={...ref,...(field==="id"?{id:"ctxv1_"+"e".repeat(64)}:field==="revision"?{revision:"e".repeat(64)}:field==="version"?{version:2 as 1}:field==="digest"?{contentDigest:"d".repeat(64)}:field==="bytes"?{encodedBytes:101}:field==="codec"?{codec:"json-utf8-v1" as const}:field==="completeness"?{completeness:"complete" as const}:{})}
    if(field==="unmount") view.unmount()
    else view.rerender(<ToolActivity name="bash" expanded envelope={{...envelope,retention:{kind:"artifact",ref:changed}}} resultReader={field==="capability"?undefined:reader(readPage,field==="workspace"?"new":"w",field==="session"?"new":"s")} />)
    await act(async()=>{ if(reject) fail(Error("private path")); else resolve(page("obsolete bytes")) })
    expect(screen.queryByText("obsolete bytes")).toBeNull(); expect(screen.queryByRole("alert")).toBeNull(); cleanup()
  }
})

it("keeps exact binary data and bounded localized unavailable feedback",async()=>{
  const readPage=vi.fn(async():Promise<ResultPageResult>=>({ref,offset:0,nextOffset:null,eof:true,data:{kind:"bytes",base64:"/wAA"}}))
  render(<ToolActivity name="bash" expanded envelope={envelope} resultReader={reader(readPage)} />)
  read(); await screen.findByText("/wAA"); expect(screen.getByText("原始位元組（base64）")).toBeTruthy()
  readPage.mockResolvedValueOnce({kind:"unavailable",reason:"unauthorized"})
  fireEvent.click(screen.getByRole("button",{name:"重新讀取第一頁"}))
  expect(await screen.findByRole("alert")).toHaveProperty("textContent","已保存頁面目前不可用，請重新嘗試。")
  expect(screen.queryByText("/wAA")).toBeNull()
})

it("rejects forged return identity and nonadvancing or malformed pages",async()=>{
  for(const returned of [page("forged",0,null,{...ref,contentDigest:"d".repeat(64)}),page("stalled",0,0),{ref,offset:0,nextOffset:null,eof:false,data:{kind:"text" as const,text:"bad eof"}}]) {
    render(<ToolActivity name="bash" expanded envelope={envelope} resultReader={reader(async()=>returned)} />)
    read(); await screen.findByRole("alert"); expect(screen.queryByText(/forged|stalled|bad eof/)).toBeNull(); cleanup()
  }
})

it("starts exec at the owner header cursor and preserves frame order, exact bytes and slice cursor",async()=>{
  const exec={...ref,codec:"exec-frames-v1" as const,encodedBytes:1000}
  const first:ResultPageResult={ref:exec,cursor:{recordOffset:9,sliceOffset:0},nextCursor:{recordOffset:90,sliceOffset:3},eof:false,frames:[{channel:"stderr",frame:0,offset:0,end:true,data:"ZXJy",text:{kind:"utf8-view",text:"err"}},{channel:"stdout",frame:1,offset:0,end:false,data:"/wAA"}]}
  const readPage=vi.fn(async()=>first)
  render(<ToolActivity name="bash" expanded envelope={{...envelope,retention:{kind:"artifact",ref:exec}}} resultReader={reader(readPage)} />)
  read(); await screen.findByText("ZXJy")
  expect(readPage).toHaveBeenCalledExactlyOnceWith({ref:exec,maxBytes:16384,textView:true})
  const frames=screen.getAllByTestId("retained-exec-frame")
  expect(within(frames[0]!).getByText("err")).toBeTruthy(); expect(within(frames[1]!).getByText("/wAA")).toBeTruthy()
  readPage.mockResolvedValueOnce({...first,cursor:{recordOffset:90,sliceOffset:3},nextCursor:null,eof:true,frames:[{channel:"stdout",frame:1,offset:3,end:true,data:"YQ==",text:{kind:"utf8-view",text:"a"}}]})
  fireEvent.click(screen.getByRole("button",{name:"下一個已保存頁面"}))
  await screen.findByText("YQ=="); expect(screen.queryByText("ZXJy")).toBeNull()
  expect(readPage).toHaveBeenLastCalledWith({ref:exec,maxBytes:16384,textView:true,cursor:{recordOffset:90,sliceOffset:3}})
})

it.each([false,true])("binds the actual Workbench live/history reader to the displayed scope, history=%s",async historical=>{
  const calls: unknown[] = []
  const bridge={request:async(input:{kind:string})=>{if(input.kind==="session/result/read"){calls.push(input);return page("Workbench saved fragment")} return undefined},onEvent:()=>()=>{}}
  const events=[{type:"tool/result" as const,seq:0,callId:"a",name:"bash",envelope}]
  const base={bridge,projects:[],workspaces:[{id:"w",path:"D:/fixture",label:"Fixture"}],selectedWorkspaceId:"w",selectedSessionId:"s",onSelectWorkspace(){},onSelectSession(){},conversation:{rows:projectTimeline(events),canSend:false,running:false,pending:[],onPrompt:async()=>{},onCancel(){},onCancelTask(){},onCancelQueue(){},onReply:async()=>{}},...(historical?{historicalView:{selection:{workspaceId:"w",sessionId:"s",seq:0},request:async()=>({events,nextSeq:1}),onLatest(){}}}:{})}
  const view=render(<Workbench {...base} capabilities={{"session-result-read":["1"]}} />)
  if(!historical) fireEvent.click(await screen.findByRole("button",{name:"工具詳情 bash"}))
  await screen.findByText("saved preview"); expect(calls).toHaveLength(0); read()
  await screen.findByText("Workbench saved fragment")
  expect(calls).toEqual([{kind:"session/result/read",workspaceId:"w",sessionId:"s",ref,maxBytes:16384}])
  view.rerender(<Workbench {...base} capabilities={{}} />)
  expect(screen.queryByText("Workbench saved fragment")).toBeNull()
  expect(screen.queryByRole("button",{name:"讀取已保存頁面"})).toBeNull()
})

it("discards a pending primary page when switching to the catalog and never reuses its bytes",async()=>{
  let finish!:(result:ResultPageResult)=>void
  const catalog={...ref,id:"ctxv1_"+"d".repeat(64)}
  render(<ToolActivity name="bash" expanded envelope={{...envelope,dependencies:{kind:"artifact-set",ref:catalog,count:1}}} resultReader={reader(()=>new Promise(resolve=>{finish=resolve}))} />)
  read(); fireEvent.click(screen.getByRole("button",{name:"相依輸出目錄"}))
  await act(async()=>finish(page("late primary")))
  expect(screen.queryByText("late primary")).toBeNull()
  expect(screen.queryByRole("status")).toBeNull()
})
