import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSession, type Session, type SessionEvent } from "@i-harness/core-session"
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import { createMockClient, type MockStep } from "@i-harness/llm-mock"
import { SKILL_MENTION_PLUGIN } from "@i-harness/skills"
import { createSessionAssembly } from "../src/assembly.ts"
import { rmWorkspaceSync } from "./helpers.ts"

// M6 batch C, C2 (spec 2026-09-21-m6-breadth-design §3.2): the `$name` sigil,
// end to end through the REAL assembly. The scanner's own unit test
// (packages/skills/test/mention.test.ts) calls it directly; what only this file
// can show is the WIRING — the registry the tools read is the registry the scan
// reads, the boundary is `agent/pre-step`, and the artifact is one plain-text
// user/message in the session log.
//
// Three properties are only observable here:
//   - ONE line per task, not per step: `agent/pre-step` fires at every step
//     boundary, so a per-step producer would append the same sentence again for
//     every tool round-trip in the turn;
//   - the SAME turn's first request already carries it: the append happens
//     inside the emit that core-agent performs BEFORE deriveMessages
//     (core-agent/src/index.ts:275), so a single-step turn — the common case —
//     sees the pointer at all;
//   - NOTHING runs by itself: the line is a pointer, and no `skill_get` call is
//     ever made on the model's behalf.

/** The mock client is a one-shot cassette with no request recorder; this wraps
 * it with the recorder (assembly.test.ts's `capturingModel` contract) while
 * keeping the mock's own turn-per-stream semantics. */
function recordingModel(script: MockStep[]): ModelClient & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = []
  const cassette = createMockClient(script.slice())
  return {
    requests,
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      requests.push(request)
      yield* cassette.stream(request)
    },
  }
}

/** The string contents of a request's messages, in order. */
function texts(request: LLMRequest): string[] {
  return request.messages.flatMap((m) => (typeof m.content === "string" ? [m.content] : []))
}

/** The mention lines on the log — the ONLY thing this feature writes. */
function mentionLines(session: Session): string[] {
  return session.events
    .filter(
      (e): e is Extract<SessionEvent, { type: "user/message" }> =>
        e.type === "user/message" && e.source?.kind === "plugin" && e.source.plugin === SKILL_MENTION_PLUGIN,
    )
    .map((e) => e.text)
}

/** Every tool the session actually CALLED, in order. */
function toolNames(session: Session): string[] {
  return session.events
    .filter((e): e is Extract<SessionEvent, { type: "tool/call" }> => e.type === "tool/call")
    .map((e) => e.name)
}

/** The registry scans `<root>/skills/<dir>/SKILL.md`. */
function writeSkill(root: string, name: string, description: string): void {
  mkdirSync(join(root, "skills", name), { recursive: true })
  writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`)
}

const MENTION = `[skill mention] Load the "hello" skill(s) with skill_get before proceeding.`

describe("the `$name` sigil through the assembly (M6 C2)", () => {
  it("appends exactly ONE internal line per task — across steps and across a repeated turn — and the same step's request carries it", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ih-assembly-mention-"))
    const home = mkdtempSync(join(tmpdir(), "ih-assembly-mention-home-"))
    const previousHome = process.env.IH_CONFIG_DIR
    writeSkill(ws, "hello", "Greet the user")
    // The global skills root is a real directory on the machine running this
    // test; `$IH_CONFIG_DIR` is this repo's isolation contract (e2e/helpers.ts:29).
    process.env.IH_CONFIG_DIR = home
    // The OUTER finally owns the env var, not just the assertions: a mount that
    // throws must not leave this worker pinned to a temp home the inner cleanup
    // then deletes (skills-section.test.ts's rule).
    try {
      const session = createSession()
      const model = recordingModel([
        // turn 1, step 1: a real tool call, so the turn has a SECOND step —
        // which is where a per-step producer would write a second line.
        { role: "assistant", toolCalls: [{ name: "list_dir", args: { path: "." } }] },
        // turn 1, step 2
        { role: "assistant", text: "done" },
        // turn 2, same task string (one step)
        { role: "assistant", text: "again" },
        // turn 3, a task naming nothing
        { role: "assistant", text: "plain" },
      ])
      const assembly = await createSessionAssembly({
        workspace: ws,
        session,
        model,
        approveAll: true,
      })
      try {
        await assembly.agent.run("please $hello")
        expect(model.requests).toHaveLength(2) // two steps ⇒ two request boundaries
        // …and the second step is a real continuation: the scripted tool call ran.
        expect(toolNames(session)).toEqual(["list_dir"])
        // "the message only tells the model to load the skill": the mention
        // appended a line and called NOTHING on the model's behalf.
        expect(toolNames(session)).not.toContain("skill_get")
        expect(mentionLines(session)).toEqual([MENTION])
        // Harness bookkeeping, not something the user typed (M59's internal
        // flag, the same one every runtime-context snapshot carries).
        const line = session.events.find(
          (e) => e.type === "user/message" && e.source?.kind === "plugin" && e.source.plugin === SKILL_MENTION_PLUGIN,
        )
        expect(line).toMatchObject({
          type: "user/message",
          internal: true,
          source: { kind: "plugin", plugin: SKILL_MENTION_PLUGIN },
        })
        // …and it is written BEFORE the step's request is derived: the FIRST
        // request of the turn already carries the pointer.
        expect(texts(model.requests[0]!)).toContain(MENTION)

        // A second turn with the SAME task string: zero new lines (a repeated
        // task was already answered, and re-answering it would append one
        // identical sentence per turn for the rest of the session).
        await assembly.agent.run("please $hello")
        expect(mentionLines(session)).toEqual([MENTION])

        // A task with no hits: zero.
        await assembly.agent.run("no sigils here")
        expect(mentionLines(session)).toEqual([MENTION])
      } finally {
        await assembly.dispose()
      }
    } finally {
      if (previousHome === undefined) delete process.env.IH_CONFIG_DIR
      else process.env.IH_CONFIG_DIR = previousHome
      rmWorkspaceSync(ws)
      rmWorkspaceSync(home)
    }
  }, 30_000)

  it("appends nothing when the sigil names no registered skill", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ih-assembly-mention-unknown-"))
    const home = mkdtempSync(join(tmpdir(), "ih-assembly-mention-unknown-home-"))
    const previousHome = process.env.IH_CONFIG_DIR
    // A skill IS registered: the miss below is membership, not an empty
    // catalogue (an unregistered name is a miss even when its neighbours are
    // real).
    writeSkill(ws, "hello", "Greet the user")
    process.env.IH_CONFIG_DIR = home
    try {
      const session = createSession()
      const model = recordingModel([{ role: "assistant", text: "ok" }])
      const assembly = await createSessionAssembly({ workspace: ws, session, model, approveAll: true })
      try {
        await assembly.agent.run("please $unknown")
        expect(mentionLines(session)).toEqual([])
        // Nothing mention-shaped reached the model either — of any name, not
        // just the one this test's task spelled.
        expect(texts(model.requests[0]!).some((t) => t.startsWith("[skill mention]"))).toBe(false)
      } finally {
        await assembly.dispose()
      }
    } finally {
      if (previousHome === undefined) delete process.env.IH_CONFIG_DIR
      else process.env.IH_CONFIG_DIR = previousHome
      rmWorkspaceSync(ws)
      rmWorkspaceSync(home)
    }
  }, 30_000)
})
