// G1 (M43): the rewind binder state machine (fake BackendClient) + the keymap
// routing (dispatchKey with overlay "rewind") + the embedded bridge extension
// (mapSessionEvent rewind/point + the conditional rewind member over a fake
// assembly.rewind + the mock factory's no-member fallback).

import { describe, expect, it, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { createSession } from "@i-harness/core-session"
import { RewindStore } from "@i-harness/rewind"
import type { RewindMode, RewindPlan, RewindPointSummary, RewindResult } from "@i-harness/rewind"
import type { SessionService } from "@i-harness/session-executor"
import { bindRewindOverlay, isRewindOverlay } from "../src/app/overlay-seam.ts"
import type { RewindState } from "../src/views/rewind.ts"
import { dispatchKey } from "../src/app/keys.ts"
import type { Kbd, KeymapState } from "../src/app/keys.ts"
import {
  createEmbeddedBackend,
  createEventMapState,
  defaultEmbeddedFactory,
  mapSessionEvent,
} from "../src/backend/embedded.ts"
import type { BackendClient } from "../src/contracts.ts"

const utf8 = (s: string) => new TextEncoder().encode(s)
const H = (s: string) => createHash("sha256").update(utf8(s)).digest("hex")

const sleepMicro = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const cleanups: string[] = []
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "ih-tui-rewind-"))
  cleanups.push(d)
  return d
}

// ------------------------------------------------------------------ fake backend

interface FakeRewindCalls {
  points: number
  plan: Array<[number, RewindMode]>
  execute: Array<[number, RewindMode]>
  cancels: number
}

function fakeBackend(opts: {
  points?: RewindPointSummary[] | Promise<RewindPointSummary[]>
  plan?: RewindPlan
  running?: boolean
  executeResult?: RewindResult
} = {}): { client: BackendClient; state: RewindState; calls: FakeRewindCalls } {
  const calls: FakeRewindCalls = { points: 0, plan: [], execute: [], cancels: 0 }
  const points: Array<RewindPointSummary> = [
    { turnIndex: 0, preview: "Write hello", files: 2 },
    { turnIndex: 1, preview: "Chat only", files: 0 },
  ]
  const plan: RewindPlan = {
    target: 0,
    mode: "all",
    clean: [{ path: "src/a.txt", kind: "restore-blob", blobId: "b" }],
    conflicts: [{ path: "keep.txt", kind: "modified" }],
    unTracked: [],
    ops: [{ path: "src/a.txt", kind: "restore-blob", blobId: "b" }],
  }
  const result: RewindResult = {
    target: 0,
    mode: "all",
    revertedFiles: 1,
    conflicts: [],
    errors: [],
    truncated: true,
    eventAppended: true,
  }
  const client: BackendClient = {
    listSessions: async () => [],
    open: async () => {},
    submit: async () => {},
    steer: async () => {},
    cancel: async () => {
      calls.cancels++
    },
    events: async function* () {},
    seqCursor: () => -1,
    replay: async () => [],
    status: () => ({ running: opts.running === true, queued: 0 }),
    close: async () => {},
    rewind: {
      points: async () => {
        calls.points++
        return opts.points ?? points
      },
      plan: async (target, mode) => {
        calls.plan.push([target, mode])
        return opts.plan ?? { ...plan, target, mode }
      },
      execute: async (target, mode) => {
        calls.execute.push([target, mode])
        return opts.executeResult ?? { ...result, target, mode }
      },
    },
  }
  const state: RewindState = { phase: "loading", points: [], cursor: 0, cleanPaths: [], conflicts: [] }
  return { client, state, calls }
}

// ------------------------------------------------------------------ binder machine

