// M49 Task 14: slash command run() units against the recording fixture —
// table-driven literal-call tests (the contract the loop's SlashContext must
// satisfy), argument-validation tests, capability-gated behavior, /help
// dynamic rows, and the eco inventories' configured/mounted/failed/unavailable
// states (row builders + a real hooks-config scan).

import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WorkflowSurface } from "../src/contracts.ts"
import type { SlashContext } from "../src/app/slash/types.ts"
import { nextTheme } from "../src/app/slash/impl/visual.ts"
import { pluginRows, marketplaceRows } from "../src/views/light-plugins.ts"
import { mcpsRows } from "../src/views/light-mcps.ts"
import { hooksRows } from "../src/views/light-hooks.ts"
import { HOOK_EVENTS } from "@i-harness/hooks"
import { recordingSlashContext, runSlash } from "./slash-fixtures.ts"

describe("slash commands — literal call contracts (recording ctx)", () => {
  it.each([
    ["/new", "createSession"],
    ["/dashboard", "dashboard"],
    ["/queue", "queue"],
    ["/tasks", "tasks"],
    ["/settings", "openSettings"],
    ["/copy", "copy"],
  ] as const)("%s invokes %s", async (input, expected) => {
    const ctx = recordingSlashContext()
    await runSlash(input, ctx)
    expect(ctx.calls).toEqual([expected])
  })

  it("nextTheme cycles system → … → system (pure)", () => {
    expect(nextTheme("system")).toBe("grok-night")
    expect(nextTheme("grok-night")).toBe("grok-day")
    expect(nextTheme("grok-day")).toBe("tokyo-night")
    expect(nextTheme("tokyo-night")).toBe("rose-pine-moon")
    expect(nextTheme("rose-pine-moon")).toBe("oscura-midnight")
    expect(nextTheme("oscura-midnight")).toBe("system")
  })
})

describe("slash commands — capability gates (spec §10.2)", () => {
  it("/plan //view-plan //auto //always-approve are gated — the run states the live backend requirement (never the M46a UI-state fake)", async () => {
    // The recording fixture carries the capabilities (the commands run); the
    // real loop supplies none (plan-mode/guardian absent) — the registry
    // tests cover visibility. The run body must NOT mutate UI state.
    const p = recordingSlashContext()
    await runSlash("/plan", p)
    expect(p.calls).toContain("toast:plan: live backend switching capability not wired")
    const vp = recordingSlashContext()
    await runSlash("/view-plan", vp)
    expect(vp.calls).toContain("toast:plan: live backend switching capability not wired")
    const a = recordingSlashContext()
    await runSlash("/auto", a)
    expect(a.calls).toContain("toast:always-approve: live guardian capability not wired")
    expect(a.calls).not.toContain("setAutoApprove:true")
    const aa = recordingSlashContext()
    await runSlash("/always-approve", aa)
    expect(aa.calls).toContain("toast:always-approve: live guardian capability not wired")
  })

  it("/rewind and /context run through their gated seams (the recording ctx carries every capability; hidden-otherwise is the registry's job)", async () => {
    const rw = recordingSlashContext()
    await runSlash("/rewind", rw)
    expect(rw.calls).toEqual(["openRewind"])
    const ctx = recordingSlashContext()
    await runSlash("/context", ctx)
    expect(ctx.calls).toEqual(["context"])
  })
})

