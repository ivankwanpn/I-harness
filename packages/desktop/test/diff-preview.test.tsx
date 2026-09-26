// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { LightweightDiffPreview } from "../src/renderer/vendor/zcode/LightweightDiffPreview.tsx"
afterEach(cleanup)

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
