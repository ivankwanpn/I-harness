// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ReviewPane } from "../src/renderer/review/ReviewPane.tsx"
import type { ReviewChanges } from "../src/renderer/review/ReviewPane.tsx"

afterEach(cleanup)

const changes: ReviewChanges = {
  kind: "ok",
  files: [
    { path: "a.txt", status: "modified", canDiff: true, canPreview: true },
    { path: "b.bin", status: "deleted", canDiff: false, canPreview: false },
  ],
  truncated: false,
}

describe("ReviewPane", () => {
  it("retains source edits while checking the diff", () => {
    const source = { kind: "text" as const, text: "before\n", revision: "a".repeat(64), truncated: false, bytes: 7 }
    const save = vi.fn()
    const view = render(<ReviewPane changes={changes} selected={{ path: "a.txt", mode: "preview" }} preview={source} onSelect={() => {}} onRefresh={() => {}} onSaveFile={save} />)
    fireEvent.change(screen.getByRole("textbox", { name: "來源檔案內容" }), { target: { value: "draft\n" } })
    view.rerender(<ReviewPane changes={changes} selected={{ path: "a.txt", mode: "diff" }} diff={{ kind: "text", text: "+before", truncated: false, bytes: 7 }} onSelect={() => {}} onRefresh={() => {}} onSaveFile={save} />)
    view.rerender(<ReviewPane changes={changes} selected={{ path: "a.txt", mode: "preview" }} preview={source} onSelect={() => {}} onRefresh={() => {}} onSaveFile={save} />)
    expect((screen.getByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement).value).toBe("draft\n")
  })

  it("exposes stage and unstage controls using the real index state", async () => {
    const stage = vi.fn().mockResolvedValue({ kind: "ok" })
    const unstage = vi.fn().mockResolvedValue({ kind: "ok" })
    render(<ReviewPane changes={{ kind: "ok", truncated: false, files: [
      { path: "a.txt", status: "modified", canDiff: true, canPreview: true, staged: true, unstaged: true },
    ] }} onSelect={() => {}} onRefresh={() => {}} onStage={stage} onUnstage={unstage} />)
    fireEvent.click(screen.getByRole("button", { name: "暫存 a.txt" }))
    await waitFor(() => expect(stage).toHaveBeenCalledWith("a.txt"))
    await waitFor(() => expect((screen.getByRole("button", { name: "取消暫存 a.txt" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "取消暫存 a.txt" }))
    await waitFor(() => expect(unstage).toHaveBeenCalledWith("a.txt"))
  })

  it("keeps the commit message after a failure and clears it after a successful local commit", async () => {
    const commit = vi.fn().mockResolvedValueOnce({ kind: "unavailable", reason: "git-failed" }).mockResolvedValueOnce({ kind: "committed", commit: "b".repeat(40) })
    render(<ReviewPane changes={{ kind: "ok", truncated: false, files: [
      { path: "a.txt", status: "modified", canDiff: true, canPreview: true, staged: true, unstaged: false },
    ] }} onSelect={() => {}} onRefresh={() => {}} onCommit={commit} />)
    const message = screen.getByRole("textbox", { name: "提交訊息" }) as HTMLTextAreaElement
    fireEvent.change(message, { target: { value: "Human commit" } })
    fireEvent.click(screen.getByRole("button", { name: "提交已暫存變更" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Git 操作失敗"))
    expect(message.value).toBe("Human commit")
    fireEvent.click(screen.getByRole("button", { name: "提交已暫存變更" }))
    await waitFor(() => expect(message.value).toBe(""))
    expect(screen.getByRole("status").textContent).toContain("已建立本機提交")
  })

  it("states a concrete reason instead of an empty list when the workspace is not a repo", () => {
    render(<ReviewPane changes={{ kind: "unavailable", reason: "not-git-repo" }} onSelect={() => {}} onRefresh={() => {}} />)

    expect(screen.getByText("不是 Git 工作區，無法列出變更")).toBeTruthy()
  })

  it("lists changed files with their status and asks for the chosen diff", () => {
    const onSelect = vi.fn()
    render(<ReviewPane changes={changes} onSelect={onSelect} onRefresh={() => {}} />)

    expect(screen.getByText("已修改")).toBeTruthy()
    expect(screen.getByText("已刪除")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /a\.txt/ }))
    expect(onSelect).toHaveBeenCalledWith("a.txt", "diff")
  })

  it("asks for a preview only for rows that can be previewed", () => {
    const onSelect = vi.fn()
    render(<ReviewPane changes={changes} onSelect={onSelect} onRefresh={() => {}} />)

    fireEvent.click(screen.getByRole("button", { name: "預覽" }))
    expect(onSelect).toHaveBeenCalledWith("a.txt", "preview")
  })

  it("renders text with a truncation marker and keeps unavailable reasons distinct", () => {
    const view = render(
      <ReviewPane
        changes={changes}
        selected={{ path: "a.txt", mode: "diff" }}
        diff={{ kind: "text", text: "+hello", truncated: true, bytes: 6 }}
        onSelect={() => {}}
        onRefresh={() => {}}
      />,
    )
    expect(screen.getByText(/\+hello/)).toBeTruthy()
    expect(screen.getByText(/已截斷/)).toBeTruthy()

    view.rerender(
      <ReviewPane
        changes={changes}
        selected={{ path: "a.txt", mode: "diff" }}
        diff={{ kind: "unavailable", reason: "binary" }}
        onSelect={() => {}}
        onRefresh={() => {}}
      />,
    )
    expect(screen.getByText("二進位內容不顯示")).toBeTruthy()

    view.rerender(
      <ReviewPane
        changes={changes}
        selected={{ path: "b.bin", mode: "preview" }}
        preview={{ kind: "unavailable", reason: "deleted" }}
        onSelect={() => {}}
        onRefresh={() => {}}
      />,
    )
    expect(screen.getByText("檔案已刪除")).toBeTruthy()
  })
})
