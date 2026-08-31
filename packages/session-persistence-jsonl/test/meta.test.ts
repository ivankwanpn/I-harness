import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../src/index.ts"

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
