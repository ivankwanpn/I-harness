// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ProjectEntry } from "../src/main/projects.ts"
import type { WorkspaceEntry } from "../src/main/workspaces.ts"
import type { DesktopBridge, DesktopEvent, DesktopRequest } from "../src/shared/bridge.ts"
import { useLocale } from "../src/renderer/design/i18n.ts"
import { ProjectGitPane } from "../src/renderer/review/ProjectGitPane.tsx"
import type { ReviewChanges } from "../src/renderer/review/ReviewPane.tsx"

beforeEach(() => useLocale.getState().setLocale("zh-TW"))
afterEach(() => { cleanup(); useLocale.getState().setLocale("zh-TW") })

const folders: WorkspaceEntry[] = [
  { id: "native-a", label: "Alpha", path: "D:/project/alpha" },
  { id: "native-b", label: "Beta", path: "D:/project/beta" },
  { id: "outsider", label: "Outside", path: "D:/elsewhere" },
]
const project: ProjectEntry = { id: "project-a", name: "Application", workspaceIds: ["native-a", "native-b"], primaryWorkspaceId: "native-a", createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z" }
const nextProject: ProjectEntry = { ...project, id: "project-b", name: "Other", workspaceIds: ["native-b"], primaryWorkspaceId: "native-b" }
function changes(path: string, staged = false, unstaged = true): ReviewChanges {
  return { kind: "ok", truncated: false, files: [{ path, status: "modified", canDiff: true, canPreview: true, staged, unstaged }] }
}
const text = (value: string) => ({ kind: "text", text: value, truncated: false, bytes: value.length })

function fixture(handler: (request: DesktopRequest) => unknown | Promise<unknown> = input => input.kind === "desktop/review/changes" ? changes(`${input.workspaceId}.txt`) : { kind: "ok" }) {
  const calls: DesktopRequest[] = [], listeners = new Set<(event: DesktopEvent) => void>()
  let nativeProjects: unknown = [project, nextProject]
  let nativeFolders: unknown = folders
  const bridge: DesktopBridge = {
    request: async input => {
      calls.push(input)
      if (input.kind === "projects/list") return nativeProjects
      if (input.kind === "workspace/list") return nativeFolders
      return handler(input)
    },
    onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { bridge, calls, setProjects: (value: unknown) => { nativeProjects = value }, setFolders: (value: unknown) => { nativeFolders = value }, emit: () => { for (const listener of listeners) listener({ kind: "sdk/notification", workspaceId: "native-a", method: "desktop/session/navigation/changed", params: {} }) } }
}
const commitMessage = () => screen.getByRole("textbox", { name: "提交訊息" }) as HTMLTextAreaElement
const folderSelector = () => screen.getByRole("combobox", { name: "儲存庫資料夾" }) as HTMLSelectElement
const reviewCalls = (api: ReturnType<typeof fixture>) => api.calls.filter(input => input.kind.startsWith("desktop/review/"))

describe("ProjectGitPane", () => {
  it.each(["not-git-repo", "git-missing", "no-head"])("shows %s without an actionable commit form or file editor", async reason => {
    const api = fixture(() => ({ kind: "unavailable", reason }))
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    await waitFor(() => expect(reviewCalls(api)).toEqual([{ kind: "desktop/review/changes", workspaceId: "native-a" }]))
    await screen.findByText(reason === "not-git-repo" ? /不是 Git/ : reason === "git-missing" ? /找不到 Git/ : /還沒有任何提交/)
    expect(screen.queryByRole("textbox", { name: "提交訊息" })).toBeNull()
    expect(screen.queryByRole("textbox", { name: "來源檔案路徑" })).toBeNull()
  })

  it("offers only native project members and ignores a previous folder's late changes", async () => {
    const held = Promise.withResolvers<unknown>()
    const api = fixture(input => input.kind === "desktop/review/changes" && input.workspaceId === "native-a" ? held.promise : changes("beta.txt"))
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    await waitFor(() => expect(reviewCalls(api)).toHaveLength(1))
    expect(Array.from(folderSelector().options, option => option.value)).toEqual(["native-a", "native-b"])
    fireEvent.change(folderSelector(), { target: { value: "native-b" } })
    await screen.findByRole("button", { name: "beta.txt · 已修改" })
    await act(async () => { held.resolve(changes("obsolete-alpha.txt")); await held.promise })
    expect(screen.queryByText("obsolete-alpha.txt")).toBeNull()
    expect(folderSelector().value).toBe("native-b")
    expect(reviewCalls(api)).toEqual([{ kind: "desktop/review/changes", workspaceId: "native-a" }, { kind: "desktop/review/changes", workspaceId: "native-b" }])
  })

  it("captures diff and preview native identities and discards a late diff on folder replacement", async () => {
    const held = Promise.withResolvers<unknown>()
    const api = fixture(input => input.kind === "desktop/review/changes" ? changes("same.txt") : input.kind === "desktop/review/diff" ? held.promise : text("Current Beta preview"))
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    fireEvent.click(await screen.findByRole("button", { name: "same.txt · 已修改" }))
    await waitFor(() => expect(reviewCalls(api)).toContainEqual({ kind: "desktop/review/diff", workspaceId: "native-a", path: "same.txt" }))
    fireEvent.change(folderSelector(), { target: { value: "native-b" } })
    await screen.findByRole("button", { name: "same.txt · 已修改" })
    fireEvent.click(screen.getByRole("button", { name: "預覽" }))
    await screen.findByText("Current Beta preview")
    await act(async () => { held.resolve(text("Obsolete Alpha diff")); await held.promise })
    expect(screen.queryByText("Obsolete Alpha diff")).toBeNull()
    expect(reviewCalls(api)).toContainEqual({ kind: "desktop/review/file", workspaceId: "native-b", path: "same.txt" })
  })

  it("uses native staged and unstaged flags, locks duplicates and selector through authoritative readback", async () => {
    const mutation = Promise.withResolvers<unknown>(), readback = Promise.withResolvers<unknown>()
    let staged = false
    const api = fixture(input => {
      if (input.kind === "desktop/review/changes") return staged ? readback.promise : changes("index.txt", false, true)
      if (input.kind === "desktop/review/stage") { staged = true; return mutation.promise }
      if (input.kind === "desktop/review/unstage") return { kind: "ok" }
      throw new Error("Unexpected route")
    })
    const busy = vi.fn()
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} onBusyChange={busy} />)
    const stage = await screen.findByRole("button", { name: "暫存 index.txt" })
    expect(screen.queryByRole("button", { name: "取消暫存 index.txt" })).toBeNull()
    fireEvent.click(stage); fireEvent.click(stage)
    await waitFor(() => expect(api.calls.filter(input => input.kind === "desktop/review/stage")).toEqual([{ kind: "desktop/review/stage", workspaceId: "native-a", path: "index.txt" }]))
    expect(folderSelector().disabled).toBe(true)
    expect(busy).toHaveBeenLastCalledWith(true)
    await act(async () => { mutation.resolve({ kind: "ok" }); await mutation.promise })
    await waitFor(() => expect(api.calls.filter(input => input.kind === "desktop/review/changes")).toHaveLength(2))
    expect(folderSelector().disabled).toBe(true)
    await act(async () => { readback.resolve(changes("index.txt", true, false)); await readback.promise })
    const unstage = await screen.findByRole("button", { name: "取消暫存 index.txt" })
    await waitFor(() => expect(folderSelector().disabled).toBe(false))
    expect(screen.queryByRole("button", { name: "暫存 index.txt" })).toBeNull()
    fireEvent.click(unstage)
    await waitFor(() => expect(api.calls).toContainEqual({ kind: "desktop/review/unstage", workspaceId: "native-a", path: "index.txt" }))
    await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false))
  })

  it.each(["remove another member", "add another member"])("publishes post-stage status when validation will %s", async membershipChange => {
    const action = Promise.withResolvers<unknown>(), readback = Promise.withResolvers<unknown>(), busy = vi.fn()
    let staged = false
    const api = fixture(async input => {
      if (input.kind === "desktop/review/stage") { const result = await action.promise; staged = true; return result }
      if (input.kind === "desktop/review/changes") return staged ? readback.promise : changes("index.txt", false, true)
      throw new Error("Unexpected route")
    })
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} onBusyChange={busy} />)
    const stage = await screen.findByRole("button", { name: "暫存 index.txt" })
    fireEvent.change(commitMessage(), { target: { value: "Original project draft" } })
    api.setProjects([{ ...project, workspaceIds: membershipChange === "remove another member" ? ["native-a"] : ["native-a", "native-b", "outsider"] }, nextProject])
    fireEvent.click(stage)
    await waitFor(() => expect(api.calls.filter(input => input.kind === "desktop/review/changes")).toHaveLength(2))
    expect(api.calls.filter(input => input.kind === "desktop/review/stage")).toEqual([{ kind: "desktop/review/stage", workspaceId: "native-a", path: "index.txt" }])
    await act(async () => { action.resolve({ kind: "ok" }); await action.promise })
    await waitFor(() => expect(api.calls.filter(input => input.kind === "desktop/review/changes")).toHaveLength(3))
    expect(folderSelector().disabled).toBe(true)
    expect(busy).toHaveBeenLastCalledWith(true)
    await act(async () => { readback.resolve(changes("index.txt", true, false)); await readback.promise })
    await waitFor(() => expect(folderSelector().disabled).toBe(false))
    expect(screen.queryByRole("button", { name: "暫存 index.txt" })).toBeNull()
    expect(screen.getByRole("button", { name: "取消暫存 index.txt" })).toBeTruthy()
    expect((screen.getByRole("button", { name: "提交已暫存變更" }) as HTMLButtonElement).disabled).toBe(false)
    expect(commitMessage().value).toBe("Original project draft")
    expect(folderSelector().value).toBe("native-a")
  })

  it("publishes held post-stage readback when another member changes during the native action", async () => {
    const action = Promise.withResolvers<unknown>(), readback = Promise.withResolvers<unknown>()
    let staged = false
    const api = fixture(async input => {
      if (input.kind === "desktop/review/stage") {
        const result = await action.promise; staged = true
        api.setProjects([{ ...project, workspaceIds: ["native-a"] }, nextProject])
        return result
      }
      if (input.kind === "desktop/review/changes") return staged ? readback.promise : changes("index.txt", false, true)
      throw new Error("Unexpected route")
    })
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    fireEvent.click(await screen.findByRole("button", { name: "暫存 index.txt" }))
    await waitFor(() => expect(api.calls.some(input => input.kind === "desktop/review/stage")).toBe(true))
    await act(async () => { action.resolve({ kind: "ok" }); await action.promise })
    await waitFor(() => expect(api.calls.filter(input => input.kind === "desktop/review/changes")).toHaveLength(2))
    expect(folderSelector().disabled).toBe(true)
    await act(async () => { readback.resolve(changes("index.txt", true, false)); await readback.promise })
    await waitFor(() => expect(folderSelector().disabled).toBe(false))
    expect(screen.queryByRole("button", { name: "暫存 index.txt" })).toBeNull()
    expect(screen.getByRole("button", { name: "取消暫存 index.txt" })).toBeTruthy()
    expect(Array.from(folderSelector().options, option => option.value)).toEqual(["native-a"])
    expect(api.calls.filter(input => input.kind === "desktop/review/stage")).toEqual([{ kind: "desktop/review/stage", workspaceId: "native-a", path: "index.txt" }])
  })

  it("retains commit drafts independently for project and folder across pane remounts", async () => {
    const api = fixture(() => changes("index.txt", true, false))
    const view = render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    await screen.findByRole("textbox", { name: "提交訊息" })
    fireEvent.change(commitMessage(), { target: { value: "Alpha draft" } })
    fireEvent.change(folderSelector(), { target: { value: "native-b" } })
    await waitFor(() => expect(commitMessage().value).toBe(""))
    fireEvent.change(commitMessage(), { target: { value: "Beta draft" } })
    view.rerender(<ProjectGitPane bridge={api.bridge} project={nextProject} workspaces={folders} />)
    await waitFor(() => expect(commitMessage().value).toBe(""))
    fireEvent.change(commitMessage(), { target: { value: "Other project draft" } })
    view.unmount()
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    await waitFor(() => expect(commitMessage().value).toBe("Alpha draft"))
    fireEvent.change(folderSelector(), { target: { value: "native-b" } })
    await waitFor(() => expect(commitMessage().value).toBe("Beta draft"))
  })

  it("acknowledges a commit only in its captured project and folder after the view changes", async () => {
    const pending = Promise.withResolvers<unknown>()
    const api = fixture(input => input.kind === "desktop/review/commit" ? pending.promise : changes("index.txt", true, false))
    const view = render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    await screen.findByRole("textbox", { name: "提交訊息" })
    fireEvent.change(commitMessage(), { target: { value: "Original Alpha commit" } })
    fireEvent.click(screen.getByRole("button", { name: "提交已暫存變更" }))
    await waitFor(() => expect(api.calls).toContainEqual({ kind: "desktop/review/commit", workspaceId: "native-a", message: "Original Alpha commit" }))
    view.rerender(<ProjectGitPane bridge={api.bridge} project={nextProject} workspaces={folders} />)
    await screen.findByRole("textbox", { name: "提交訊息" })
    fireEvent.change(commitMessage(), { target: { value: "Other project unsent draft" } })
    await act(async () => { pending.resolve({ kind: "committed", commit: "a".repeat(40) }); await pending.promise })
    expect(commitMessage().value).toBe("Other project unsent draft")
    expect(api.calls.filter(input => input.kind === "desktop/review/commit")).toHaveLength(1)
    view.rerender(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    await waitFor(() => expect(commitMessage().value).toBe(""))
  })

  it("does not let an old commit readback cancel a newer project's pending changes read", async () => {
    const commit = Promise.withResolvers<unknown>(), otherChanges = Promise.withResolvers<unknown>()
    const api = fixture(input => input.kind === "desktop/review/commit" ? commit.promise
      : input.kind === "desktop/review/changes" && input.workspaceId === "native-b" ? otherChanges.promise : changes("alpha-index.txt", true, false))
    const view = render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    await screen.findByRole("textbox", { name: "提交訊息" })
    fireEvent.change(commitMessage(), { target: { value: "Original commit" } })
    fireEvent.click(screen.getByRole("button", { name: "提交已暫存變更" }))
    await waitFor(() => expect(api.calls.some(input => input.kind === "desktop/review/commit")).toBe(true))
    view.rerender(<ProjectGitPane bridge={api.bridge} project={nextProject} workspaces={folders} />)
    await waitFor(() => expect(api.calls).toContainEqual({ kind: "desktop/review/changes", workspaceId: "native-b" }))
    await act(async () => { commit.resolve({ kind: "committed", commit: "c".repeat(40) }); await commit.promise })
    await waitFor(() => expect(api.calls.filter(input => input.kind === "desktop/review/changes" && input.workspaceId === "native-a")).toHaveLength(2))
    await act(async () => { otherChanges.resolve(changes("new-project.txt", true, false)); await otherChanges.promise })
    expect(await screen.findByRole("button", { name: "new-project.txt · 已修改" })).toBeTruthy()
    expect(screen.queryByText("alpha-index.txt")).toBeNull()
  })

  it("keeps a remounted project locked until its original pending operation finishes", async () => {
    const pending = Promise.withResolvers<unknown>()
    let staged = false
    const api = fixture(input => input.kind === "desktop/review/stage" ? pending.promise.then(result => { staged = true; return result }) : changes("index.txt", staged, !staged))
    const view = render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    fireEvent.click(await screen.findByRole("button", { name: "暫存 index.txt" }))
    await waitFor(() => expect(api.calls.some(input => input.kind === "desktop/review/stage")).toBe(true))
    view.unmount()
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    const duplicate = await screen.findByRole("button", { name: "暫存 index.txt" })
    expect(duplicate.matches(":disabled")).toBe(true)
    expect(folderSelector().disabled).toBe(true)
    fireEvent.click(duplicate)
    expect(api.calls.filter(input => input.kind === "desktop/review/stage")).toHaveLength(1)
    await act(async () => { pending.resolve({ kind: "ok" }); await pending.promise })
    await waitFor(() => expect(folderSelector().disabled).toBe(false))
    expect(await screen.findByRole("button", { name: "取消暫存 index.txt" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "暫存 index.txt" })).toBeNull()
  })

  it("withdraws a native removed folder and its late diff without restoring stale supplied membership", async () => {
    const held = Promise.withResolvers<unknown>()
    const api = fixture(input => input.kind === "desktop/review/diff" ? held.promise : changes(`${"workspaceId" in input ? input.workspaceId : "unknown"}.txt`, true, false))
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    fireEvent.click(await screen.findByRole("button", { name: "native-a.txt · 已修改" }))
    await waitFor(() => expect(api.calls.some(input => input.kind === "desktop/review/diff")).toBe(true))
    api.setProjects([{ ...project, workspaceIds: ["native-b"], primaryWorkspaceId: "native-b", updatedAt: "2026-10-10T00:01:00Z" }, nextProject])
    act(() => api.emit())
    await screen.findByRole("button", { name: "native-b.txt · 已修改" })
    expect(Array.from(folderSelector().options, option => option.value)).toEqual(["native-b"])
    await act(async () => { held.resolve(text("Withdrawn Alpha content")); await held.promise })
    expect(screen.queryByText("Withdrawn Alpha content")).toBeNull()
    expect(screen.queryByText("native-a.txt")).toBeNull()
  })

  it("revalidates native membership before a mutation and never stages a removed member", async () => {
    const api = fixture(() => changes("stale.txt"))
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    const stage = await screen.findByRole("button", { name: "暫存 stale.txt" })
    api.setProjects([{ ...project, workspaceIds: ["native-b"], primaryWorkspaceId: "native-b" }, nextProject])
    fireEvent.click(stage)
    await waitFor(() => expect(folderSelector().value).toBe("native-b"))
    expect(api.calls.filter(input => input.kind === "desktop/review/stage")).toEqual([])
  })

  it("locks the validation phase and ignores a previous connection's late membership failure", async () => {
    const held = Promise.withResolvers<unknown>(), busy = vi.fn()
    const original = fixture(() => changes("original.txt"))
    const replacement = fixture(() => changes("replacement.txt", true, false))
    replacement.setProjects([{ ...project, workspaceIds: ["native-b"], primaryWorkspaceId: "native-b" }])
    const view = render(<ProjectGitPane bridge={original.bridge} project={project} workspaces={folders} onBusyChange={busy} />)
    const stage = await screen.findByRole("button", { name: "暫存 original.txt" })
    original.setProjects(held.promise)
    fireEvent.click(stage)
    await waitFor(() => expect(busy).toHaveBeenLastCalledWith(true))
    expect(folderSelector().disabled).toBe(true)
    expect(original.calls.filter(input => input.kind === "desktop/review/stage")).toEqual([])
    view.rerender(<ProjectGitPane bridge={replacement.bridge} project={project} workspaces={folders} onBusyChange={busy} />)
    await screen.findByRole("button", { name: "replacement.txt · 已修改" })
    await act(async () => { held.reject(new Error("Original connection closed")); await held.promise.catch(() => {}) })
    expect(screen.getByRole("button", { name: "replacement.txt · 已修改" })).toBeTruthy()
    expect(screen.queryByText("Original connection closed")).toBeNull()
    expect(folderSelector().value).toBe("native-b")
  })

  it("preserves the submitted draft and displays the native Git failure reason", async () => {
    const api = fixture(input => input.kind === "desktop/review/commit" ? { kind: "unavailable", reason: "fatal: index.lock exists" } : changes("index.txt", true, false))
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    await screen.findByRole("textbox", { name: "提交訊息" })
    fireEvent.change(commitMessage(), { target: { value: "Unsent draft" } })
    fireEvent.click(screen.getByRole("button", { name: "提交已暫存變更" }))
    expect((await screen.findAllByText("fatal: index.lock exists")).length).toBeGreaterThan(0)
    expect(commitMessage().value).toBe("Unsent draft")
  })

  it.each([null, { projects: [project] }, [{ ...project, workspaceIds: [42] }]])("fails closed on malformed native membership %#", async value => {
    const api = fixture(); api.setProjects(value)
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    expect((await screen.findByRole("alert")).textContent).toMatch(/專案|資料夾/)
    expect(reviewCalls(api)).toEqual([])
    expect(screen.queryByRole("textbox", { name: "提交訊息" })).toBeNull()
  })

  it.each(["removed", "malformed"])("withdraws a %s native project on notification instead of falling back to supplied roots", async change => {
    const api = fixture(() => changes("old.txt", true, false))
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    await screen.findByRole("button", { name: "old.txt · 已修改" })
    api.setProjects(change === "removed" ? [nextProject] : { rows: [project] })
    act(() => api.emit())
    await screen.findByRole("alert")
    expect(screen.queryByText("old.txt")).toBeNull()
    expect(screen.queryByRole("textbox", { name: "提交訊息" })).toBeNull()
    expect(folderSelector().disabled).toBe(true)
    expect(reviewCalls(api)).toEqual([{ kind: "desktop/review/changes", workspaceId: "native-a" }])
  })

  it("acknowledges native commit success when readback fails and keeps operations unavailable until refresh", async () => {
    let reads = 0
    const api = fixture(input => {
      if (input.kind === "desktop/review/commit") return { kind: "committed", commit: "d".repeat(40) }
      if (input.kind === "desktop/review/changes" && ++reads === 2) throw new Error("fatal: readback unavailable")
      return changes("index.txt", true, false)
    })
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    await screen.findByRole("textbox", { name: "提交訊息" })
    fireEvent.change(commitMessage(), { target: { value: "Already committed" } })
    fireEvent.click(screen.getByRole("button", { name: "提交已暫存變更" }))
    await screen.findByRole("alert")
    expect(screen.queryByRole("textbox", { name: "提交訊息" })).toBeNull()
    await waitFor(() => expect(folderSelector().disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "重新整理" }))
    await waitFor(() => expect(commitMessage().value).toBe(""))
    expect(api.calls.filter(input => input.kind === "desktop/review/commit")).toEqual([{ kind: "desktop/review/commit", workspaceId: "native-a", message: "Already committed" }])
  })

  it("withdraws folder authority when native membership becomes unreadable after a successful commit", async () => {
    const api = fixture(input => {
      if (input.kind === "desktop/review/commit") { api.setProjects(null); return { kind: "committed", commit: "e".repeat(40) } }
      return changes("index.txt", true, false)
    })
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    await screen.findByRole("textbox", { name: "提交訊息" })
    fireEvent.change(commitMessage(), { target: { value: "Accepted commit" } })
    fireEvent.click(screen.getByRole("button", { name: "提交已暫存變更" }))
    await screen.findByRole("alert")
    expect(folderSelector().disabled).toBe(true)
    expect(Array.from(folderSelector().options, option => option.value)).toEqual([""])
    expect(screen.queryByText("index.txt")).toBeNull()
    expect(api.calls.filter(input => input.kind === "desktop/review/commit")).toHaveLength(1)
  })

  it("shows actual Git read errors and hides commit actions until a fresh successful refresh", async () => {
    let broken = true
    const api = fixture(() => { if (broken) throw new Error("fatal: unsafe repository at D:/project/alpha"); return changes("recovered.txt", true, false) })
    render(<ProjectGitPane bridge={api.bridge} project={project} workspaces={folders} />)
    expect((await screen.findByRole("alert")).textContent).toContain("fatal: unsafe repository")
    expect(screen.queryByRole("textbox", { name: "提交訊息" })).toBeNull()
    broken = false
    fireEvent.click(screen.getByRole("button", { name: "重新整理" }))
    await screen.findByRole("button", { name: "recovered.txt · 已修改" })
    expect(screen.getByRole("textbox", { name: "提交訊息" })).toBeTruthy()
  })
})
