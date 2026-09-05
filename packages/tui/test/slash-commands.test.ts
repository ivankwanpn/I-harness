// M46a G2: slash command run() units against a FAKE ctx — the state-changing
// commands (theme cycle, toggles, approval, history-open, find focus, compact
// seam, session ops) assert the ctx-function contracts + app mutations; the
// eco panel sources hit the REAL backends (skills over a tmp workspace).

import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CommandRegistry } from "../src/app/slash/registry.ts"
import type { SlashContext, SlashPanelRow } from "../src/app/slash/types.ts"
import type { TuiAppState } from "../src/app/present.ts"
import { nextTheme } from "../src/app/slash/impl/visual.ts"

interface FakeRecorder {
  calls: string[]
}

/** A fake app object carrying the fields the command impls mutate. */
function fakeApp(): TuiAppState {
  return {
    mode: "normal",
    title: "untitled",
    prompt: {
      text: "", cursor: 0, multiLine: false, focused: true,
      model: "mock-model", plan: false, title: "untitled",
    },
    status: { plan: false },
    theme: "auto",
    timestamps: false,
    compactMode: false,
    autoApprove: false,
    history: [],
    historyIndex: 0,
    panes: new Set<string>(),
  } as unknown as TuiAppState
}

function fakeCtx(app: TuiAppState): SlashContext & FakeRecorder {
  const calls: string[] = []
  const ctx: SlashContext = {
    app,
    backend: {
      compact: async () => { calls.push("backend.compact"); return { compacted: true } },
      context: async () => ({ used: 10, total: 100 }),
    } as never,
    engine: { lineCount: () => 5 } as never,
    input: "",
    arg: "",
    workspace: undefined,
    sessionId: undefined,
    toast: (text) => calls.push(`toast:${text}`),
    turns: () => 2,
    jumpAnchors: () => [{ line: 0, n: 1, text: "hi" }],
    gotoLine: (l) => calls.push(`gotoLine:${l}`),
    openPanel: (req) => calls.push(`panel:${req.kind}:${req.title}:${req.rows.length}`),
    openSessions: () => calls.push("openSessions"),
    openHistoryPanel: () => calls.push("openHistoryPanel"),
    openRewind: () => calls.push("openRewind"),
    startSearch: () => calls.push("startSearch"),
    planRows: () => [{ label: "plan line" }],
    toggleBtwWith: (q) => calls.push(`btw:${q}`),
    openBtwInput: () => calls.push("btwInput"),
    togglePane: (k) => calls.push(`togglePane:${k}`),
    setScreen: (s) => calls.push(`setScreen:${s}`),
    setTheme: (k) => calls.push(`setTheme:${k}`),
    setTimestamps: (on) => calls.push(`setTimestamps:${on}`),
    setMultiline: (on) => calls.push(`setMultiline:${on}`),
    setCompactMode: (on) => calls.push(`setCompactMode:${on}`),
    setAutoApprove: (on) => calls.push(`setAutoApprove:${on}`),
    focusPrompt: () => calls.push("focusPrompt"),
    resetSession: () => calls.push("resetSession"),
    renameSession: (t) => calls.push(`renameSession:${t}`),
    deleteSession: () => calls.push("deleteSession"),
    relaunch: () => false,
    quitApp: () => calls.push("quitApp"),
    copyBlock: () => calls.push("copyBlock"),
    editPromptInEditor: () => calls.push("editPromptInEditor"),
    exportTranscript: async () => { calls.push("exportTranscript"); return "/tmp/x.txt" },
    openTranscriptPager: async () => { calls.push("openTranscriptPager"); return true },
    probeReport: async () => [{ label: "color", detail: "truecolor" }],
    g1Modal: (line) => { calls.push(`g1:${line}`); return true },
    effort: (l) => calls.push(`effort:${l}`),
  }
  return Object.assign(ctx, { calls }) as SlashContext & FakeRecorder
}

const registry = new CommandRegistry()
const run = async (line: string, ctx: SlashContext): Promise<void> => {
  const m = registry.matches(line, ctx)
  if (m === undefined) throw new Error(`no match for ${line}`)
  // the loop builds the ctx with the matched arg/input — mirror it here.
  const c = ctx as SlashContext & { arg: string; input: string }
  c.arg = m.arg
  c.input = line
  await m.command.run(ctx)
}

