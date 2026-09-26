import { describe, expect, it } from "vitest"
import { pendingForSession, removePending, upsertPending } from "../src/renderer/interaction/pending.ts"
import type { PendingInteraction } from "../src/renderer/interaction/pending.ts"

function approval(requestId: string, sessionId = "s1"): PendingInteraction {
  return { requestId, sessionId, kind: "approval", payload: { name: "write", reason: "edit one file" }, openedAt: 1 }
}

describe("pending interaction list", () => {
  it("upserts by request id, keeps arrival order, and filters by session", () => {
    let list: PendingInteraction[] = []
    list = upsertPending(list, approval("r1"))
    list = upsertPending(list, approval("r2"))
    list = upsertPending(list, { ...approval("r1"), payload: { name: "write", reason: "edit again" } })
    list = upsertPending(list, approval("r3", "s2"))

    expect(list.map((row) => row.requestId)).toEqual(["r1", "r2", "r3"])
    expect(list[0]?.payload).toEqual({ name: "write", reason: "edit again" })
    expect(pendingForSession(list, "s1").map((row) => row.requestId)).toEqual(["r1", "r2"])
    expect(pendingForSession(list, undefined).map((row) => row.requestId)).toEqual(["r1", "r2", "r3"])
  })

  it("removes a settled request and ignores an unknown one", () => {
    const list = [approval("r1"), approval("r2")]

    expect(removePending(list, "r1").map((row) => row.requestId)).toEqual(["r2"])
    expect(removePending(list, "missing").map((row) => row.requestId)).toEqual(["r1", "r2"])
    expect(list.map((row) => row.requestId)).toEqual(["r1", "r2"])
  })
})
