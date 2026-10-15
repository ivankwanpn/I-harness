import { expect, it } from "vitest"
import * as persistence from "../src/index.ts"
import { projectConversation, type SessionEvent } from "@i-harness/core-session"

const source: SessionEvent[] = [
  { type: "conversation/semantics", version: 1, mode: "accepted-exchange-v1", seq: 10 },
  { type: "turn/start", seq: 11 }, { type: "step/start", actionId: "a", attemptId: "p", seq: 12 },
  { type: "tool/call", callId: "c", name: "write", args: {}, seq: 13 }, { type: "assistant/message", text: "", seq: 14 },
  { type: "model/exchange-accepted", version: 1, exchangeId: "e", actionId: "a", attemptId: "p", stepStartSeq: 12, assistantSeq: 14, callSeqs: [13], seq: 15 },
  { type: "tool/dispatch", callId: "c", eventSeq: 13, seq: 16 },
]
it("restores a sliced-away fence and remaps all accepted coordinates", () => {
  expect(typeof persistence.remapConversationSeed).toBe("function")
  const snapshot = JSON.stringify(source)
  const result = persistence.remapConversationSeed({ sourceFormat: 4, source, retained: source.slice(1) })
  expect(result.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
  expect(result[0]?.type).toBe("conversation/semantics")
  expect(result[5]).toMatchObject({ stepStartSeq: 2, assistantSeq: 4, callSeqs: [3] })
  expect(result[6]).toMatchObject({ eventSeq: 3 })
  expect(result[5]).not.toMatchObject({ exchangeId: "e" })
  expect(JSON.stringify(source)).toBe(snapshot)
})
it("rejects a partial accepted bundle before creating a child", () => {
  expect(typeof persistence.remapConversationSeed).toBe("function")
  expect(() => persistence.remapConversationSeed({ sourceFormat: 4, source, retained: source.filter(event => event.seq !== 13) })).toThrow(persistence.SessionForkUnavailableError)
})
it("keeps failed unaccepted observations fenced and inherited", () => {
  expect(typeof persistence.remapConversationSeed).toBe("function")
  const failed = [...source.slice(0, 5), { type: "step/failed", seq: 15 }] as SessionEvent[]
  const seed = persistence.remapConversationSeed({ sourceFormat: 4, source: failed, retained: failed.slice(1) })
  expect(seed[0]?.type).toBe("conversation/semantics")
  expect(projectConversation({ formatVersion: 3, events: seed }).items.every(item => !item.exchange)).toBe(true)
})
it("converts old human admissions to inherited observations", () => {
  const legacy: SessionEvent[] = [{ type: "agent/input/admitted", version: 1, inputId: "u", text: "request", delivery: "queue", intent: "user", provenance: { kind: "human", authority: "request", scope: "turn", producer: "cli.prompt" }, seq: 0 }]
  expect(typeof persistence.remapConversationSeed).toBe("function")
  expect(persistence.remapConversationSeed({ sourceFormat: 4, source: legacy, retained: legacy })[0]).toMatchObject({ provenance: { kind: "inherited", authority: "observation" } })
})
it("keeps empty and legacy-only seeds fence-free", () => {
  expect(persistence.remapConversationSeed({ sourceFormat: 4, source: [], retained: [] })).toEqual([])
  const legacy: SessionEvent[] = [{ type: "user/message", text: "old", seq: 20 }]
  expect(persistence.remapConversationSeed({ sourceFormat: 4, source: legacy, retained: legacy })).toEqual([{ type: "user/message", text: "old", seq: 0, provenance: { kind: "inherited", authority: "observation", scope: "turn", producer: "session.seed" } }])
})
it("keeps a legacy prefix and inserts exactly one fence before its explicit region", () => {
  const mixed: SessionEvent[] = [{ type: "user/message", text: "legacy", seq: 0 }, ...source]
  const seed = persistence.remapConversationSeed({ sourceFormat: 4, source: mixed, retained: mixed.filter(event => event.type !== "conversation/semantics") })
  expect(seed.map(event => event.type)).toEqual(["user/message", "conversation/semantics", "turn/start", "step/start", "tool/call", "assistant/message", "model/exchange-accepted", "tool/dispatch"])
  expect(seed[6]).toMatchObject({ stepStartSeq: 3, assistantSeq: 5, callSeqs: [4] })
})
it("materializes a missing image admission and remaps multiple marker references", () => {
  const image = { mediaType: "image/png" as const, dataBase64: "AQID" }
  const original: SessionEvent[] = [
    { type: "agent/input/admitted", version: 1, inputId: "image", text: "look", delivery: "queue", intent: "user", images: [image], seq: 0 },
    { type: "user/message", text: "look", imageInputId: "image", seq: 10 },
    { type: "compaction/summary", text: "summary", shadowedSeqs: [10, 99], seq: 11 },
    { type: "compaction/reset", removedSeqs: [10, 99], seq: 12 },
    { type: "session/title", title: "title", source: "user", messageSeqs: [10, 99], seq: 13 },
    { type: "rewind/point", version: 1, targetTurn: 1, anchorSeq: 10, mode: "conversation", fileOps: [], seq: 14 },
  ]
  const seed = persistence.remapConversationSeed({ sourceFormat: 4, source: original, retained: original.slice(1) })
  expect(seed[0]).toMatchObject({ images: [image], seq: 0 }); expect(seed[0]).not.toHaveProperty("imageInputId")
  expect(seed[1]).toMatchObject({ shadowedSeqs: [0] }); expect(seed[2]).toMatchObject({ removedSeqs: [0] })
  expect(seed[3]).toMatchObject({ messageSeqs: [0] }); expect(seed[4]).toMatchObject({ anchorSeq: 0 })
  expect(original[1]).toHaveProperty("imageInputId", "image")
})
it("rejects a retained dispatch without its accepted bundle using the public fork error", () => {
  expect(() => persistence.remapConversationSeed({ sourceFormat: 4, source, retained: source.slice(6) })).toThrow(persistence.SessionForkUnavailableError)
})
it("does not let the isolated legacy remapper imply an accepted semantics seed", () => {
  const map = new Map(source.map((event, index) => [event.seq!, index]))
  expect(() => persistence.remapSeedEvent(source[5]!, 5, map)).toThrow(persistence.SessionForkUnavailableError)
})
