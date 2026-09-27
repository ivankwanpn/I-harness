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
  render(<Composer workspaceId="image-w" sessionId="image-s" canSend running={false} imageAttachmentsEnabled onPrompt={onPrompt} onCancel={() => {}} />)
  const file = new File([new Uint8Array([1, 2, 3])], "sample.png", { type: "image/png" })
  fireEvent.change(screen.getByLabelText("選擇圖片"), { target: { files: [file] } })
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