describe("bindRewindOverlay — phase machine", () => {
  it("loading → points() → picker", async () => {
    const { client, state } = fakeBackend()
    bindRewindOverlay(state, { backend: client })
    expect(state.phase).toBe("loading")
    await sleepMicro()
    expect(state.phase).toBe("picker")
    expect(state.points).toHaveLength(2)
    expect(state.cursor).toBe(0)
  })

  it("picker accept (idle) → mode-select, selectedTurn set", async () => {
    const { client, state } = fakeBackend()
    const seam = bindRewindOverlay(state, { backend: client })
    await sleepMicro()
    seam.act!("overlay-select")
    expect(state.phase).toBe("mode-select")
    expect(state.selectedTurn).toBe(0)
    // nav within mode rows (3 rows) then accept a row → plan
    seam.act!("overlay-nav-next")
    expect(state.cursor).toBe(1)
  })

  it("running turn → cancel-offer; y cancels + proceeds; n lets it finish", async () => {
    // y branch: "Cancel turn and rewind" → backend.cancel() + mode-select.
    const a = fakeBackend({ running: true })
    const aSeam = bindRewindOverlay(a.state, { backend: a.client })
    await sleepMicro()
    aSeam.act!("overlay-select")
    expect(a.state.phase).toBe("cancel-offer")
    expect(a.state.cancelOfferTarget).toBe(0)
    aSeam.act!("rewind-y")
    expect(a.calls.cancels).toBe(1)
    expect(a.state.phase).toBe("mode-select")

    // n branch: "Let it finish" → the flow ends (onClose), the turn runs on.
    const b = fakeBackend({ running: true })
    let closed = 0
    const bSeam = bindRewindOverlay(b.state, { backend: b.client, onClose: () => { closed++ } })
    await sleepMicro()
    bSeam.act!("overlay-select")
    expect(b.state.phase).toBe("cancel-offer")
    bSeam.act!("rewind-n")
    expect(closed).toBe(1)
    expect(b.calls.cancels).toBe(0) // never cancelled
  })

  it("mode a → planning → plan(target, mode) → confirm rows", async () => {
    const { client, state, calls } = fakeBackend()
    const seam = bindRewindOverlay(state, { backend: client })
    await sleepMicro()
    seam.act!("overlay-select")
    seam.act!("rewind-a")
    expect(state.phase).toBe("planning")
    expect(state.mode).toBe("all")
    await sleepMicro()
    expect(state.phase).toBe("confirm")
    expect(calls.plan).toEqual([[0, "all"]])
    expect(state.cleanPaths).toEqual(["src/a.txt"])
    expect(state.conflicts).toEqual([{ path: "keep.txt", kind: "modified" }])
  })

  it("mode b → conversation; mode f disabled when the target recorded no files", async () => {
    const { client, state } = fakeBackend()
    const seam = bindRewindOverlay(state, { backend: client })
    await sleepMicro()
    seam.act!("overlay-nav-next") // cursor → turn 1 (files 0)
    seam.act!("overlay-select")
    seam.act!("rewind-f") // disabled — no-op
    expect(state.phase).toBe("mode-select")
    seam.act!("rewind-b")
    expect(state.mode).toBe("conversation")
    await sleepMicro()
    expect(state.phase).toBe("confirm")
    expect(state.cleanPaths).toEqual(["src/a.txt"]) // fake plan (mode-agnostic)
    expect(state.conflicts).toEqual([{ path: "keep.txt", kind: "modified" }])
  })

  it("confirm y → executing → execute() → onDecision({target, mode, result}) + close", async () => {
    const { client, state, calls } = fakeBackend({ running: false })
    const decisions: unknown[] = []
    let closed = 0
    const seam = bindRewindOverlay(state, { backend: client, onDecision: (d) => decisions.push(d), onClose: () => { closed++ } })
    await sleepMicro()
    seam.act!("overlay-select")
    seam.act!("rewind-a")
    await sleepMicro()
    // a deferred execute so the in-flight window is observable
    let release!: (r: RewindResult) => void
    client.rewind!.execute = (target, mode) => {
      calls.execute.push([target, mode])
      return new Promise((resolve) => { release = resolve })
    }
    seam.act!("rewind-y") // confirm phase → execute
    expect(state.phase).toBe("executing")
    // Esc during "Rewinding..." is a no-op (the execute is in flight)
    seam.act!("overlay-dismiss")
    expect(closed).toBe(0)
    release({ target: 0, mode: "all", revertedFiles: 1, conflicts: [], errors: [], truncated: true, eventAppended: true })
    await sleepMicro()
    expect(decisions).toEqual([{ target: 0, mode: "all", result: expect.objectContaining({ target: 0, mode: "all", truncated: true }) }])
    expect(calls.execute).toEqual([[0, "all"]])
    expect(closed).toBe(1) // decision → close
  })

  it("confirm Bksp → mode-select; mode-select Bksp → picker (cursor restored)", async () => {
    const { client, state } = fakeBackend()
    const seam = bindRewindOverlay(state, { backend: client })
    await sleepMicro()
    seam.act!("overlay-select")
    seam.act!("rewind-a")
    await sleepMicro()
    seam.act!("rewind-back")
    expect(state.phase).toBe("mode-select")
    seam.act!("rewind-back")
    expect(state.phase).toBe("picker")
    expect(state.cursor).toBe(0) // the picked row
  })

  it("error path: points/plan/execute rejections land phase error + msg; Esc dismiss", async () => {
    // points() rejection → error right at the loader
    const failing = fakeBackend()
    failing.client.rewind!.points = async () => {
      throw new Error("journal corrupt")
    }
    const st: RewindState = { phase: "loading", points: [], cursor: 0, cleanPaths: [], conflicts: [] }
    let closed = 0
    const seam = bindRewindOverlay(st, { backend: failing.client, onClose: () => { closed++ } })
    await sleepMicro()
    expect(st.phase).toBe("error")
    expect(st.error).toBe("journal corrupt")
    seam.act!("overlay-dismiss")
    expect(closed).toBe(1)

    // plan rejection — drive the machine: pick → mode → a → plan() throws
    const p = fakeBackend()
    p.client.rewind!.plan = async () => {
      throw new Error("plan blown up")
    }
    const pState: RewindState = { phase: "loading", points: [], cursor: 1, cleanPaths: [], conflicts: [] }
    const pSeam = bindRewindOverlay(pState, { backend: p.client })
    await sleepMicro()
    pSeam.act!("overlay-select")
    pSeam.act!("rewind-a")
    await sleepMicro()
    expect(pState.phase).toBe("error")
    expect(pState.error).toBe("plan blown up")

    // execute rejection — confirm → y → execute() throws
    const e = fakeBackend()
    e.client.rewind!.execute = async () => {
      throw new Error("disk write failed")
    }
    const eState: RewindState = { phase: "loading", points: [], cursor: 0, cleanPaths: [], conflicts: [] }
    const eSeam = bindRewindOverlay(eState, { backend: e.client })
    await sleepMicro()
    eSeam.act!("overlay-select")
    eSeam.act!("rewind-b")
    await sleepMicro()
    eSeam.act!("rewind-y")
    await sleepMicro()
    expect(eState.phase).toBe("error")
    expect(eState.error).toBe("disk write failed")
  })

  it("backend without a rewind member → bind error phase (honest, sync)", () => {
    const bare = fakeBackend()
    delete bare.client.rewind
    const st: RewindState = { phase: "loading", points: [], cursor: 0, cleanPaths: [], conflicts: [] }
    bindRewindOverlay(st, { backend: bare.client })
    expect(st.phase).toBe("error") // no async hop — the gate is local
    expect(st.error).toContain("rewind is not enabled")
  })

  it("seam carries the runtime rewind kind + the isRewindOverlay probe", async () => {
    const { client, state } = fakeBackend()
    const seam = bindRewindOverlay(state, { backend: client })
    expect(isRewindOverlay(seam)).toBe(true)
    expect((seam as { kind: string }).kind).toBe("rewind")
    // non-rewind seams hop past the probe
    expect(isRewindOverlay({ kind: "permission", draw: () => {} })).toBe(false)
  })
})

