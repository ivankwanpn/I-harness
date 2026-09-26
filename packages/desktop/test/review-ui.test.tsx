// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
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