describe("slash commands — state-changing units (recording ctx)", () => {
  it("/theme (bare) cycles; /theme <kind> sets; /theme unknown toasts", async () => {
    const ctx = recordingSlashContext()
    await runSlash("/theme", ctx)
    expect(ctx.calls).toContain("setTheme:grok-night")
    expect(ctx.calls.some((c) => c.startsWith("toast:theme:"))).toBe(true)
    const ctx2 = recordingSlashContext()
    await runSlash("/theme grok-day", ctx2)
    expect(ctx2.calls).toContain("setTheme:grok-day")
    const ctxAuto = recordingSlashContext()
    await runSlash("/theme auto", ctxAuto)
    expect(ctxAuto.calls).toContain("setTheme:system")
    const ctx3 = recordingSlashContext()
    await runSlash("/theme nonsense", ctx3)
    expect(ctx3.calls.some((c) => c.startsWith("toast:theme: unknown"))).toBe(true)
    expect(ctx3.calls).not.toContain("setTheme:nonsense")
  })

  it("/timestamps /multiline /compact-mode flip state", async () => {
    const ctx = recordingSlashContext()
    await runSlash("/timestamps", ctx)
    expect(ctx.calls).toContain("setTimestamps:true")
    const ctx2 = recordingSlashContext()
    await runSlash("/multiline", ctx2)
    expect(ctx2.calls).toContain("setMultiline:true")
    const ctx3 = recordingSlashContext()
    await runSlash("/compact-mode", ctx3)
    expect(ctx3.calls).toContain("setCompactMode:true")
  })

  it("/timeline toggles the rail state on the real app state", async () => {
    const ctx = recordingSlashContext()
    await runSlash("/timeline", ctx)
    expect((ctx.app as unknown as { showTimeline?: boolean }).showTimeline).toBe(true)
    expect(ctx.calls).toContain("toast:timeline on")
    const ctx2 = recordingSlashContext()
    await runSlash("/timeline", ctx2)
    await runSlash("/timeline", ctx2)
    expect((ctx2.app as unknown as { showTimeline?: boolean }).showTimeline).toBe(false)
    expect(ctx2.calls).toContain("toast:timeline off")
  })

  it("/find activates search (+ prefills the pattern); /history the panel; /resume the picker", async () => {
    const ctx = recordingSlashContext()
    await runSlash("/find", ctx)
    expect(ctx.calls).toContain("startSearch")
    const ctx2 = recordingSlashContext()
    await runSlash("/history", ctx2)
    expect(ctx2.calls).toContain("openHistoryPanel")
    const ctx3 = recordingSlashContext()
    await runSlash("/resume", ctx3)
    expect(ctx3.calls).toContain("openSessions")
  })

  it("/home → welcome; /quit → quitApp; /copy → the copy seam", async () => {
    const ctx = recordingSlashContext()
    await runSlash("/home", ctx)
    expect(ctx.calls).toEqual(["setScreen:welcome"])
    const ctx2 = recordingSlashContext()
    await runSlash("/quit", ctx2)
    expect(ctx2.calls).toEqual(["quitApp"])
    const ctx3 = recordingSlashContext()
    await runSlash("/copy", ctx3)
    expect(ctx3.calls).toEqual(["copy"])
  })

  it("/compact calls the backend seam with the instruction arg", async () => {
    const ctx = recordingSlashContext()
    await runSlash("/compact some instructions", ctx)
    expect(ctx.calls).toEqual(["compact:some instructions", "toast:compacted"])
  })

  it("/rewind opens the picker; /btw <q> steers; /btw opens the input", async () => {
    const ctx = recordingSlashContext()
    await runSlash("/rewind", ctx)
    expect(ctx.calls).toEqual(["openRewind"])
    const ctx2 = recordingSlashContext()
    await runSlash("/btw explain this", ctx2)
    expect(ctx2.calls).toEqual(["btw:explain this"])
    const ctx3 = recordingSlashContext()
    await runSlash("/btw", ctx3)
    expect(ctx3.calls).toEqual(["btwInput"])
  })

  it("/new creates a session (no confirm panel — the backend owns create)", async () => {
    const ctx = recordingSlashContext()
    await runSlash("/new", ctx)
    expect(ctx.calls).toEqual(["createSession"])
  })

  it("/jump lists engine anchors; Enter selects → jump", async () => {
    const ctx = recordingSlashContext()
    let sel: ((i: number) => void) | undefined
    ctx.openPanel = (req) => { sel = req.onSelect; ctx.calls.push(`panel:${req.kind}`) }
    await runSlash("/jump", ctx)
    expect(ctx.calls).toContain("panel:jump")
    sel?.(0)
    expect(ctx.calls).toContain("gotoLine:0")
  })

  it("/rename <title> renames; empty opens the text-input overlay", async () => {
    const ctx = recordingSlashContext()
    await runSlash("/rename my title", ctx)
    expect(ctx.calls).toEqual(["renameSession:my title"])
    const ctx2 = recordingSlashContext()
    await runSlash("/rename", ctx2)
    expect((ctx2.app as { overlay?: unknown }).overlay).toBeDefined()
    expect(ctx2.calls).not.toContain("renameSession:")
  })

  it("/session-info opens the meta panel (backend.context through the recorder)", async () => {
    const ctx = recordingSlashContext()
    await runSlash("/session-info", ctx)
    expect(ctx.calls.some((c) => c.startsWith("panel:session-info"))).toBe(true)
  })

  it("/usage opens the local context meter (self-labeled this-session)", async () => {
    const ctx = recordingSlashContext()
    await runSlash("/usage", ctx)
    expect(ctx.calls.some((c) => c.startsWith("panel:usage:Usage"))).toBe(true)
    expect(ctx.calls.some((c) => c.includes("this session"))).toBe(true)
  })

  it("/goal opens the goal panel; /tutorial lists topics then swaps", async () => {
    const ctx = recordingSlashContext()
    ctx.openPanel = (req) => { ctx.calls.push(`panel:goal-${req.kind}:${req.title}`) }
    await runSlash("/goal", ctx)
    expect(ctx.calls.some((c) => c.startsWith("panel:goal-goal:"))).toBe(true)
    const t = recordingSlashContext()
    let tsel: ((i: number) => void) | undefined
    t.openPanel = (req) => { tsel = req.onSelect; t.calls.push(`panel:${req.kind}:${req.title}:${req.rows.length}`) }
    await runSlash("/tutorial", t)
    expect(t.calls.some((c) => c.startsWith("panel:tutorial:Tutorial:4"))).toBe(true)
    tsel?.(0)
    expect(t.calls.some((c) => c.startsWith("panel:tutorial:Tutorial — terminal setup:"))).toBe(true)
  })

  it("/doctor runs the live probe seam", async () => {
    const ctx = recordingSlashContext()
    await runSlash("/doctor", ctx)
    expect(ctx.calls.some((c) => c.startsWith("panel:doctor"))).toBe(true)
    expect(ctx.calls).toContain("probeReport")
  })

  it("/provider //model forward the arg to the modal seams", async () => {
    const ctx = recordingSlashContext()
    await runSlash("/provider", ctx)
    expect(ctx.calls).toEqual(["provider"])
    const ctx2 = recordingSlashContext()
    await runSlash("/provider add local", ctx2)
    expect(ctx2.calls).toEqual(["provider:add local"])
    const ctx3 = recordingSlashContext()
    await runSlash("/model deepseek-v3", ctx3)
    expect(ctx3.calls).toEqual(["model:deepseek-v3"])
  })
})

