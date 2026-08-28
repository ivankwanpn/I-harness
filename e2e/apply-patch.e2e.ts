// e2e/apply-patch.e2e.ts — M25 §2.1: the REAL apply_patch tool (M21 patch engine)
// mutating REAL workspace files, driven through the real runHeadless pipeline.
//
// Tool-driving goes through runHeadless + mockScript (see team.e2e.ts for the
// mock-injection ruling: the spawned CLI cannot receive a tool-calling mock —
// mockScript is host-only — so the cassette is injected at the same seam the
// CLI's main() uses; everything else in the pipeline is real).
import { describe, expect, it } from "vitest"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runHeadless } from "../apps/cli/src/run.ts"
import { makeWorkspace, removeWorkspace } from "./helpers.ts"

interface PatchResultEvent {
  type: string
  name?: string
  output?: { ok: boolean; applied: { path: string; action: string }[]; errors: { path: string; message: string }[] }
}

function findPatchResult(result: NonNullable<Awaited<ReturnType<typeof runHeadless>>["session"]>): PatchResultEvent["output"] {
  const event = result.events.find((e) => e.type === "tool/result" && e.name === "apply_patch") as PatchResultEvent | undefined
  return event?.output
}

describe("e2e apply_patch", () => {
  it("lands a real multi-file patch on disk (Add File into a new dir + Update File)", async () => {
    const dir = makeWorkspace("i-harness-e2e-patch-")
    try {
      writeFileSync(join(dir, "notes.md"), "original line\nsecond line\n", "utf8")
      const result = await runHeadless("patch the workspace", {
        workspace: dir,
        approveAll: true,
        mockScript: [
          {
            role: "assistant",
            toolCalls: [
              {
                name: "apply_patch",
                args: {
                  patch_content: [
                    "*** Begin Patch",
                    "*** Add File: src/hello.txt",
                    "+hello from patch",
                    "*** Update File: notes.md",
                    "-original line",
                    "+replacement line",
                    "*** End Patch",
                  ].join("\n"),
                },
              },
            ],
          },
          { role: "assistant", text: "patched" },
        ],
      })
      expect(result.exitCode, result.error).toBe(0)
      const output = findPatchResult(result.session!)
      expect(output?.ok).toBe(true)
      expect(output?.applied).toEqual([
        { path: "src/hello.txt", action: "added" },
        { path: "notes.md", action: "updated" },
      ])
      // REAL disk effects (not just session echoes): the Add created the file
      // inside a NEW directory (atomic write mkdir -p), the Update replaced
      // the old line.
      expect(readFileSync(join(dir, "src", "hello.txt"), "utf8")).toContain("hello from patch")
      const notes = readFileSync(join(dir, "notes.md"), "utf8")
      expect(notes).toContain("replacement line")
      expect(notes).not.toContain("original line")
    } finally {
      removeWorkspace(dir)
    }
  })

  it("reports a context mismatch as ok:false without touching the file (fail-closed, no throw)", async () => {
    const dir = makeWorkspace("i-harness-e2e-patch-")
    try {
      const seed = "original line\nsecond line\n"
      writeFileSync(join(dir, "notes.md"), seed, "utf8")
      const result = await runHeadless("patch the workspace", {
        workspace: dir,
        approveAll: true,
        mockScript: [
          {
            role: "assistant",
            toolCalls: [
              {
                name: "apply_patch",
                args: {
                  patch_content: [
                    "*** Begin Patch",
                    "*** Update File: notes.md",
                    "-this line does not exist",
                    "+never applied",
                    "*** End Patch",
                  ].join("\n"),
                },
              },
            ],
          },
          { role: "assistant", text: "reported" },
        ],
      })
      // apply_patch REPORTS errors instead of throwing — the run completes and
      // the model sees what failed.
      expect(result.exitCode, result.error).toBe(0)
      const output = findPatchResult(result.session!)
      expect(output?.ok).toBe(false)
      expect(output?.applied).toEqual([])
      expect(output?.errors.length).toBe(1)
      expect(output?.errors[0]?.path).toBe("notes.md")
      // REAL disk: nothing changed.
      expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe(seed)
    } finally {
      removeWorkspace(dir)
    }
  })
})
