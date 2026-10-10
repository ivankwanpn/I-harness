// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
vi.mock("@tanstack/react-virtual",()=>({useVirtualizer:(options:{count:number})=>({getTotalSize:()=>400,getVirtualItems:()=>Array.from({length:options.count},(_,index)=>({index,start:index*100})),measureElement:()=>{},scrollToIndex:()=>{}})}))
import { Timeline } from "../src/renderer/session/Timeline.tsx"
afterEach(()=>{cleanup();vi.restoreAllMocks()})
it("provides source-only copy and wrap for a fenced code block while retaining inline code",async()=>{
 const writeText=vi.fn(async()=>{});Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}})
 render(<Timeline rows={[{id:"answer",kind:"message",role:"assistant",text:"Use `count`.\n\n```ts\nconst count = 2\n```"}]} />)
 expect(screen.getByText("count").tagName).toBe("CODE")
 const copy=screen.getByRole("button",{name:"複製 程式碼"})
 fireEvent.click(copy);await waitFor(()=>expect(writeText).toHaveBeenCalledWith("const count = 2\n"))
 const wrap=screen.getByRole("button",{name:"自動換行 程式碼"});fireEvent.click(wrap)
 expect(wrap.getAttribute("aria-pressed")).toBe("true")
})
it("copies the assistant source and shows clipboard failure without claiming success",async()=>{
 const writeText=vi.fn(async()=>{throw new Error("denied")});Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}})
 render(<Timeline rows={[{id:"answer",kind:"message",role:"assistant",text:"**Exact** reply"}]} />)
 fireEvent.click(screen.getByRole("button",{name:"複製回覆"}))
 await waitFor(()=>expect(writeText).toHaveBeenCalledWith("**Exact** reply"))
 expect(await screen.findByRole("alert")).toHaveProperty("textContent",expect.stringContaining("denied"))
 expect(screen.queryByLabelText("已複製回覆")).toBeNull()
})
it("does not apply old clipboard completion feedback to a replaced response",async()=>{
 let finish!:()=>void;const writeText=vi.fn(()=>new Promise<void>(done=>{finish=done}));Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}})
 const view=render(<Timeline rows={[{id:"answer",kind:"message",role:"assistant",text:"Old reply"}]} />)
 fireEvent.click(screen.getByRole("button",{name:"複製回覆"}))
 view.rerender(<Timeline rows={[{id:"answer",kind:"message",role:"assistant",text:"New reply"}]} />)
 await act(async()=>finish())
 expect(screen.queryByLabelText("已複製回覆")).toBeNull()
 expect(screen.getByRole("button",{name:"複製回覆"})).toBeTruthy()
})
