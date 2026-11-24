import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createDesktopTimingTrace, timingScope } from "../src/timing-trace.ts"

it("records only allowlisted clocks and opaque identities for an actual provider attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-timing-trace-"))
  const file = join(root, "trace.jsonl")
  const trace = createDesktopTimingTrace(root, file)!
  try {
    expect(createDesktopTimingTrace(root, "")).toBeUndefined()
    trace.mark("gateway-received", "private-session", "private-token")
    const request = { requestScope: { sessionId: "private-session", turnId: "private-turn" } }
    const unsent = trace.provider(request)!
    unsent.event({ type: "error", error: new Error("private error") })
    unsent.finish("failed")
    const sent = trace.provider(request)!
    sent.issue()
    sent.issue()
    sent.event({ type: "text/chunk", text: " " })
    sent.event({ type: "text/chunk", text: "private answer" })
    sent.event({ type: "text/chunk", text: "private continuation" })
    trace.mark("tool-start", "private-session")
    sent.finish("completed")
    await trace.close()
    const bytes = await readFile(file, "utf8")
    const marks = bytes.trimEnd().split("\n").map(line => JSON.parse(line))
    expect(marks.map(mark => mark.phase)).toEqual([
      "gateway-received", "provider-issued", "provider-first-event", "provider-first-text", "tool-start", "provider-finished",
    ])
    expect(marks.every(mark => mark.scope === timingScope(root, "private-session"))).toBe(true)
    expect(new Set(marks.flatMap(mark => mark.attempt ? [mark.attempt] : [])).size).toBe(1)
    expect(marks.at(-1).result).toBe("completed")
    expect(bytes).not.toMatch(/private|ih-timing-trace-/)
  } finally { await trace.close(); await rm(root, { recursive: true, force: true }) }
})
