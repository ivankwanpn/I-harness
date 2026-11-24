// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ProjectGitPane } from "../src/renderer/review/ProjectGitPane.tsx"
import type { DesktopRequest } from "../src/shared/bridge.ts"
import type { ModelReviewJob } from "@i-harness/desktop-gateway/src/model-review-contract.ts"

afterEach(cleanup)

it("captures a selected Git scope, reopens the saved model result, and locates the finding in the original excerpt", async () => {
  const workspace = { id: "folder", path: "D:/review/fixture", label: "repo" }
  const project = { id: "project", name: "Project", workspaceIds: [workspace.id], primaryWorkspaceId: workspace.id, createdAt: "2026-11-24", updatedAt: "2026-11-24" }
  const prepared: ModelReviewJob = {
    id: "review-id", status: "prepared", startedAt: "2026-11-24T00:00:00Z",
    snapshot: {
      fingerprint: "fixed", capturedAt: "2026-11-24T00:00:00Z", target: { kind: "base", branch: "main" },
      head: "abcd", base: "1234", end: "abcd", listingTruncated: false,
      files: [{ path: "test.txt", layer: "committed", disposition: "text", text: "+original line\n+incorrect output" }],
    },
  }
  const completed: ModelReviewJob = {
    ...prepared, status: "completed",
    result: { summary: "Review summary", findings: [{ file: 0, line: 2, title: "Incorrect output", detail: "Fix the returned value." }] },
  }
  const request = vi.fn(async (input: DesktopRequest) => {
    switch (input.kind) {
      case "projects/list": return [project]
      case "workspace/list": return [workspace]
      case "desktop/review/changes": return { kind: "ok", files: [], truncated: false }
      case "desktop/model-review/list": return []
      case "desktop/model-review/prepare": return prepared
      case "desktop/model-review/start": return { ...prepared, status: "running" }
      case "desktop/model-review/read": return completed
      case "desktop/model-review/compare": return { current: false }
      default: throw new Error("Unexpected request")
    }
  })
  render(<ProjectGitPane bridge={{ request, onEvent: () => () => {} }} project={project} workspaces={[workspace]} initialMode="review" />)
  fireEvent.change(await screen.findByLabelText("審查目標"), { target: { value: "base" } })
  fireEvent.change(screen.getByRole("textbox", { name: "分支名稱" }), { target: { value: "main" } })
  fireEvent.click(screen.getByRole("button", { name: "擷取變更" }))
  expect(request).toHaveBeenCalledWith({ kind: "desktop/model-review/prepare", workspaceId: workspace.id, projectId: project.id, target: { kind: "base", branch: "main" } })
  fireEvent.click(await screen.findByRole("button", { name: "開始審查" }))
  await screen.findByText("Review summary", {}, { timeout: 3000 })
  expect(await screen.findByText("目前變更與這次審查的快照不同。")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: /Incorrect output/ }))
  expect(screen.getByText("+incorrect output").closest("li")?.classList.contains("highlighted")).toBe(true)
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "desktop/review/file/save" }))
})
