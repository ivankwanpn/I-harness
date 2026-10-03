// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { ExternalFileViewer } from "../src/renderer/review/ExternalFileViewer.tsx"
import { ProjectFilesPane } from "../src/renderer/review/ProjectFilesPane.tsx"
import { SearchPreview } from "../src/renderer/review/SearchPreview.tsx"
import { EditorDraftStore } from "../src/renderer/review/editor-drafts.ts"
import type { ProjectFilesRequest } from "../../desktop-gateway/src/project-files.ts"

afterEach(cleanup)
const owner = { workspaceId: "host", sessionId: "original-session", projectId: "original-project" }
const nextOwner = { workspaceId: "next-host", sessionId: "next-session", projectId: "next-project" }
const source = { kind: "text", text: "readonly text", bytes: 13, truncated: false, revision: "a".repeat(64), readonly: true, external: true }
const preview = { readonly: true, external: true, text: "readonly text", startLine: 40, encoding: "utf16le", revision: "a".repeat(64), changedSinceSearch: false, truncated: false }
type Call = ProjectFilesRequest & { requestId?: string }

it("discloses replaced invalid encoding bytes even when the whole preview was captured", () => {
  const reason = "Invalid or incomplete utf8 bytes; replacement characters shown"
  render(<SearchPreview value={{ readonly: true, text: "a�b", startLine: 1, encoding: "utf8", revision: "a".repeat(64), changedSinceSearch: false, truncated: false, reason }} />)
  expect(screen.getByText(reason)).toBeTruthy()
  expect(screen.getByRole("region", { name: "唯讀搜尋預覽" }).textContent).toContain("a�b")
})

it.each(["external-read", "external-preview"] as const)("identifies %s and cancels its original owner on replacement and unmount", async operation => {
  const first = Promise.withResolvers<unknown>(), second = Promise.withResolvers<unknown>(), calls: Call[] = []
  const request = async (input: ProjectFilesRequest) => { calls.push(input as Call); if (input.kind === "desktop/project-files/content-cancel") return { cancelled: true }; return calls.filter(call => call.kind === `desktop/project-files/${operation}`).length === 1 ? first.promise : second.promise }
  const target = (path: string) => ({ reference: { path, readonly: true as const }, ...(operation === "external-preview" ? { navigation: { line: 40, encoding: "utf16le" as const, nonce: path } } : {}) })
  const view = render(<ExternalFileViewer target={target("D:/reference/first.txt")} selection={owner} request={request} onClose={() => {}} />)
  const initial = calls.find(call => call.kind === `desktop/project-files/${operation}`)!
  expect(initial.requestId).toEqual(expect.any(String))
  expect(initial.requestId?.length).toBeGreaterThan(0)
  view.rerender(<ExternalFileViewer target={target("D:/reference/second.txt")} selection={nextOwner} request={request} onClose={() => {}} />)
  await waitFor(() => expect(calls.filter(call => call.kind === "desktop/project-files/content-cancel")).toHaveLength(1))
  expect(calls.find(call => call.kind === "desktop/project-files/content-cancel")).toEqual({ ...owner, kind: "desktop/project-files/content-cancel", requestId: initial.requestId })
  const replacement = calls.filter(call => call.kind === `desktop/project-files/${operation}`)[1]!
  expect(replacement.requestId).not.toBe(initial.requestId)
  view.unmount()
  expect(calls.filter(call => call.kind === "desktop/project-files/content-cancel")[1]).toEqual({ ...nextOwner, kind: "desktop/project-files/content-cancel", requestId: replacement.requestId })
  await act(async () => { first.resolve(operation === "external-read" ? source : preview); second.resolve(operation === "external-read" ? source : preview); await Promise.all([first.promise, second.promise]) })
  expect(calls.filter(call => call.kind === "desktop/project-files/content-cancel")).toHaveLength(2)
})

