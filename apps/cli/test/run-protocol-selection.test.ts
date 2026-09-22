import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SessionCoordinator, SessionMeta } from "@i-harness/session-persistence"
import type { ProviderRuntime } from "@i-harness/provider-runtime"
import { runHeadless } from "../src/run.ts"
import { loadProviderRuntime } from "../src/provider-runtime.ts"

/**
 * `runHeadless`'s MODEL-RESOLUTION INPUT — what the caller's selection actually
 * reaches, and what the RUN writes.
 *
 * This file exists because the CLI's routing contract
 * (`run-flag-routing.test.ts`) mocks `run.ts` for its WHOLE file: it can see the
 * task and the options `main` builds, and not one line of what the run does with
 * them — nor one byte the RUN writes. Two measured holes came from exactly that
 * (task-5 review F1, F2):
 *
 *  - F1: deleting the protocol from the composed selection left the ENTIRE suite
 *    green, so `run --protocol P` could silently use the route's own protocol;
 *  - F2: §4.3's byte-identity pin could only see writes made by `main()`, so a
 *    write on the RUN's side ("make the one-shot stick" via setDefaultModel)
 *    would violate the owner's decision with the suite green.
 *
 * No fake runtime, no cast, and no assembly: the resolution is driven through
 * the REAL `loadProviderRuntime()` (the documented `opts.providerRuntime` seam)
 * with a pass-through `vi.spyOn` recorder, and every selection below names a
 * route the empty hermetic config cannot resolve — so the run REFUSES at
 * `if (state.status !== "ready") throw` and never reaches
 * `createSessionAssembly`. That refusal is asserted, not merely relied on: it is
 * what keeps this file cheap and hermetic, and it is also the observable proof
 * that no assembly (and so no durable write) was ever built.
 */

type ResolveInput = Parameters<ProviderRuntime["resolveModel"]>[0]

let configDir: string
let previous: string | undefined

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "i-harness-run-protocol-"))
  previous = process.env.IH_CONFIG_DIR
  process.env.IH_CONFIG_DIR = configDir
})

afterEach(() => {
  vi.restoreAllMocks()
  if (previous === undefined) delete process.env.IH_CONFIG_DIR
  else process.env.IH_CONFIG_DIR = previous
  rmSync(configDir, { recursive: true, force: true })
})

/** The real runtime with a pass-through recorder on `resolveModel`. `vi.spyOn`
 * calls through, so the resolution is the shipped one and the assertion lands on
 * the INPUT it received — the only place "the flag reached the resolution" is
 * observable at all. */
async function runtimeWithRecorder() {
  const { runtime } = await loadProviderRuntime()
  const spy = vi.spyOn(runtime, "resolveModel")
  const received = (): ResolveInput | undefined => spy.mock.calls[0]?.[0]
  return { runtime, spy, received }
}

/** Four methods, and they are the four this path reaches: `profile` answers the
 * durable meta (the only reason a stub is here at all), `close` is what the
 * refusal path's `catch` calls, and `enqueue`/`flush` are the no-ops the
 * session's own event callback would use if a turn ever ran — it does not, the
 * resolution refuses first. The cast is the price of not standing up a real
 * JSONL store for a run that never writes one. */
function coordinatorWithMeta(meta: SessionMeta): SessionCoordinator {
  return {
    profile: async () => ({ meta, blank: false }),
    enqueue: () => {},
    flush: async () => {},
    close: async () => {},
  } as unknown as SessionCoordinator
}

function durableMeta(modelSelection: SessionMeta["modelSelection"]): SessionMeta {
  return {
    formatVersion: 1,
    sessionId: "session-1",
    createdAt: "2026-09-20T00:00:00.000Z",
    ...(modelSelection !== undefined ? { modelSelection } : {}),
  }
}

