// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
vi.mock("@tanstack/react-virtual", () => ({ elementScroll: () => {}, useVirtualizer: (options: { count: number }) => ({ getTotalSize: () => 400, getVirtualItems: () => Array.from({length:options.count}, (_,index) => ({index,start:index*56})), measureElement: () => {}, scrollToIndex: () => {}, scrollToOffset: () => {} }) }))
import { projectTimeline, type WireEvent, type RecordedResultEnvelope as ResultEnvelope } from "../src/renderer/session/project.ts"
import { Timeline } from "../src/renderer/session/Timeline.tsx"
import { ToolActivity } from "../src/renderer/session/ToolActivity.tsx"
import { workStages } from "../src/renderer/session/work-stages.ts"
import { groupActivities } from "../src/renderer/session/activity-groups.ts"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
afterEach(() => { cleanup(); useUiStore.setState({locale:"zh-TW"}) })
const image = {mediaType:"image/png" as const, dataBase64:"iVBORw0KGgo=",name:"owned.png"}
const inline: ResultEnvelope = {version:1,execution:{outcome:"succeeded",dispatch:"dispatched"},preview:"",media:[image],retention:{kind:"inline",encodedBytes:150,value:{stdout:"payload error is ordinary data",error:"ordinary",status:"failed",isError:true,exitCode:7,images:[image],extra:"original-value"}}}
if(inline.retention.kind === "inline") inline.retention.encodedBytes = new TextEncoder().encode(JSON.stringify(inline.retention.value)).length
const artifact: ResultEnvelope = {...inline,execution:{outcome:"failed",dispatch:"not-dispatched"},preview:"retained failure preview",media:[],retention:{kind:"artifact",ref:{version:1,id:"ctxv1_"+"b".repeat(64),revision:"c".repeat(64),codec:"json-utf8-v1",encodedBytes:20000,contentDigest:"a".repeat(64),completeness:"source-limited"}}}
const quota: ResultEnvelope = {...inline,media:[],preview:"quota preview",retention:{kind:"unavailable",reason:"quota",observedEncodedBytes:3000}}
function event(envelope: ResultEnvelope, nested = false, callId = "one"): WireEvent { return nested ? {type:"code/result",cellId:"cell",callId,name:"bash",envelope} : {type:"tool/result",callId,name:"bash",envelope} }
it.each([false,true])("folds matched and standalone retained results, nested=%s", nested => {
  const result = event(inline,nested)
  const call: WireEvent = nested ? {type:"code/call",cellId:"cell",callId:"one",name:"bash",args:{command:"fixture"}} : {type:"tool/call",callId:"one",name:"bash",args:{command:"fixture"}}
  for (const events of [[result],[call,result]]) {
    const row = projectTimeline(events)[0]!
    render(<Timeline rows={[row]} />)
    expect(screen.getByText("已收到結果")).toBeTruthy()
    fireEvent.click(screen.getByRole("button",{name:"工具詳情 bash"}))
    expect(screen.getByText("payload error is ordinary data")).toBeTruthy()
    expect(screen.getAllByRole("img")).toHaveLength(1)
    fireEvent.click(screen.getByText("原始記錄"))
    expect(within(screen.getByRole("region",{name:"原始輸出"})).getByText(/original-value/)).toBeTruthy()
    cleanup()
  }
})
it("renders the actual grouped route with preview, honest partial retention and dispatch", () => {
  const rows = projectTimeline([event(artifact),event(quota,false,"two")])
  render(<Timeline rows={rows} />)
  fireEvent.click(screen.getByRole("button",{name:"終端操作 2"}))
  const tools=screen.getAllByRole("button",{name:"工具詳情 bash"}); fireEvent.click(tools[0]!)
  expect(screen.getByText("執行失敗")).toBeTruthy()
  expect(screen.getByText("retained failure preview")).toBeTruthy()
  expect(screen.getByText("未派發")).toBeTruthy()
  expect(screen.getByText("部分保留 · source-limited")).toBeTruthy()
  expect(screen.getByText(/json-utf8-v1/)).toBeTruthy()
  expect(screen.queryByText(/完整輸出已保存/)).toBeNull()
  fireEvent.click(tools[1]!)
  expect(screen.getByText("quota preview")).toBeTruthy()
  expect(screen.getByText("保存原因: quota · 3000 bytes")).toBeTruthy()
  expect(screen.getAllByText("執行失敗")).toHaveLength(1)
})
it.each([["canceled","已取消"],["unknown","結果未知"]] as const)("preserves trusted %s despite payload-shaped errors", (outcome,label) => {
  const envelope={...inline,execution:{outcome,dispatch:"not-dispatched" as const}}
  const rows=projectTimeline([{type:"turn/start"},event(envelope),{type:"turn/end"}])
  expect(workStages(groupActivities(rows),new Map())[0]).toMatchObject({kind:"work-stage",hasErrors:false})
  render(<Timeline rows={projectTimeline([event(envelope)])} />)
  expect(screen.getByText(label)).toBeTruthy()
  expect(screen.queryByText("執行失敗")).toBeNull()
})
it("only failed trusted execution marks a work stage, including a grouped quota result",()=>{
  for (const [envelope,hasErrors] of [[inline,false],[quota,false],[artifact,true]] as const) {
    const rows=projectTimeline([{type:"turn/start"},event(envelope),event(envelope,false,"two"),{type:"turn/end"}])
    expect(workStages(groupActivities(rows),new Map())[0]).toMatchObject({kind:"work-stage",hasErrors})
  }
})
it("uses English storage labels and calls the validated media preview once",()=>{
  useUiStore.setState({locale:"en"})
  const preview=vi.fn(), row=projectTimeline([event(inline)])[0]!
  if(row.kind!=="tool") throw new Error("missing tool")
  render(<ToolActivity {...row} expanded onPreview={preview} />)
  expect(screen.getByText("Result received")).toBeTruthy()
  expect(screen.getAllByRole("img")).toHaveLength(1)
  fireEvent.click(screen.getByRole("button",{name:"owned.png"}))
  expect(preview).toHaveBeenCalledExactlyOnceWith({src:"data:image/png;base64,iVBORw0KGgo=",name:"owned.png"})
})

