import { expect, it } from "vitest"
import type { SessionEventView } from "@i-harness/core-session"
import { completedTurnPrefix } from "../src/fork.ts"

const view = (events: Array<Record<string, unknown>>) => events as unknown as SessionEventView[]

it("rejects an atSeq beyond the last event instead of forking the whole history", () => {
  const events = view([
    { type: "turn/start", seq: 0 },
    { type: "user/message", text: "hi", seq: 1 },
    { type: "turn/end", seq: 2 },
    { type: "turn/start", seq: 3 },
  ])
  expect(() => completedTurnPrefix(events, "s", 100)).toThrow(/beyond this session's last event/)
})

it("still reports an unfinished in-range turn", () => {
  const events = view([
    { type: "turn/start", seq: 0 },
    { type: "user/message", text: "hi", seq: 1 },
    { type: "turn/end", seq: 2 },
    { type: "turn/start", seq: 3 },
  ])
  expect(() => completedTurnPrefix(events, "s", 3)).toThrow(/has not completed the turn/)
})

it("cuts at the first completed turn at or after atSeq", () => {
  const events = view([
    { type: "turn/start", seq: 0 },
    { type: "user/message", text: "hi", seq: 1 },
    { type: "turn/end", seq: 2 },
    { type: "turn/start", seq: 3 },
  ])
  expect(completedTurnPrefix(events, "s", 0)).toHaveLength(3)
})
