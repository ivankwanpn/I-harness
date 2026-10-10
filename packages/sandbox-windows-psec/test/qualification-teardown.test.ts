import { expect, it } from "vitest"
import { recordTeardownFailures } from "./qualification-teardown.ts"

it("records each cleanup failure as a failed control before evidence is written", async () => {
  const results: { name: string; outcome: "pass" | "fail" | "unsupported"; detail: unknown }[] = []
  const called: string[] = []
  await recordTeardownFailures(results, [
    { name: "supervisor", dispose: async () => { called.push("supervisor"); throw new Error("supervisor owner retained") } },
    { name: "psec", dispose: async () => { called.push("psec") } },
    { name: "unrestricted", dispose: async () => { called.push("unrestricted"); throw new Error("native owner retained") } },
  ])
  expect(called).toEqual(["supervisor", "psec", "unrestricted"])
  expect(results).toEqual([
    { name: "supervisor-teardown", outcome: "fail", detail: "supervisor owner retained" },
    { name: "unrestricted-teardown", outcome: "fail", detail: "native owner retained" },
  ])
  expect(results.some(result => result.outcome === "fail")).toBe(true)
})

it("waits for supervisor ownership to drain before disposing backends", async () => {
  const results: { name: string; outcome: "pass" | "fail" | "unsupported"; detail: unknown }[] = []
  const called: string[] = []
  let finishSupervisor!: () => void
  const supervisor = new Promise<void>(resolve => { finishSupervisor = resolve })
  const teardown = recordTeardownFailures(results, [
    { name: "supervisor", dispose: () => { called.push("supervisor"); return supervisor } },
    { name: "backend", dispose: async () => { called.push("backend") } },
  ])
  expect(called).toEqual(["supervisor"])
  finishSupervisor()
  await teardown
  expect(called).toEqual(["supervisor", "backend"])
  expect(results).toEqual([])
})
