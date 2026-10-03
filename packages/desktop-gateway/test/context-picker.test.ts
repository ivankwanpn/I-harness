import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createWorkspaceReview } from "../src/review.ts"
import { createContextPicker } from "../src/context-picker.ts"
import { createConversationVisibility } from "../src/session-visibility.ts"

it("bounds file previews, reads explicit external aliases without writes, rejects traversal, and reads visible same-project history without activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-context-picker-"))
  const workspace = join(root, "workspace"), outside = join(root, "outside")
  await mkdir(workspace); await mkdir(outside); await writeFile(join(workspace, "notes.md"), "bounded file data"); await writeFile(join(outside, "secret.md"), "secret")
  await symlink(outside, join(workspace, "escape"), "junction")
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  const review = createWorkspaceReview(workspace)
  try {
    await coordinator.create({ sessionId: "public", title: "Project conversation" })
    await coordinator.append("public", [{ type: "user/message", seq: 0, text: "visible body" }, { type: "assistant/message", seq: 1, text: "visible result" }])
    await coordinator.create({ sessionId: "reviewer", origin: "approval-review", title: "Project internal review" })
    await coordinator.create({ sessionId: "foreign", title: "Project foreign" })
    const picker = createContextPicker(workspace, coordinator, review, { visible: createConversationVisibility(coordinator), projectFor: async (id) => id === "foreign" ? "other" : "p" })
    expect((await picker.search({ query: "", contextKind: "files", offset: 0 })).items).toEqual([{ kind: "file", path: "notes.md", label: "notes.md" }])
    expect((await picker.search({ query: "no-match", contextKind: "files", offset: 0 })).items).toEqual([])
    expect(await picker.read({ reference: { kind: "file", workspaceId: "w", path: "notes.md" } })).toMatchObject({ text: "bounded file data" })
    await expect(picker.read({ reference: { kind: "file", workspaceId: "w", path: "../outside/secret.md" } })).rejects.toThrow()
    expect(await review.file("escape/secret.md")).toMatchObject({ kind: "text", readonly: true, external: true })
    expect(await picker.read({ reference: { kind: "file", workspaceId: "w", path: "escape/secret.md" } })).toMatchObject({ text: "secret", truncated: false })
    expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("secret")
    expect((await picker.search({ query: "Project", contextKind: "sessions", projectId: "p", offset: 0 })).items.map((item: any) => item.sessionId)).toEqual(["public"])
    expect((await picker.search({ query: "visible result", contextKind: "sessions", projectId: "p", offset: 0 })).items).toContainEqual({ kind: "session", sessionId: "public", seq: 1, label: "Project conversation", excerpt: "visible result" })
    expect((await picker.read({ projectId: "p", reference: { kind: "session", workspaceId: "w", sessionId: "public", seq: 1 } })).text).toContain("visible result")
    for (const id of ["foreign", "reviewer"]) await expect(picker.read({ projectId: "p", reference: { kind: "session", workspaceId: "w", sessionId: id, seq: 0 } })).rejects.toThrow(/project/)
    await expect(picker.search({ query: "", contextKind: "files", offset: -1 })).rejects.toThrow()
  } finally { await review.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