describe("slash commands — argument validation", () => {
  it("/effort accepts the six levels; unknown level toasts the vocabulary", async () => {
    for (const level of ["off", "low", "medium", "high", "xhigh", "max"]) {
      const ctx = recordingSlashContext()
      await runSlash(`/effort ${level}`, ctx)
      expect(ctx.calls).toEqual([`effort:${level}`])
    }
    const bad = recordingSlashContext()
    await runSlash("/effort turbo", bad)
    expect(bad.calls.some((c) => c.startsWith("toast:effort: unknown"))).toBe(true)
    expect(bad.calls).not.toContain("effort:turbo")
  })

  it("/fork [title] — bare forks unnamed, title passes through", async () => {
    const bare = recordingSlashContext()
    await runSlash("/fork", bare)
    expect(bare.calls).toEqual(["fork"])
    const named = recordingSlashContext()
    await runSlash("/fork my fork", named)
    expect(named.calls).toEqual(["fork:my fork"])
  })

  it("/compact bare vs instructions form", async () => {
    const bare = recordingSlashContext()
    await runSlash("/compact", bare)
    expect(bare.calls).toEqual(["compact", "toast:compacted"])
  })

  it("/find bare vs prefilled pattern", async () => {
    const bare = recordingSlashContext()
    await runSlash("/find", bare)
    expect(bare.calls).toEqual(["startSearch"])
    const pref = recordingSlashContext()
    await runSlash("/find foo(bar", pref)
    expect(pref.calls).toEqual(["startSearch:foo(bar"])
  })

  it("/jump <n> jumps by anchor; out-of-range/non-numeric toasts", async () => {
    const ok = recordingSlashContext()
    await runSlash("/jump 1", ok)
    expect(ok.calls).toEqual(["gotoLine:0"])
    const oob = recordingSlashContext()
    await runSlash("/jump 99", oob)
    expect(oob.calls.some((c) => c.startsWith("toast:jump:"))).toBe(true)
    expect(oob.calls).not.toContain("gotoLine:")
    const text = recordingSlashContext()
    await runSlash("/jump third", text)
    expect(text.calls.some((c) => c.startsWith("toast:jump:"))).toBe(true)
  })

  it("/workflow subcommands validate name/args against the surface", async () => {
    const surf = {
      async list() { return [{ name: "hello", description: "hi", steps: 1 }] },
      async run(_name: string) { return { run_id: "r1", job_id: "w1", status: "running" } },
      async status(id?: string) { return id === undefined ? [] : [{ id, status: "running", stdout: "", stderr: "" }] },
    } as unknown as WorkflowSurface
    const list = recordingSlashContext()
    list.workflow = surf
    await runSlash("/workflow list", list)
    expect(list.calls.some((c) => c.startsWith("panel:workflow:Workflows:1"))).toBe(true)
    const run = recordingSlashContext()
    run.workflow = surf
    await runSlash("/workflow run hello", run)
    expect(run.calls).toEqual(["textInput:workflow run · hello"])
    const unknown = recordingSlashContext()
    unknown.workflow = surf
    await runSlash("/workflow run nope", unknown)
    expect(unknown.calls.some((c) => c.includes("unknown workflow"))).toBe(true)
    const status = recordingSlashContext()
    status.workflow = surf
    await runSlash("/workflow status w1", status)
    expect(status.calls.some((c) => c.startsWith("panel:workflow:Workflow status · w1"))).toBe(true)
    const bare = recordingSlashContext()
    bare.workflow = surf
    await runSlash("/workflow", bare)
    expect(bare.calls.some((c) => c.startsWith("panel:workflow:Workflows"))).toBe(true)
    const bad = recordingSlashContext()
    bad.workflow = surf
    await runSlash("/workflow zoom", bad)
    expect(bad.calls.some((c) => c.startsWith("toast:workflow: unknown subcommand"))).toBe(true)
  })

  it("/help renders the CURRENT visible registry + active key bindings (never the static list)", async () => {
    const ctx = recordingSlashContext() as SlashContext & { helpRows?: unknown[] }
    let rows: Array<{ label: string; detail?: string }> = []
    ctx.openPanel = (req) => { rows = req.rows as Array<{ label: string; detail?: string }> }
    await runSlash("/help", ctx)
    const labels = rows.map((r) => r.label)
    expect(labels).toContain("/theme") // visible command row (dynamic fixture list)
    expect(labels).toContain("j/k") // active key binding row
    const descs = rows.map((r) => r.detail ?? "")
    expect(descs.some((d) => d === "Cycle theme")).toBe(true)
  })
})

