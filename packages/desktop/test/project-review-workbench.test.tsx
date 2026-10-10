// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import { useLocale } from "../src/renderer/design/i18n.ts"
import { createTextDiff } from "../../text-diff/src/index.ts"
const folder = { id: "folder", path: "D:/owned/project", label: "folder" }
const project = { id: "p", name: "My project", workspaceIds: [folder.id], primaryWorkspaceId: folder.id, createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z" }
afterEach(() => { cleanup(); useUiStore.setState({ reviewOpen: false, surface: "conversation" }); useLocale.getState().setLocale("zh-TW") })
const base = { bridge: { request: vi.fn(async () => undefined), onEvent: () => () => {} }, workspaces: [folder], projects: [project], selectedProjectId: project.id, selectedWorkspaceId: folder.id, capabilities: { "desktop-project-files": ["1"], "desktop-review": ["1"] }, onSelectWorkspace() {}, onSelectSession() {} }
it("uses the project name without adding a mandatory folder navigation title", () => {
  render(<Workbench {...base} />)
  expect(screen.getByTestId("session-header").querySelector(".header-title")?.textContent).toBe("My project")
})
it("keeps Files separate from recorded Changes and exposes Git independently", async () => {
  useUiStore.setState({ reviewOpen: true })
  const fileRequest = vi.fn(async (input: {kind:string}) => input.kind === "desktop/project-files/roots" ? {roots:[{workspaceId:folder.id,label:folder.label}]} : {entries:[],nextOffset:null,truncated:false})
  render(<Workbench {...base} selectedSessionId="s" review={{ projectFiles:{selection:{workspaceId:folder.id,projectId:project.id,sessionId:"s"},request:fileRequest}, changes:{kind:"unavailable",reason:"not-git-repo"}, onSelect(){},onRefresh(){},onCommit:vi.fn() }}
    conversation={{ rows:[{id:"edit",kind:"tool",name:"edit",resultReceived:true,turn:{id:"t",complete:true},output:{change:createTextDiff("a.txt","old\n","new\n")}}],canSend:false,running:false,pending:[],onPrompt:async()=>{},onCancel(){},onCancelTask(){},onCancelQueue(){},onReply:async()=>{} }} />)
  await screen.findByRole("button",{name:"▾ folder"})
  fireEvent.click(screen.getByRole("tab",{name:"變更"}))
  expect(screen.getByRole("region",{name:"會話變更"})).toBeTruthy()
  expect(screen.getByText("+new")).toBeTruthy()
  expect(screen.queryByText("不是 Git 工作區，無法列出變更")).toBeNull()
  expect(screen.queryByRole("textbox",{name:"提交訊息"})).toBeNull()
  expect(screen.getByRole("button",{name:"專案 Git"})).toBeTruthy()
  expect(screen.queryByRole("tab",{name:"Git"})).toBeNull()
  fireEvent.click(screen.getByRole("tab",{name:"檔案"}))
  await waitFor(()=>expect(screen.getByRole("navigation",{name:"專案檔案樹"})).toBeTruthy())
})
