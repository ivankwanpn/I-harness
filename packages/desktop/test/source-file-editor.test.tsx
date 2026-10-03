// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SourceFileEditor } from "../src/renderer/review/SourceFileEditor.tsx"
import { EditorDraftStore } from "../src/renderer/review/editor-drafts.ts"

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

  it("reveals a UTF16 range once per navigation nonce against BOM and CRLF normalized text", async () => {
    const value = { ...source, text: "\uFEFFtop\r\n中😀 needle \t\r\nlast" }
    const base = { workspaceId: "second", path: "same.txt", value, onSave: async () => ({ kind: "conflict" as const }), onReload: () => {} }
    const target = { line: 2, column: 4, endLine: 2, endColumn: 10, nonce: "first" }
    const view = render(<SourceFileEditor {...base} navigation={target} />)
    const editor = await screen.findByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement
    expect(editor.selectionStart).toBe(8)
    expect(editor.selectionEnd).toBe(14)
    editor.setSelectionRange(0, 0)
    fireEvent.change(editor, { target: { value: `${editor.value}\nlocal` } })
    expect(editor.selectionStart).toBe(editor.value.length)
    view.rerender(<SourceFileEditor {...base} navigation={target} />)
    expect(editor.selectionStart).toBe(editor.value.length)
    view.rerender(<SourceFileEditor {...base} navigation={{ ...target, nonce: "second" }} />)
    expect(editor.selectionStart).toBe(8)
    expect(editor.value.endsWith("local")).toBe(true)
  })

  it("clamps a stale multiline range to displayed text and keeps a dirty draft", async () => {
    const base = { path: "range.txt", value: { ...source, text: "one\n😀end" }, onSave: async () => ({ kind: "conflict" as const }), onReload: () => {} }
    const view = render(<SourceFileEditor {...base} />)
    const editor = screen.getByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: "one\n😀end\nlocal" } })
    view.rerender(<SourceFileEditor {...base} navigation={{ line: 2, column: 2, endLine: 999, endColumn: 999, nonce: "range" }} />)
    expect(editor.selectionStart).toBe(6)
    expect(editor.selectionEnd).toBe(15)
    expect(editor.value).toBe("one\n😀end\nlocal")
    expect(screen.getByText("搜尋位置來自磁碟；未儲存草稿的位置可能不同。")).toBeTruthy()
  })

  it("shows an external UTF8 read without creating an editable draft or offering save", () => {
    const store = new EditorDraftStore(), ref = { workspaceId: "second", path: "outside-alias.txt" }
    render(<SourceFileEditor {...ref} store={store} value={{ ...source, text: "external UTF8 text", readonly: true, external: true }} onSave={() => { throw new Error("External file must not be saved") }} onReload={() => {}} />)
    expect(screen.getByRole("region", { name: "唯讀檔案預覽" }).textContent).toContain("external UTF8 text")
    expect(screen.queryByRole("textbox", { name: "來源檔案內容" })).toBeNull()
    expect(screen.queryByRole("button", { name: "儲存檔案" })).toBeNull()
    expect(store.get(ref)).toBeUndefined()
  })

  it("preserves and locks an existing dirty draft when its path now resolves to an external read", () => {
    const store = new EditorDraftStore(), ref = { workspaceId: "second", path: "swapped.txt" }, saves: string[] = []
    const props = { ...ref, store, onSave: async (_path: string, text: string) => { saves.push(text); return { kind: "saved" as const, revision: "d".repeat(64), bytes: text.length } }, onReload: () => {} }
    const view = render(<SourceFileEditor {...props} value={source} />)
    const editor = screen.getByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: "my unsaved draft" } })
    view.rerender(<SourceFileEditor {...props} value={{ ...source, text: "outside replacement", revision: "c".repeat(64), readonly: true, external: true }} />)
    expect(editor.value).toBe("my unsaved draft")
    expect(editor.disabled).toBe(true)
    expect((screen.getByRole("button", { name: "儲存檔案" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(editor, { target: { value: "forbidden edit" } })
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true })
    expect(store.get(ref)?.text).toBe("my unsaved draft")
    expect(store.get(ref)?.revision).toBe("a".repeat(64))
    expect(store.get(ref)?.external).toBeUndefined()
    expect(saves).toEqual([])
  })
})