// ------------------------------------------------------------------ keymap routing

const kbd = (partial: Partial<Kbd>): Kbd => ({
  code: "char",
  key: "",
  ctrl: false,
  alt: false,
  shift: false,
  ...partial,
})
const letter = (key: string): Kbd => kbd({ code: "char", key })

describe("dispatchKey — rewind overlay/escape routing", () => {
  const ovState = (partial: Partial<KeymapState> = {}): KeymapState => ({
    focused: "prompt",
    promptText: "",
    multiLine: false,
    turnRunning: false,
    armedQuit: false,
    searchActive: false,
    ...partial,
  })

  it("overlay kind rewind: y/n/a/b/f/Bksp/Esc/j/k route to rewind actions", () => {
    const s = ovState({ overlay: "rewind" })
    expect(dispatchKey(letter("y"), s)).toBe("rewind-y")
    expect(dispatchKey(letter("n"), s)).toBe("rewind-n")
    expect(dispatchKey(letter("a"), s)).toBe("rewind-a")
    expect(dispatchKey(letter("b"), s)).toBe("rewind-b")
    expect(dispatchKey(letter("f"), s)).toBe("rewind-f")
    expect(dispatchKey(kbd({ code: "Backspace", key: "Backspace" }), s)).toBe("rewind-back")
    expect(dispatchKey(kbd({ code: "Esc", key: "Esc" }), s)).toBe("overlay-dismiss")
    expect(dispatchKey(letter("j"), s)).toBe("overlay-nav-prev")
    expect(dispatchKey(kbd({ code: "Up", key: "ArrowUp" }), s)).toBe("overlay-nav-prev")
    expect(dispatchKey(kbd({ code: "Enter", key: "Enter" }), s)).toBe("overlay-select")
    // no digit accept on rewind rows; generic letters keep their old meaning
    expect(dispatchKey(letter("1"), s)).toBe("none")
    expect(dispatchKey(letter("k"), s)).toBe("overlay-nav-next")
  })

  it("empty-prompt Esc: rewind arm (toastable) → armed second opens; quit arm fallback", () => {
    const avail = ovState({ rewindAvailable: true })
    expect(dispatchKey(kbd({ code: "Esc", key: "Esc" }), avail)).toBe("rewind-arm1")
    expect(dispatchKey(kbd({ code: "Esc", key: "Esc" }), ovState({ rewindAvailable: true, rewindArmed: true }))).toBe("rewind-open")
    // no rewind → the pre-M43 quit arm stays
    expect(dispatchKey(kbd({ code: "Esc", key: "Esc" }), ovState())).toBe("quit-arm1")
    // non-empty prompt still clears the draft
    expect(dispatchKey(kbd({ code: "Esc", key: "Esc" }), ovState({ promptText: "x" }))).toBe("cancel-turn")
  })
})