it("identifies project search previews and cancels each replaced or unmounted preview", async () => {
  const first = Promise.withResolvers<unknown>(), second = Promise.withResolvers<unknown>(), calls: Call[] = []
  const request = async (input: ProjectFilesRequest) => {
    calls.push(input as Call)
    if (input.kind === "desktop/project-files/roots") return { roots: [{ workspaceId: "member", label: "Member" }] }
    if (input.kind === "desktop/project-files/search-preview") return calls.filter(call => call.kind === input.kind).length === 1 ? first.promise : second.promise
    if (input.kind === "desktop/project-files/content-cancel") return { cancelled: true }
    return { entries: [], nextOffset: null, truncated: false }
  }
  const store = new EditorDraftStore(), target = (path: string) => ({ workspaceId: "member", path, navigation: { line: 40, encoding: "utf16le" as const, nonce: path } })
  const view = render(<ProjectFilesPane selection={owner} request={request} store={store} openFile={target("first.txt")} />)
  await waitFor(() => expect(calls.some(call => call.kind === "desktop/project-files/search-preview")).toBe(true))
  const initial = calls.find(call => call.kind === "desktop/project-files/search-preview")!
  expect(initial.requestId).toEqual(expect.any(String))
  view.rerender(<ProjectFilesPane selection={owner} request={request} store={store} openFile={target("second.txt")} />)
  await waitFor(() => expect(calls.filter(call => call.kind === "desktop/project-files/content-cancel")).toHaveLength(1))
  expect(calls.find(call => call.kind === "desktop/project-files/content-cancel")).toEqual({ ...owner, kind: "desktop/project-files/content-cancel", requestId: initial.requestId })
  const replacement = calls.filter(call => call.kind === "desktop/project-files/search-preview")[1]!
  expect(replacement.requestId).not.toBe(initial.requestId)
  view.unmount()
  expect(calls.filter(call => call.kind === "desktop/project-files/content-cancel")[1]).toEqual({ ...owner, kind: "desktop/project-files/content-cancel", requestId: replacement.requestId })
  await act(async () => { first.resolve({ ...preview, external: false }); second.resolve({ ...preview, external: false }); await Promise.all([first.promise, second.promise]) })
  expect(store.getSnapshot().drafts).toEqual({})
})

it("never starts a fallback preview after a legacy project read is made obsolete", async () => {
  const held = Promise.withResolvers<unknown>(), calls: Call[] = []
  const request = async (input: ProjectFilesRequest) => { calls.push(input as Call); if (input.kind === "desktop/project-files/roots") return { roots: [{ workspaceId: "member", label: "Member" }] }; if (input.kind === "desktop/project-files/read") return held.promise; return { entries: [], nextOffset: null, truncated: false } }
  const view = render(<ProjectFilesPane selection={owner} request={request} store={new EditorDraftStore()} openFile={{ workspaceId: "member", path: "file.txt", navigation: { line: 1, nonce: "target" } }} />)
  await waitFor(() => expect(calls.some(call => call.kind === "desktop/project-files/read")).toBe(true))
  view.unmount()
  await act(async () => { held.resolve({ kind: "unavailable", reason: "binary" }); await held.promise })
  expect(calls.filter(call => call.kind === "desktop/project-files/search-preview" || call.kind === "desktop/project-files/content-cancel")).toEqual([])
})

it("sends one owned cancellation when a preview request fails and does not retry it on unmount", async () => {
  const calls: Call[] = []
  const request = async (input: ProjectFilesRequest) => { calls.push(input as Call); if (input.kind === "desktop/project-files/external-preview") throw new Error("transport timeout"); if (input.kind === "desktop/project-files/content-cancel") return { cancelled: true }; throw new Error("Wrong preview route") }
  const view = render(<ExternalFileViewer target={{ reference: { path: "D:/reference/file.txt", readonly: true }, navigation: { line: 40, encoding: "utf16le", nonce: "target" } }} selection={owner} request={request} onClose={() => {}} />)
  expect((await screen.findByRole("alert")).textContent).toContain("transport timeout")
  const initial = calls.find(call => call.kind === "desktop/project-files/external-preview")!
  expect(calls.find(call => call.kind === "desktop/project-files/content-cancel")).toEqual({ ...owner, kind: "desktop/project-files/content-cancel", requestId: initial.requestId })
  view.unmount()
  expect(calls.filter(call => call.kind === "desktop/project-files/content-cancel")).toHaveLength(1)
})
