import { expect, it } from "vitest"
import { prepareTextAttachmentDrafts, readTextAttachmentDrafts, writeTextAttachmentDrafts } from "../src/renderer/session/text-attachment-drafts.ts"

it("rejects oversized text data before changing the scoped attachment draft", () => {
  writeTextAttachmentDrafts("bounded", "a", prepareTextAttachmentDrafts("bounded", "a", [{ name: "small.txt", text: "keep this file" }]))
  expect(() => prepareTextAttachmentDrafts("bounded", "a", [{ name: "large.txt", text: "x".repeat(64 * 1024) }])).toThrow(/64 KB/)
  expect(readTextAttachmentDrafts("bounded", "a").map(({ name, text }) => ({ name, text }))).toEqual([{ name: "small.txt", text: "keep this file" }])
  expect(readTextAttachmentDrafts("bounded", "b")).toEqual([])
})

it("caps the JSON representation so escaped text cannot bypass the context limit", () => {
  expect(() => prepareTextAttachmentDrafts("escaped", "a", [{ name: "escaped.txt", text: "\t".repeat(64 * 1024) }])).toThrow(/64 KB/)
})
