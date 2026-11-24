// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Composer, captureSessionSubmission, consumeSessionSubmission, retireSessionDraft, writeDraft, readDraft, draftKey, type ComposerProps } from "../src/renderer/session/Composer.tsx"
import { writeFileReferences, readFileReferences } from "../src/renderer/session/file-reference-drafts.ts"
import { writeImageDrafts, readImageDrafts } from "../src/renderer/session/image-drafts.ts"
import { writeTextAttachmentDrafts, readTextAttachmentDrafts } from "../src/renderer/session/text-attachment-drafts.ts"
import type { DraftRequest, DurableDraft } from "../src/shared/attachment-drafts.ts"
afterEach(() => { cleanup(); localStorage.clear() })
it("assigns an attachment edit a new token and ignores the previous receipt", () => {
  const workspace = "attachment-edit", session = "submission"
  const first = captureSessionSubmission(workspace, session, "continue", "queue")
  writeFileReferences(workspace, session, ["changed.ts"])
  const edited = captureSessionSubmission(workspace, session, "continue", "queue")
  expect(edited.token).not.toBe(first.token)
  consumeSessionSubmission(workspace, session, first.token)
  expect(captureSessionSubmission(workspace, session, "continue", "queue").token).toBe(edited.token)
})
it("restores the established input's token before retry, then starts a new identical draft", async () => {
  const workspace = "input-restart", session = "restored"
  const original = { token: "original-retry-token", text: "continue", delivery: "queue" }
  let record: DurableDraft = { revision: "1", draft: { prompt: "continue", references: ["file.txt"], images: [], texts: [], contextRefs: [], metadata: JSON.stringify(original) } }
  let revision = 1
  const draftRequest = async (r: DraftRequest): Promise<DurableDraft> => {
    if (r.kind === "desktop/draft/load") return structuredClone(record)
    expect(r.expectedRevision).toBe(record.revision)
    return record = { revision: String(++revision), draft: r.kind === "desktop/draft/save" ? structuredClone(r.draft) : null }
  }
  const tokens: string[] = []
  const onPrompt: ComposerProps["onPrompt"] = async (text, context, _images, admit, captured) => {
    expect(text).toBe("continue")
    const token = captured!.token
    tokens.push(token)
    expect(JSON.parse(record.draft!.metadata!).token).toBe(token)
    if (tokens.length === 1) {
      expect(context).toContain("file.txt")
      throw Error("lost receipt")
    }
    if (tokens.length === 2) expect(context).toContain("file.txt")
    await admit!(() => consumeSessionSubmission(workspace, session, token))
  }
  render(<Composer workspaceId={workspace} sessionId={session} draftRequest={draftRequest} canSend running={false}
    captureSubmission={(text, _images, delivery) => captureSessionSubmission(workspace, session, text, delivery)} onPrompt={onPrompt} onCancel={() => {}} />)
  const editor = screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement
  const send = () => fireEvent.keyDown(editor, { key: "Enter" })
  await waitFor(() => expect(editor.value).toBe("continue"))
  send()
  await waitFor(() => { expect(tokens.length).toBe(1); expect(editor.value).toBe("continue") })
  send()
  await waitFor(() => { expect(tokens.length).toBe(2); expect(record.draft?.metadata).toBeUndefined() })
  expect(tokens).toEqual([original.token, original.token])
  fireEvent.change(editor, { target: { value: "continue" } })
  send()
  await waitFor(() => expect(tokens.length).toBe(3))
  expect(tokens[2]).not.toBe(original.token)
})
it("removes exactly a retired session's renderer draft copies and leaves siblings/new-task/editor data", () => {
  const w = "delete-w", s = "delete-s"
  writeDraft(w, s, "secret"); writeDraft(w, "sibling", "keep"); writeDraft(w, "new-task:unassigned", "new task")
  writeFileReferences(w, s, ["file.txt"]); writeImageDrafts(w, s, [{ id: 1, mediaType: "image/png", dataBase64: "AQID" }]); writeTextAttachmentDrafts(w, s, [{ id: 2, name: "a.txt", text: "secret" }])
  localStorage.setItem(`${draftKey(w, s)}:context-references`, "secret refs"); localStorage.setItem(`${draftKey(w, s)}:submission`, "secret metadata"); localStorage.setItem("ih:editor-draft", "editor")
  retireSessionDraft(w, s)
  expect(readDraft(w, s)).toBe(""); expect(readFileReferences(w, s)).toEqual([]); expect(readImageDrafts(w, s)).toEqual([]); expect(readTextAttachmentDrafts(w, s)).toEqual([])
  expect(localStorage.getItem(`${draftKey(w, s)}:context-references`)).toBeNull(); expect(localStorage.getItem(`${draftKey(w, s)}:submission`)).toBeNull()
  expect(readDraft(w, "sibling")).toBe("keep"); expect(readDraft(w, "new-task:unassigned")).toBe("new task"); expect(localStorage.getItem("ih:editor-draft")).toBe("editor")
  writeDraft(w, s, "late prompt"); writeFileReferences(w, s, ["late.txt"]); writeImageDrafts(w, s, [{ id: 3, mediaType: "image/png", dataBase64: "AQID" }]); writeTextAttachmentDrafts(w, s, [{ id: 4, name: "late.txt", text: "late" }])
  expect(readDraft(w, s)).toBe(""); expect(readFileReferences(w, s)).toEqual([]); expect(readImageDrafts(w, s)).toEqual([]); expect(readTextAttachmentDrafts(w, s)).toEqual([])
})
it.each(["prompt", "references"])("reports a failed renderer %s persisted-key removal and permits exact cleanup retry", group => {
  const workspace = `cleanup-error-${group}`, session = "session"
  writeDraft(workspace, session, "persisted secret"); writeFileReferences(workspace, session, ["secret.txt"])
  const key = group === "prompt" ? draftKey(workspace, session) : `ih:file-references:${JSON.stringify([workspace, session])}`
  const remove = Storage.prototype.removeItem
  const fail = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, current: string) { if (current === key) throw new Error("storage removal failed"); remove.call(this, current) })
  expect(() => retireSessionDraft(workspace, session)).toThrow(/Renderer draft cleanup failed.*storage removal failed/)
  expect(localStorage.getItem(key)).not.toBeNull()
  fail.mockRestore(); retireSessionDraft(workspace, session)
  expect(localStorage.getItem(key)).toBeNull()
})
it("restores a main-owned image/text/reference draft and shows document truncation", async () => {
  const record: DurableDraft = { revision: "disk-revision", draft: { prompt: "restart draft", references: ["src/readme.md"], images: [{ id: 10, mediaType: "image/png", dataBase64: "AQID", name: "restored.png" }], texts: [{ id: 11, name: "restored.pdf", text: "readable marker", contentType: "application/pdf", truncated: true, reason: "page limit" }], contextRefs: [] } }
  const draftRequest = vi.fn(async () => record)
  render(<Composer workspaceId="restore-w" sessionId="restore-s" canSend running={false} onPrompt={async () => {}} onCancel={() => {}} draftRequest={draftRequest} fileReferencesEnabled imageAttachmentsEnabled />)
  await screen.findByText("restored.png"); expect(screen.getByText("src/readme.md")).toBeTruthy()
  expect((screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement).value).toBe("restart draft")
  expect(screen.getByTitle("application/pdf").textContent).toContain("PDF"); expect(screen.getByText(/page limit/)).toBeTruthy()
})
it("reports persistence failure while retaining typed input and an attachment", async () => {
  const draftRequest = async (request: DraftRequest): Promise<DurableDraft> => { if (request.kind === "desktop/draft/load") return { revision: null, draft: null }; throw new Error("quota exceeded") }
  const bridge = { request: async () => ({ paths: [], images: [], texts: [{ name: "keep.txt", text: "keep" }] }), onEvent: () => () => {} }
  render(<Composer workspaceId="quota-w" sessionId="quota-s" canSend running={false} onPrompt={async () => {}} onCancel={() => {}} draftRequest={draftRequest} bridge={bridge} fileReferencesEnabled />)
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "keep typed draft" } }); fireEvent.click(screen.getByRole("button", { name: "新增附件" }))
  await screen.findByText("keep.txt"); await screen.findByText(/quota exceeded/)
  expect((screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement).value).toBe("keep typed draft")
})
it("clears persisted payload only after admission and retains it after failed submission", async () => {
  let record: DurableDraft = { revision: null, draft: null }, revision = 0, clears = 0
  const draftRequest = async (request: DraftRequest): Promise<DurableDraft> => { if (request.kind === "desktop/draft/load") return record; expect(request.expectedRevision).toBe(record.revision); if (request.kind === "desktop/draft/clear") { clears++; return record = { revision: String(++revision), draft: null } }; return record = { revision: String(++revision), draft: request.draft } }
  const onPrompt = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined)
  render(<Composer workspaceId="admit-w" sessionId="admit-s" canSend running={false} onPrompt={onPrompt} onCancel={() => {}} draftRequest={draftRequest} />)
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "admit me" } }); await waitFor(() => expect((screen.getByRole("button", { name: "送出" }) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "送出" }) as HTMLButtonElement).disabled).toBe(false)); expect(screen.queryByText("offline")).toBeNull(); expect(clears).toBe(0); expect(record.draft?.prompt).toBe("admit me")
  fireEvent.click(screen.getByRole("button", { name: "送出" })); await waitFor(() => expect(clears).toBe(1))
  await waitFor(() => expect((screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement).value).toBe(""))
  expect(record.draft?.prompt ?? "").toBe("")
})