it.each([false, true])("keeps all retention kinds readable with and without the nested call, nested=%s", nested => {
  for (const matched of [false, true]) for (const envelope of [inline, artifact, quota]) {
    const result = event(envelope, nested)
    const call: WireEvent = nested
      ? {type:"code/call",cellId:"cell",callId:"one",name:"bash",args:{command:"fixture"}}
      : {type:"tool/call",callId:"one",name:"bash",args:{command:"fixture"}}
    render(<Timeline rows={projectTimeline(matched ? [call, result] : [result])} />)
    expect(screen.getByText(envelope.execution.outcome === "failed" ? "執行失敗" : "已收到結果")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", {name:"工具詳情 bash"}))
    expect(screen.getByText(envelope.retention.kind === "inline" ? "payload error is ordinary data" : envelope.preview)).toBeTruthy()
    cleanup()
  }
})

it("replaces obsolete legacy error data when a retained result settles the same row", () => {
  const rows = projectTimeline([
    {type:"tool/result",callId:"one",name:"bash",output:{error:"obsolete failure"},isError:true},
    event(inline),
  ])
  const row = rows[0]!
  expect(row.kind === "tool" && row.output).toBeUndefined()
  expect(row.kind === "tool" && row.isError).toBeUndefined()
  render(<Timeline rows={rows} />)
  expect(screen.getByText("已收到結果")).toBeTruthy()
  expect(screen.queryByText("執行失敗")).toBeNull()
  fireEvent.click(screen.getByRole("button", {name:"工具詳情 bash"}))
  expect(screen.queryByText(/obsolete failure/)).toBeNull()
})

it("keeps typed media in its original order and never renders payload-shaped images", () => {
  const row = projectTimeline([event({...inline, media:[{...image,name:"first.png"},{...image,name:"second.png"}]})])[0]!
  if(row.kind !== "tool") throw new Error("missing tool")
  render(<ToolActivity {...row} expanded />)
  expect(screen.getAllByRole("img").map(image => image.getAttribute("alt"))).toEqual(["first.png","second.png"])
  fireEvent.click(screen.getByText("原始記錄"))
  expect(within(screen.getByRole("region", {name:"原始輸出"})).getByText(/owned.png/)).toBeTruthy()
})