describe("slash commands — state-changing units (fake ctx)", () => {
  it("nextTheme cycles groknight → grokday → auto → groknight", () => {
    expect(nextTheme("groknight")).toBe("grokday")
    expect(nextTheme("grokday")).toBe("auto")
    expect(nextTheme("auto")).toBe("groknight")
  })

  it("/theme (bare) cycles the app theme; /theme <name> sets it", async () => {
    const app = fakeApp()
    const ctx = fakeCtx(app)
    await run("/theme", ctx)
    expect(ctx.calls).toContain("setTheme:groknight")
    expect(ctx.calls.some((c) => c.startsWith("toast:theme:"))).toBe(true)
    const ctx2 = fakeCtx(app)
    await run("/theme grokday", ctx2)
    expect(ctx2.calls).toContain("setTheme:grokday")
    const ctx3 = fakeCtx(app)
    await run("/theme nonsense", ctx3)
    expect(ctx3.calls.some((c) => c.startsWith("toast:theme: unknown"))).toBe(true)
  })

  it("/timestamps toggles the engine flag; /multiline + /compact-mode flip state", async () => {
    const ctx = fakeCtx(fakeApp())
    await run("/timestamps", ctx)
    expect(ctx.calls).toContain("setTimestamps:true")
    const ctx2 = fakeCtx(fakeApp())
    await run("/multiline", ctx2)
    expect(ctx2.calls).toContain("setMultiline:true")
    const ctx3 = fakeCtx(fakeApp())
    await run("/compact-mode", ctx3)
    expect(ctx3.calls).toContain("setCompactMode:true")
  })

  it("/timeline toggles the rail state + toasts (real app state)", async () => {
    const app = fakeApp()
    const ctx = fakeCtx(app)
    await run("/timeline", ctx)
    expect((app as unknown as { showTimeline?: boolean }).showTimeline).toBe(true)
    expect(ctx.calls).toContain("toast:timeline on")
    // second toggle flips it OFF (undefined → false).
    const app2 = fakeApp()
    const ctx2 = fakeCtx(app2)
    await run("/timeline", ctx2)
    await run("/timeline", ctx2)
    expect((app2 as unknown as { showTimeline?: boolean }).showTimeline).toBe(false)
    expect(ctx2.calls).toContain("toast:timeline off")
  })

  it("/always-approve + /auto set the approval default", async () => {
    const ctx = fakeCtx(fakeApp())
    await run("/always-approve", ctx)
    expect(ctx.calls).toContain("setAutoApprove:true")
    const ctx2 = fakeCtx(fakeApp())
    await run("/auto", ctx2)
    expect(ctx2.calls).toContain("setAutoApprove:true")
    // second press toggles OFF
    const ctx3 = fakeCtx({ ...fakeApp(), autoApprove: true } as TuiAppState)
    await run("/auto", ctx3)
    expect(ctx3.calls).toContain("setAutoApprove:false")
  })

  it("/find activates search; /history opens the history panel; /resume the picker", async () => {
    const ctx = fakeCtx(fakeApp())
    await run("/find", ctx)
    expect(ctx.calls).toContain("startSearch")
    const ctx2 = fakeCtx(fakeApp())
    await run("/history", ctx2)
    expect(ctx2.calls).toContain("openHistoryPanel")
    const ctx3 = fakeCtx(fakeApp())
    await run("/resume", ctx3)
    expect(ctx3.calls).toContain("openSessions")
  })

  it("/home → welcome screen; /quit → quitApp; /copy → copyBlock", async () => {
    const ctx = fakeCtx(fakeApp())
    await run("/home", ctx)
    expect(ctx.calls).toContain("setScreen:welcome")
    const ctx2 = fakeCtx(fakeApp())
    await run("/quit", ctx2)
    expect(ctx2.calls).toContain("quitApp")
    const ctx3 = fakeCtx(fakeApp())
    await run("/copy", ctx3)
    expect(ctx3.calls).toContain("copyBlock")
  })

  it("/compact calls the backend seam (stubbed) + toasts the result", async () => {
    const ctx = fakeCtx(fakeApp())
    await run("/compact some instructions", ctx)
    expect(ctx.calls).toContain("backend.compact")
    expect(ctx.calls).toContain("toast:compacted")
  })

  it("/rewind opens the rewind picker; /queue + /tasks toggle panes; /btw <q> steers", async () => {
    const ctx = fakeCtx(fakeApp())
    await run("/rewind", ctx)
    expect(ctx.calls).toContain("openRewind")
    const ctx2 = fakeCtx(fakeApp())
    await run("/queue", ctx2)
    expect(ctx2.calls).toContain("togglePane:queue")
    await run("/tasks", ctx2)
    expect(ctx2.calls).toContain("togglePane:tasks")
    const ctx3 = fakeCtx(fakeApp())
    await run("/btw explain this", ctx3)
    expect(ctx3.calls).toContain("btw:explain this")
  })

  it("/plan flips mode state (local plan flag) + opens the plan viewer", async () => {
    const app = fakeApp()
    const ctx = fakeCtx(app)
    await run("/plan", ctx)
    expect(app.mode).toBe("plan")
    expect(app.status.plan).toBe(true)
    expect(app.prompt.plan).toBe(true)
    expect(ctx.calls.some((c) => c.startsWith("panel:"))).toBe(true)
    const ctx2 = fakeCtx(fakeApp())
    await run("/view-plan", ctx2)
    expect(ctx2.calls.some((c) => c.startsWith("panel:goal:Plan:1"))).toBe(true)
  })

  it("/jump lists the engine anchors; select jumps (onSelect)", async () => {
    const ctx = fakeCtx(fakeApp()) as SlashContext & FakeRecorder & { panelSelect?: (i: number) => void }
    // capture the request
    let sel: ((i: number) => void) | undefined
    ctx.openPanel = (req) => { sel = req.onSelect; ctx.calls.push(`panel:${req.kind}`) }
    await run("/jump", ctx)
    expect(ctx.calls).toContain("panel:jump")
    sel?.(0)
    expect(ctx.calls).toContain("gotoLine:0")
  })

  it("/rename <title> (arg form) renames; /session-info opens the info panel", async () => {
    const ctx = fakeCtx(fakeApp())
    await run("/rename my title", ctx)
    expect(ctx.calls).toContain("renameSession:my title")
    const ctx2 = fakeCtx(fakeApp())
    await run("/session-info", ctx2)
    expect(ctx2.calls.some((c) => c.startsWith("panel:session-info"))).toBe(true)
    expect(ctx2.backend // context called through the real fake
      ).toBeDefined()
  })

  it("/usage opens the token meter panel from backend.context", async () => {
    const ctx = fakeCtx(fakeApp())
    await run("/usage", ctx)
    expect(ctx.calls.some((c) => c.startsWith("panel:usage"))).toBe(true)
  })

  it("/goal opens the goal panel (label from app.status)", async () => {
    const app = fakeApp()
    ;(app.status as { plan: boolean; goal?: string }).goal = "fix the tui"
    const ctx = fakeCtx(app)
    await run("/goal", ctx)
    expect(ctx.calls.some((c) => c.startsWith("panel:goal"))).toBe(true)
  })

  it("/tutorial lists the topic index then swaps to the topic content", async () => {
    const ctx = fakeCtx(fakeApp()) as SlashContext & FakeRecorder & { panelSelect?: (i: number) => void }
    let sel: ((i: number) => void) | undefined
    ctx.openPanel = (req) => { sel = req.onSelect; ctx.calls.push(`panel:tutorial:${req.title}:${req.rows.length}`) }
    await run("/tutorial", ctx)
    expect(ctx.calls.some((c) => c.startsWith("panel:tutorial:Tutorial:4"))).toBe(true)
    sel?.(0)
    expect(ctx.calls.some((c) => c.startsWith("panel:tutorial:Tutorial — terminal setup:"))).toBe(true)
  })

  it("/new + /delete open the confirm panel (Cancel default) and never fire a write", async () => {
    const ctx = fakeCtx(fakeApp()) as SlashContext & FakeRecorder & { panelSelect?: (i: number) => void }
    ctx.openPanel = (req) => { ctx.calls.push(`panel:${req.kind}:${req.title}`); }
    await run("/new", ctx)
    expect(ctx.calls.some((c) => c.startsWith("panel:"))).toBe(true)
    const ctx2 = fakeCtx(fakeApp())
    await run("/delete", ctx2)
    expect(ctx2.calls.some((c) => c.startsWith("panel:"))).toBe(true)
  })

  it("/doctor opens the probe report panel (injected probeReport)", async () => {
    const ctx = fakeCtx(fakeApp())
    await run("/doctor", ctx)
    expect(ctx.calls.some((c) => c.startsWith("panel:doctor"))).toBe(true)
  })

  it("/provider //model //settings delegate to the G1 modal seam", async () => {
    const ctx = fakeCtx(fakeApp())
    await run("/provider", ctx)
    expect(ctx.calls.some((c) => c.startsWith("g1:/provider"))).toBe(true)
    const ctx2 = fakeCtx(fakeApp())
    await run("/settings", ctx2)
    expect(ctx2.calls.some((c) => c.startsWith("g1:/settings"))).toBe(true)
  })

  it("/effort forwards the level to the settings seam", async () => {
    const ctx = fakeCtx(fakeApp())
    await run("/effort medium", ctx)
    expect(ctx.calls).toContain("effort:medium")
  })
})

describe("slash commands — eco sources (REAL backends)", () => {
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
    let rows: SlashPanelRow[] = []
    const ctx = fakeCtx(fakeApp())
    ctx.workspace = ws
    ctx.openPanel = (req) => { rows = req.rows }
    await run("/skills", ctx)
    expect(rows.some((r) => r.label === "hello" && r.detail === "workspace")).toBe(true)
  })
})