// ------------------------------------------------------------------ embedded bridge

describe("mapSessionEvent — rewind/point → TuiEvent rewind", () => {
  it("maps targetTurn/mode with the event seq", () => {
    const state = createEventMapState()
    const mapped = mapSessionEvent({
      type: "rewind/point", version: 1, targetTurn: 3, anchorSeq: 10,
      mode: "files", fileOps: [{ path: "a.txt", op: "restore" }], seq: 21,
    } as never, state)
    expect(mapped).toEqual({ type: "rewind", targetTurn: 3, mode: "files", seq: 21, ts: expect.any(Number) })
  })
})

describe("createEmbeddedBackend — the conditional rewind member", () => {
  it("rewindWorkspace present → member over assembly.rewind: points/plan/execute with a REAL store", async () => {
    const root = tmp()
    const ws = tmp()
    const session = createSession()
    const store = new RewindStore({ root, sessionId: "s1" })
    const blobId = await store.writeBlob(utf8("hello"))
    await store.appendPoint({
      turnIndex: 0,
      anchorSeq: 0,
      promptPreview: "write hello",
      files: [{ path: "a.txt", status: "modified", preBlob: blobId, isNewFile: false, afterHash: H("goodbye") }],
    })
    await writeFile(join(ws, "a.txt"), "goodbye")
    const svc = {
      assemblyFor: async () => ({ session, rewind: { store, recorder: {} } }),
    } as unknown as SessionService
    const backend = createEmbeddedBackend({ service: svc, sessionId: "s1", rewindWorkspace: ws })

    expect(backend.rewind).toBeDefined()
    const points = await backend.rewind!.points()
    expect(points).toEqual([{ turnIndex: 0, preview: "write hello", files: 1 }])
    const plan = await backend.rewind!.plan(0, "all")
    expect(plan.clean).toEqual([{ path: "a.txt", kind: "restore-blob", blobId }])
    expect(plan.conflicts).toEqual([])
    const result = await backend.rewind!.execute(0, "all")
    expect(result.truncated).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.revertedFiles).toBe(1)
    // the disk came back to the pre-image content (the real store blob)
    expect(await readFile(join(ws, "a.txt"), "utf-8")).toBe("hello")
    // the rewind/point marker landed in the live session log (event stream)
    expect(session.events.some((e) => e.type === "rewind/point")).toBe(true)
  })

  it("no workspace → no member; workspace + handle-less assembly → loud error", async () => {
    const svc = { assemblyFor: async () => ({ session: createSession() }) } as unknown as SessionService
    const bare = createEmbeddedBackend({ service: svc, sessionId: "s1" })
    expect(bare.rewind).toBeUndefined()

    const handleLess = createEmbeddedBackend({ service: svc, sessionId: "s1", rewindWorkspace: tmp() })
    await expect(handleLess.rewind!.points()).rejects.toThrow("rewind not enabled on this session")
  })

  it("defaultEmbeddedFactory: mock (no store root) → no member; with root → member, [] points", async () => {
    const mock = await defaultEmbeddedFactory({ workspace: tmp(), prompt: "hi" })
    expect(mock.rewind).toBeUndefined()
    const withStore = await defaultEmbeddedFactory({ workspace: tmp(), prompt: "hi", rewindStoreRoot: tmp() })
    expect(withStore.rewind).toBeDefined()
    expect(await withStore.rewind!.points()).toEqual([])
  })
})
