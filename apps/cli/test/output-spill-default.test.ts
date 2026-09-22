import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveShell } from "@i-harness/shell"
import { runHeadless } from "../src/run.ts"

// The guard's ONLY production mount. `createOutputSpillGuard` had tests since
// M26 and no caller anywhere: `assembly.ts` mounts it on `if (opts.outputSpill)`
// and nothing passed one, so a 200 KB tool result reached the session log whole.
// This test drives the REAL run.ts wiring — the default lives in the call, not
// in the assembly, so a change that drops it must redden HERE and nowhere else.
describe("output spill — the guard is mounted by default", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-output-spill-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("a result past the shipped 64,000-byte cap comes back bounded, and an under-cap one untouched", async () => {
    const shell = resolveShell().name
    const result = await runHeadless("run two commands", {
      workspace: dir,
      approveAll: true,
      mockScript: [
        { role: "assistant", toolCalls: [{ name: shell, args: { command: "node -e \"process.stdout.write('y'.repeat(200000))\"" } }] },
        { role: "assistant", toolCalls: [{ name: shell, args: { command: "node -e \"process.stdout.write('small')\"" } }] },
        { role: "assistant", text: "done" },
      ],
    })
    expect(result.exitCode).toBe(0)
    const results = result.session!.events.filter((e) => e.type === "tool/result") as Array<{
      output: { stdout?: string; output?: string; outputPaths?: string[]; spill?: unknown }
    }>
    expect(results).toHaveLength(2)
    const [big, small] = results

    // THE ASSERTION THAT MATTERS: the 200 KB result is the guard's envelope.
    // Without the default mount this is the raw `{ stdout: "yyy…", stderr,
    // exitCode }` — the whole payload in the durable record and in the prompt.
    expect(big!.output.spill).toBeDefined()
    expect(big!.output.output).toContain("Full result stored at:")
    // ... and the replacement is within the SHIPPED cap, in the same measure the
    // guard itself uses (no `images` here, so the model-visible text of the
    // envelope is its JSON).
    expect(Buffer.byteLength(JSON.stringify(big!.output), "utf-8")).toBeLessThanOrEqual(64_000)

    // The control in the same run: under the cap, byte-identical — the mount
    // BOUNDS results rather than rewriting them.
    expect(small!.output.stdout).toBe("small")
    expect(small!.output.spill).toBeUndefined()
  })
})