describe("slash commands — eco inventories states (real row builders)", () => {
  it("plugin rows distinguish mounted / configured / not installed / failed", () => {
    const rows = pluginRows([
      { id: "a", marketplace: "m1", name: "alpha", source: "x", installed: true, enabled: true },
      { id: "b", marketplace: "m1", name: "beta", source: "x", installed: true, enabled: false },
      { id: "c", marketplace: "m1", name: "gamma", source: "x", installed: false, enabled: false },
      { id: "d", marketplace: "m1", name: "delta", source: "x", installed: true, enabled: true, conflicts: [{ command: "bad", reason: "locked" }] },
    ] as never)
    const detailOf = (label: string): string => rows.find((r) => r.label === label)?.detail ?? ""
    expect(detailOf("alpha")).toContain("mounted")
    expect(detailOf("beta")).toContain("configured")
    expect(detailOf("gamma")).toContain("not installed")
    expect(detailOf("delta")).toContain("failed")
    // marketplace shelf = the not-installed rows
    const shelf = marketplaceRows([
      { id: "a", marketplace: "m1", name: "alpha", source: "x", installed: true, enabled: true },
      { id: "b", marketplace: "m1", name: "beta", source: "x", installed: false, enabled: false },
    ] as never)
    expect(shelf.map((r) => r.label)).toEqual(["beta"])
  })

  it("mcps rows label configured servers (the host reports no mount state)", () => {
    const rows = mcpsRows([{ name: "server-1", transport: "stdio" }])
    expect(rows[0]).toEqual({ label: "server-1", detail: "configured · stdio" })
    const empty = mcpsRows([])
    expect(empty.map((r) => r.label).join("")).toContain("no MCP servers configured")
  })

  it("hooks rows keep the per-handler trust verdict (ok/invalid/untrusted)", () => {
    const handlers = [
      { spec: { event: "pre-tool", id: "h1", trust: { script: "x", sha256: "0123456789abcdef" } }, valid: true },
      { spec: { event: "pre-tool", id: "h2", trust: { script: "x", sha256: "abcdef0123456789" } }, valid: false, trustError: "mismatch" },
    ] as never
    const rows = hooksRows(handlers, HOOK_EVENTS as readonly string[])
    expect(rows.some((r) => r.label === "h1" && r.detail?.endsWith("ok"))).toBe(true)
    expect(rows.some((r) => r.label === "h2" && r.detail?.endsWith("invalid"))).toBe(true)
  })

  let ws: string
  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), "ih-slash-eco-"))
    // Real skill registry scan target: <ws>/skills/hello/SKILL.md
    mkdirSync(join(ws, "skills", "hello"), { recursive: true })
    writeFileSync(
      join(ws, "skills", "hello", "SKILL.md"),
      "---\nname: hello\ndescription: Say hi\n---\n# hello\n\nbody\n",
    )
  })
  afterAll(() => {
    try { rmSync(ws, { recursive: true, force: true }) } catch { /* tmp */ }
  })

  it("/skills lists the REAL scanned skill (name + source)", async () => {
    const ctx = recordingSlashContext()
    ctx.workspace = ws
    let rows: Array<{ label: string; detail?: string }> = []
    ctx.openPanel = (req) => { rows = req.rows as Array<{ label: string; detail?: string }> }
    await runSlash("/skills", ctx)
    expect(rows.some((r) => r.label === "hello" && r.detail === "workspace")).toBe(true)
  })
})
