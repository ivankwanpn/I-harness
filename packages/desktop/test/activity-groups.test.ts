import { expect, it } from "vitest"
import { groupActivities } from "../src/renderer/session/activity-groups.ts"
it("groups consecutive same-family tools with a stable first-call identity and respects message boundaries", () => {
  const read = { id: "a", kind: "tool" as const, name: "read" }
  const list = { ...read, id: "b", name: "list_dir" }
  const message = { id: "c", kind: "message" as const, role: "assistant" as const, text: "Next step" }
  const first = groupActivities([read, list])
  expect(first).toEqual([{ id: "activity:a", kind: "activity-group", family: "explore", rows: [read, list] }])
  expect(groupActivities([read, list, { ...read, id: "d" }])[0]!.id).toBe(first[0]!.id)
  expect(groupActivities([read, message, list])).toEqual([read, message, list])
  expect(groupActivities([{ ...read, groupScope: "turn:1" }, { ...list, groupScope: "turn:2" }])).toHaveLength(2)
})
