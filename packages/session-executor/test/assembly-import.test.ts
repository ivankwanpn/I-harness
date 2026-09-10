import { describe, expect, it, vi } from "vitest"

describe("session assembly module loading", () => {
  // The assertion is about EAGER NATIVE LOADING, not speed — but the work is
  // two full module-graph loads: the first import, then `resetModules()`
  // (which drops the transform cache) forces the graph to be resolved and
  // transformed again. Measured ~855ms cold on an idle machine; under the
  // full-suite run (70 packages transforming in parallel) that blew through
  // vitest's 5000ms default and reported "Test timed out", which reads like a
  // hang and is not one. 30s is a contention budget, not a tolerance for a
  // real regression — the test still fails fast on an actual error.
  it("does not initialize Windows ACL native types when the assembly is only imported", async () => {
    await import("../src/assembly.ts")
    vi.resetModules()

    await expect(import("../src/assembly.ts")).resolves.toMatchObject({
      createSessionAssembly: expect.any(Function),
    })
  }, 30_000)
})
