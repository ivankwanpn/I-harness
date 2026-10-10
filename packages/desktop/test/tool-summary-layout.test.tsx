// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ActivityGroup } from "../src/renderer/session/ActivityGroup.tsx"
const styles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/renderer/session/tool-output.css"), "utf8")

afterEach(() => { cleanup(); document.querySelector("style[data-tool-summary-test]")?.remove() })

it("keeps the shared group trigger in a spaced flex frame outside an individual tool card", () => {
  const style = document.createElement("style")
  style.setAttribute("data-tool-summary-test", "")
  style.textContent = styles
  document.head.append(style)
  render(<ActivityGroup row={{ id: "g", kind: "activity-group", family: "explore", rows: [{ id: "a", kind: "tool", name: "read" }, { id: "b", kind: "tool", name: "read" }] }} expanded={false} isOpen={() => false} toggle={() => {}} page={0} setPage={() => {}} />)
  const trigger = screen.getByRole("button", { name: "查閱 2" })
  const frame = getComputedStyle(trigger)
  expect(frame.display).toBe("flex")
  expect(frame.gap).toBe("8px")
  expect(frame.alignItems).toBe("center")
  expect(trigger.textContent).toContain("2 項工具")
  expect(screen.queryByRole("button", { name: "工具詳情 read" })).toBeNull()
})
