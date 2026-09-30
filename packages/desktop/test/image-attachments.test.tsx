// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Composer } from "../src/renderer/session/Composer.tsx"
import { addImageFiles, readImageDrafts, writeImageDrafts } from "../src/renderer/session/image-drafts.ts"

afterEach(() => { cleanup(); localStorage.clear() })

it("accepts ten small images and rejects an eleventh without changing the draft", async () => {
  const scope = ["image-limit-w", "image-limit-s"] as const
  const files = Array.from({ length: 10 }, (_, index) => new File([new Uint8Array([index + 1])], `picture-${index}.png`, { type: "image/png" }))
  await addImageFiles(...scope, files)
  expect(readImageDrafts(...scope)).toHaveLength(10)
  await expect(addImageFiles(...scope, [new File(["x"], "eleventh.png", { type: "image/png" })])).rejects.toThrow("10")
  expect(readImageDrafts(...scope)).toHaveLength(10)
  writeImageDrafts(...scope, [])
})

it("sends a selected image as model input and retains it after a failed send", async () => {
  const onPrompt = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined)
  const request = vi.fn(async () => ({ paths: [], images: [{ mediaType: "image/png", dataBase64: "AQID", name: "sample.png" }], texts: [] }))
  render(<Composer workspaceId="image-w" sessionId="image-s" bridge={{ request, onEvent: () => () => {} }} canSend running={false} imageAttachmentsEnabled onPrompt={onPrompt} onCancel={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "新增附件" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "workspace/attachments/pick", workspaceId: "image-w", allowImages: true }))
  await screen.findByText("sample.png")
  const sendButton = screen.getByRole("button", { name: "送出" }) as HTMLButtonElement
  await waitFor(() => expect(sendButton.disabled).toBe(false))
  fireEvent.click(sendButton)
  await screen.findByText("offline")
  expect(screen.getByText("sample.png")).toBeTruthy()
  expect(onPrompt).toHaveBeenCalledWith("請查看附加的圖片。", undefined, [{ mediaType: "image/png", dataBase64: "AQID", name: "sample.png" }], expect.any(Function))
  await waitFor(() => expect(sendButton.disabled).toBe(false))
  fireEvent.click(sendButton)
  await waitFor(() => expect(screen.queryByText("sample.png")).toBeNull())
})

it("keeps image paste and removal available with the unified attachment chooser", async () => {
  const scope = ["image-paste-menu", "image-paste-menu"] as const
  render(<Composer workspaceId={scope[0]} sessionId={scope[1]} canSend running={false} imageAttachmentsEnabled onPrompt={async () => {}} onCancel={() => {}} />)
  const file = new File([new Uint8Array([4, 5, 6])], "pasted.png", { type: "image/png" })
  fireEvent.paste(screen.getByRole("textbox", { name: "提示" }), { clipboardData: { files: [file] } })
  await screen.findByText("pasted.png")
  fireEvent.click(screen.getByRole("button", { name: "移除圖片 pasted.png" }))
  expect(screen.queryByText("pasted.png")).toBeNull()
  expect(readImageDrafts(...scope)).toEqual([])
  expect((screen.getByRole("button", { name: "送出" }) as HTMLButtonElement).disabled).toBe(true)
})
