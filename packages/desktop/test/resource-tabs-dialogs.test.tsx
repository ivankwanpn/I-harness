// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { ResourceTabs } from "../src/renderer/settings/ResourceTabs.tsx"
import type { DesktopBridge } from "../src/shared/bridge.ts"

afterEach(cleanup)
const bridge: DesktopBridge = { request: async request => request.kind === "desktop/resources/list" ? { items: [], total: 0, diagnostics: [] } : undefined, onEvent: () => () => {} }
const request = async () => ({ kind: "conflict" })

it("hides a retained editor while its resource page or tab is inactive and restores its draft", async () => {
  const props = { bridge, workspaceId: "owned", onAuthoringRequest: request, onSelect() {} }
  const view = render(<ResourceTabs {...props} resourceKind="skills" />)
  await screen.findByText("尚未建立技能")
  fireEvent.click(screen.getByRole("button", { name: "建立資源" }))
  fireEvent.change(screen.getByLabelText("完整 Markdown（含 frontmatter）"), { target: { value: "Retained skill draft" } })
  view.rerender(<ResourceTabs {...props} resourceKind="skills" active={false} />)
  expect(screen.queryByRole("dialog")).toBeNull()
  view.rerender(<ResourceTabs {...props} resourceKind="commands" />)
  expect(screen.queryByRole("dialog")).toBeNull()
  view.rerender(<ResourceTabs {...props} resourceKind="skills" />)
  expect((screen.getByLabelText("完整 Markdown（含 frontmatter）") as HTMLTextAreaElement).value).toBe("Retained skill draft")
})