describe("what the caller's selection reaches in runHeadless", () => {
  it("the caller's selection — protocol included — is what the resolver receives", async () => {
    // F1's pin: this is the feature's only production effect. Delete the
    // protocol from the composed selection and THIS line reds.
    const { runtime, spy, received } = await runtimeWithRecorder()

    const result = await runHeadless("hello", {
      workspace: process.cwd(),
      providerRuntime: runtime,
      sessionSelection: { provider: "gw", model: "m", protocol: "gemini" },
    })

    expect(spy).toHaveBeenCalledTimes(1)
    expect(received()).toEqual({
      sessionSelection: { provider: "gw", model: "m", protocol: "gemini" },
    })
    // The empty hermetic config cannot resolve "gw"; the refusal is what keeps
    // this file assembly-free (and is asserted so a future edit cannot turn an
    // accidental success into a silent pass).
    expect(result.exitCode).toBe(1)
    expect(result.error).toContain(`Unknown provider "gw"`)
  })

  it("a resumed session keeps its provider:model, and the caller's protocol rides on top", async () => {
    const { runtime, received } = await runtimeWithRecorder()

    const result = await runHeadless("hello", {
      workspace: process.cwd(),
      providerRuntime: runtime,
      coordinator: coordinatorWithMeta(
        durableMeta({ provider: "session-route", model: "session-model" }),
      ),
      sessionId: "session-1",
      sessionSelection: { provider: "cli-route", model: "cli-model", protocol: "gemini" },
    })

    // The session's own model survives; the wire is the caller's — the chain's
    // most specific rung (selection > model row > route) is what the caller
    // named, and it is the only half that can change for THIS run.
    expect(received()).toEqual({
      sessionSelection: { provider: "session-route", model: "session-model", protocol: "gemini" },
    })
    expect(result.exitCode).toBe(1)
  })

  it("an unusable durable pair never discards the caller's selection (F3)", async () => {
    // The defect the review found: with an empty durable pair the old guard set
    // the whole thing to `undefined`, so the caller's provider:model AND its
    // protocol were dropped and the run resolved from `llm.defaultModel` — a
    // silent success on a wire nobody named.
    const { runtime, received } = await runtimeWithRecorder()

    const result = await runHeadless("hello", {
      workspace: process.cwd(),
      providerRuntime: runtime,
      coordinator: coordinatorWithMeta(durableMeta({ provider: "", model: "" })),
      sessionId: "session-1",
      sessionSelection: { provider: "cli-route", model: "cli-model", protocol: "gemini" },
    })

    expect(received()).toEqual({
      sessionSelection: { provider: "cli-route", model: "cli-model", protocol: "gemini" },
    })
    expect(result.exitCode).toBe(1)
  })

  it("a caller that named no model at all is passed through, so the chain REFUSES it", async () => {
    // The other half of F3's rule: never dropped. `run --protocol P` with no
    // configured default model reaches the chain as an empty selection and the
    // chain says so — it does not quietly fall through to whatever it finds.
    const { runtime, received } = await runtimeWithRecorder()

    const result = await runHeadless("hello", {
      workspace: process.cwd(),
      providerRuntime: runtime,
      sessionSelection: { provider: "", model: "", protocol: "gemini" },
    })

    expect(received()).toEqual({
      sessionSelection: { provider: "", model: "", protocol: "gemini" },
    })
    expect(result.exitCode).toBe(1)
    expect(result.error).toBe("Session model selection requires provider and model")
  })

  it("§4.3: the RUN writes no settings file — the bytes are identical after it refuses", async () => {
    // F2's pin. `main` cannot write here (it is not in this file's path) — so
    // what this measures is the run's own half: a `runHeadless`-side write
    // (the "make the one-shot stick" mistake) reds HERE and nowhere else.
    const settingsPath = join(configDir, "settings.json")
    writeFileSync(
      settingsPath,
      JSON.stringify({ llm: { defaultModel: { provider: "gw", model: "m" } } }, null, 2) + "\n",
      "utf8",
    )
    const before = readFileSync(settingsPath)
    const { runtime, spy } = await runtimeWithRecorder()

    const result = await runHeadless("hello", {
      workspace: process.cwd(),
      providerRuntime: runtime,
      sessionSelection: { provider: "gw", model: "m", protocol: "gemini" },
    })

    // The run really went through the resolution (or this proves nothing).
    expect(spy).toHaveBeenCalledTimes(1)
    expect(result.exitCode).toBe(1)
    expect(readFileSync(settingsPath).equals(before)).toBe(true)
  })
})
