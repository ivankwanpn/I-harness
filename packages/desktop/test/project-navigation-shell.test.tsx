// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
// jsdom has no viewport layout. Replace only the virtualizer's geometry; the
// actual shell, tool row, route selection and callback remain in this test.
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: (options: { count: number }) => ({ getTotalSize: () => options.count * 56, getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, start: index * 56, key: index })), measureElement: () => {}, scrollToIndex: () => {} }) }))
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
afterEach(() => { cleanup(); useUiStore.setState({ reviewOpen: false, surface: "conversation" }) })

it("opens moved conversation storage as a read-only reference when it is outside the current project", async () => {
  const targets: unknown[] = [], host = { id: "host", path: "D:/storage", label: "Storage" }, member = { id: "member", path: "D:/member", label: "Member" }
  render(<Workbench bridge={{ request: async () => undefined, onEvent: () => () => {} }} workspaces={[host, member]} selectedWorkspaceId={host.id} selectedSessionId="moved" projects={[{ id: "current", name: "Current", workspaceIds: [member.id], createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" }]} capabilities={{ "desktop-project-files": ["1"], "desktop-project-content-search": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={() => {}}
    onOpenProjectFile={() => { throw new Error("Storage owner was forged as a current project member") }} onOpenExternalFile={target => { targets.push(target) }}
    review={{ projectFiles: { selection: { workspaceId: host.id, sessionId: "moved", projectId: "current" }, request: async input => input.kind === "desktop/project-files/roots" ? { roots: [{ workspaceId: member.id, label: "Member" }] } : { entries: [], nextOffset: null, truncated: false } }, onSelect: () => { throw new Error("Storage reference entered legacy editable route") }, onRefresh() {} }}
    conversation={{ rows: [{ id: "tool", kind: "tool", name: "read", args: { path: "D:/storage/previous.txt" } }], canSend: false, running: false, pending: [], onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />)
  expect(screen.getByRole("button", { name: "工具詳情 read" })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "唯讀開啟 D:/storage/previous.txt" }))
  expect(targets).toEqual([{ reference: { path: "D:/storage/previous.txt", readonly: true } }])
  expect(screen.getByRole("tab", { name: "檔案" }).getAttribute("aria-selected")).toBe("true")
})
