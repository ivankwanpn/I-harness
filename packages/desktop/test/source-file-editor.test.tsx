// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SourceFileEditor } from "../src/renderer/review/SourceFileEditor.tsx"

afterEach(cleanup)
const source = { kind: "text" as const, text: "before\r\n", revision: "a".repeat(64), truncated: false, bytes: 8 }

describe("source file editor", () => {
  it("saves edits with the loaded revision and clears its unsaved state", async () => {
    const save = vi.fn().mockResolvedValue({ kind: "saved", revision: "b".repeat(64), bytes: 7 })
    render(<SourceFileEditor path="src/a.ts" value={source} onSave={save} onReload={() => {}} />)
    fireEvent.change(screen.getByRole("textbox", { name: "來源檔案內容" }), { target: { value: "edited\n" } })
    expect(screen.getByText("尚未儲存")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "儲存檔案" }))
    await waitFor(() => expect(screen.getByText("檔案已儲存")).toBeTruthy())
    expect(save).toHaveBeenCalledWith("src/a.ts", "edited\r\n", "a".repeat(64))
    expect(screen.queryByText("尚未儲存")).toBeNull()
  })

  it("keeps edits on a conflict and refresh until the user discards them", async () => {
    const save = vi.fn().mockResolvedValue({ kind: "conflict" })
    const reload = vi.fn()
    const view = render(<SourceFileEditor path="src/a.ts" value={source} onSave={save} onReload={reload} />)
    fireEvent.change(screen.getByRole("textbox", { name: "來源檔案內容" }), { target: { value: "mine\n" } })
    fireEvent.click(screen.getByRole("button", { name: "儲存檔案" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("檔案已在外部變更"))
    view.rerender(<SourceFileEditor path="src/a.ts" value={{ ...source, text: "external\n", revision: "c".repeat(64) }} onSave={save} onReload={reload} />)
    expect((screen.getByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement).value).toBe("mine\n")
    fireEvent.click(screen.getByRole("button", { name: "捨棄編輯並重新讀取" }))
    expect(reload).toHaveBeenCalledWith("src/a.ts")
    expect((screen.getByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement).value).toBe("external\n")
  })

  it("retains a file draft when another file is selected", () => {
    const save = vi.fn()
    const view = render(<SourceFileEditor path="a.ts" value={source} onSave={save} onReload={() => {}} />)
    fireEvent.change(screen.getByRole("textbox", { name: "來源檔案內容" }), { target: { value: "draft\n" } })
    view.rerender(<SourceFileEditor path="b.ts" value={{ ...source, text: "second\n" }} onSave={save} onReload={() => {}} />)
    expect((screen.getByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement).value).toBe("second\n")
    view.rerender(<SourceFileEditor path="a.ts" value={source} onSave={save} onReload={() => {}} />)
    expect((screen.getByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement).value).toBe("draft\n")
  })

  it("refuses to edit incomplete or binary content", () => {
    const view = render(<SourceFileEditor path="big.ts" value={{ ...source, truncated: true, revision: undefined }} onSave={() => Promise.resolve({ kind: "conflict" })} onReload={() => {}} />)
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByText("檔案過大，僅供預覽，無法儲存")).toBeTruthy()
    view.rerender(<SourceFileEditor path="binary.dat" value={{ kind: "unavailable", reason: "binary" }} onSave={() => Promise.resolve({ kind: "conflict" })} onReload={() => {}} />)
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByText("二進位內容不顯示")).toBeTruthy()
  })
})
