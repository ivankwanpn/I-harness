import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../src/index.ts"
import { parseHeader } from "../src/format.ts"

describe("updateMeta/profile (R-C5)", () => {
  it("rewrites the header atomically and reads it header-only", async () => {
    const coordinator = createSessionCoordinator(createJsonlBackend(mkdtempSync(join(tmpdir(), "ih-meta-"))))
    const { id } = await coordinator.create()
    await coordinator.append(id, [
      { type: "user/message", text: "hi" },
      { type: "turn/start" },
    ])
    const meta = await coordinator.updateMeta(id, { title: "T" })
    expect(meta.title).toBe("T")
    const profile = await coordinator.profile(id)
    expect(profile.meta.title).toBe("T")
    expect(profile.blank).toBe(false)
    const meta2 = await coordinator.updateMeta(id, { modelSelection: { provider: "p", model: "m" } })
    expect(meta2.modelSelection).toEqual({ provider: "p", model: "m" })
    // a later load/read keeps the header values (no repair strip); the
    // synthetic turn/end closer is the pre-existing repair behavior for a
    // log left inside a turn.
    const { session } = await coordinator.load(id)
    expect(session.events.map((e) => e.type)).toEqual(["user/message", "turn/start", "turn/end"])
    const profile2 = await coordinator.profile(id)
    expect(profile2.meta.modelSelection).toEqual({ provider: "p", model: "m" })
    expect(profile2.meta.title).toBe("T")
    await coordinator.close()
  })

  it("a blank session profiles blank; appended turn/start flips it", async () => {
    const coordinator = createSessionCoordinator(createJsonlBackend(mkdtempSync(join(tmpdir(), "ih-meta-"))))
    const { id } = await coordinator.create()
    expect((await coordinator.profile(id)).blank).toBe(true)
    await coordinator.append(id, [{ type: "turn/start" }])
    expect((await coordinator.profile(id)).blank).toBe(false)
    await coordinator.close()
  })

  it("invalid modelSelection is dropped (never a corrupt decode)", async () => {
    const coordinator = createSessionCoordinator(createJsonlBackend(mkdtempSync(join(tmpdir(), "ih-meta-"))))
    const { id } = await coordinator.create()
    await coordinator.updateMeta(id, { modelSelection: { provider: "p", model: "" } })
    const profile = await coordinator.profile(id)
    expect(profile.meta.modelSelection).toBeUndefined()
    await coordinator.close()
  })
})

describe("parseHeader modelSelection protocol (protocol-selection §2)", () => {
  it("a header carrying a protocol keeps it through parse, and drops a bad one", () => {
    // The repair/read path rewrites the header line. A field the parser does
    // not know is a field the rewrite SILENTLY DELETES — the session would come
    // back resolving on a different wire than the one it was told to use.
    const meta = parseHeader(JSON.stringify({
      formatVersion: 1, sessionId: "s1",
      modelSelection: { provider: "gateway", model: "m", protocol: "anthropic-messages", reasoningEffort: "high" },
    }))
    expect(meta.modelSelection).toEqual({
      provider: "gateway", model: "m", protocol: "anthropic-messages", reasoningEffort: "high",
    })

    // Structurally invalid is DROPPED, not passed through — the same rule the
    // rest of this parser already applies to provider/model.
    const bad = parseHeader(JSON.stringify({
      formatVersion: 1, sessionId: "s1",
      modelSelection: { provider: "gateway", model: "m", protocol: "not-a-protocol" },
    }))
    expect(bad.modelSelection).toEqual({ provider: "gateway", model: "m" })
  })

  it("a protocol survives a real header rewrite (updateMeta), not just a parse", async () => {
    const coordinator = createSessionCoordinator(createJsonlBackend(mkdtempSync(join(tmpdir(), "ih-meta-"))))
    const { id } = await coordinator.create()
    await coordinator.updateMeta(id, {
      modelSelection: { provider: "gateway", model: "m", protocol: "anthropic-messages" },
    })
    // A title rename rewrites line 0 (parse → merge → serialize). A field the
    // parser does not carry would be gone after this call — the exact silent
    // deletion the parse tests above guard, measured on the real rewrite path.
    await coordinator.updateMeta(id, { title: "renamed" })
    const profile = await coordinator.profile(id)
    expect(profile.meta.modelSelection).toEqual({
      provider: "gateway", model: "m", protocol: "anthropic-messages",
    })
    expect(profile.meta.title).toBe("renamed")
    await coordinator.close()
  })
})
