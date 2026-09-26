// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { LightweightDiffPreview } from "../src/renderer/vendor/zcode/LightweightDiffPreview.tsx"
afterEach(cleanup)

it("bounds rendered rows while keeping middle content reachable through sections", () => {
  const text = '@@ -0,0 +1,2000 @@\n' + Array.from({ length: 2000 }, (_, index) => `+line${index}`).join('\n')
  const view = render(<LightweightDiffPreview text={text} />)
  expect(view.container.querySelectorAll("code").length).toBeLessThanOrEqual(800)
  expect(screen.getByText(/預覽略去/)).toBeTruthy()
  expect(screen.queryByText("+line1000")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "逐段瀏覽差異" }))
  const scroller = view.container.querySelector<HTMLDivElement>("[data-lightweight-diff-preview]")!
  scroller.scrollTop = 500
  fireEvent.click(screen.getByRole("button", { name: "下一段" }))
  expect(scroller.scrollTop).toBe(0)
  expect(screen.getByText("+line1000")).toBeTruthy()
  expect(view.container.querySelectorAll("code").length).toBeLessThanOrEqual(800)
})

it("distinguishes file headers from source lines that start with repeated plus signs", () => {
  render(<LightweightDiffPreview text={'--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+++counter;'} />)
  expect(screen.getByText("+++ b/file.js").parentElement?.getAttribute("style")).toBeNull()
  expect(screen.getByText("+++counter;").parentElement?.getAttribute("style")).toContain("--color-diff-added")
  expect(screen.getByText("-old").parentElement?.getAttribute("style")).toContain("--color-diff-removed")
})

it("keeps raw diff text as text, including HTML-like content", () => {
  const view = render(<LightweightDiffPreview text={'@@ -0,0 +1 @@\n+<script>alert(1)</script>'} />)
  expect(view.container.querySelector("script")).toBeNull()
  expect(screen.getByText('+<script>alert(1)</script>')).toBeTruthy()
})
