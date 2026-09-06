// M37b G2: welcome hero (spec §2a) — two-column ≥90 cols vs stacked below;
// menu rows `{key} {label}`, version right on the border, error line above.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { InputEvent, Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { createCredentialStore } from "@i-harness/credentials"
import { SettingsStore } from "@i-harness/settings"
import { TuiApp } from "../src/app/loop.ts"
import { makeDraw } from "../src/app/present.ts"
import { ProviderController } from "../src/app/provider-controller.ts"
import { createProviderRuntime } from "@i-harness/provider-runtime"
import { createProviderRegistry } from "@i-harness/provider"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"
import { layoutWelcome, renderWelcome, WELCOME_WIDE_MIN } from "../src/views/welcome.ts"
import type { WelcomeState } from "../src/views/welcome.ts"
import type { BackendClient, BackendModelState, TuiEvent } from "../src/contracts.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap, "groknight")

const make = (cols: number, rows: number): Renderer => createRenderer({ cols, rows, cap })

const rowText = (r: Renderer, y: number): string => {
  const cells = r.buffer.cells
  const w = r.buffer.width
  let out = ""
  for (let x = 0; x < w; x++) out += cells[y * w + x].text
  return out
}

const cellAt = (r: Renderer, x: number, y: number) => r.buffer.cells[y * r.buffer.width + x]

const rgb = (hex: string): { r: number; g: number; b: number } => {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) }
}

/** Style-fg matcher: { fg: rgb }. */
const fg = (hex: string): { fg: { r: number; g: number; b: number } } => ({ fg: rgb(hex) })

const draw = (r: Renderer, fn: (view: ReturnType<typeof makeDraw>) => void): void => {
  fn(makeDraw(r.buffer, palette))
}

const state: WelcomeState = {
  version: "0.1.0",
  menus: [
    { action: "new", key: "ctrl+n", label: "New session" },
    { action: "resume", key: "ctrl+s", label: "Resume session" },
    { action: "settings", key: "F2", label: "Settings" },
    { action: "quit", key: "ctrl+q", label: "Quit" },
  ],
  cursor: 0,
  modelState: { status: "loading" },
}

const prompt = {
  text: "",
  cursor: 0,
  multiLine: false,
  focused: true,
  model: "unconfigured",
  plan: false,
  title: "New session",
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function providerController(): Promise<ProviderController> {
  const root = mkdtempSync(join(tmpdir(), "ih-welcome-"))
  roots.push(root)
  const settings = new SettingsStore({ path: join(root, "settings.json") })
  await settings.load()
  const runtime = createProviderRuntime({
    settings,
    credentials: createCredentialStore(join(root, "credentials.json")),
    registry: createProviderRegistry(),
  })
  return new ProviderController({ runtime, settings })
}

function recordingBackend(
  modelState: BackendModelState,
  sessions = [{ id: "resume-1", title: "Resume me", updatedAt: 1 }],
): BackendClient & { calls: string[]; submissions: string[] } {
  const calls: string[] = []
  const submissions: string[] = []
  return {
    calls,
    submissions,
    listSessions: async () => {
      calls.push("listSessions")
      return sessions
    },
    open: async (id) => { calls.push(`open:${id}`) },
    createSession: async () => {
      calls.push("createSession")
      calls.push("open:created-1")
      return "created-1"
    },
    forkSession: async () => "forked-1",
    modelState: async () => {
      calls.push("modelState")
      return modelState
    },
    setSessionModel: async () => modelState,
    submit: async (text) => {
      calls.push(`submit:${text}`)
      submissions.push(text)
    },
    steer: async () => {},
    cancel: async () => {},
    events: async function* (): AsyncIterable<TuiEvent> {},
    seqCursor: () => -1,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    close: async () => {},
  }
}

function testApp(backend: BackendClient, controller: ProviderController): { app: TuiApp; renderer: Renderer } {
  const renderer = make(80, 24)
  return {
    renderer,
    app: new TuiApp({
      renderer,
      backend,
      engine: createScrollbackEngine({ width: 80 }),
      capabilities: cap,
      palette,
      glyphs: GLYPHS,
      providerController: controller,
      listSessions: () => backend.listSessions(),
      write: () => {},
    }),
  }
}

const enterKey = (): InputEvent => ({
  type: "key",
  code: "Enter",
  key: "Enter",
  ctrl: false,
  alt: false,
  shift: false,
})

const escapeKey = (): InputEvent => ({
  type: "key",
  code: "Esc",
  key: "Esc",
  ctrl: false,
  alt: false,
  shift: false,
})

const downKey = (): InputEvent => ({
  type: "key",
  code: "Down",
  key: "ArrowDown",
  ctrl: false,
  alt: false,
  shift: false,
})

const ctrlKey = (key: "n" | "s"): InputEvent => ({
  type: "key",
  code: "char",
  key,
  ctrl: true,
  alt: false,
  shift: false,
})

const f2Key = (): InputEvent => ({
  type: "key",
  code: "F2",
  key: "F2",
  ctrl: false,
  alt: false,
  shift: false,
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not settle")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function frontText(r: Renderer): string {
  const inner = r as unknown as { db: { front: { cells: Array<{ text: string }>; width: number } } }
  const { cells, width } = inner.db.front
  const rows: string[] = []
  for (let y = 0; y < cells.length / width; y++) {
    let line = ""
    for (let x = 0; x < width; x++) line += cells[y * width + x]!.text
    rows.push(line)
  }
  return rows.join("\n")
}

describe("welcome hero (spec §2a)", () => {
  it(`wide layout (>= ${WELCOME_WIDE_MIN} cols): logo left + version right, menu column right`, () => {
    const r = make(100, 30)
    draw(r, (view) => renderWelcome({ x: 0, y: 0, w: 100, h: 30 }, state, prompt, view, palette, GLYPHS))
    const top = rowText(r, 1)
    expect(top.slice(2, 4)).toBe("╭─") // boxX = 2 (centered 96-col hero)
    expect(top).toContain("v0.1.0")
    expect(rowText(r, 2)).toContain("I-harness")
    expect(rowText(r, 2)).toContain("ctrl+n New session")
    expect(rowText(r, 3)).toContain("Thanks for trying I-harness, give feedback")
    expect(rowText(r, 3)).toContain("ctrl+s Resume session")
    expect(rowText(r, 4)).toContain("F2 Settings")
    expect(rowText(r, 5)).toContain("ctrl+q Quit")
    // cursor row fills bg_visual in the menu column (past the text runs).
    expect(cellAt(r, 80, 2).style).toMatchObject({ bg: rgb(palette.bgVisual) })
    expect(cellAt(r, 80, 5).style).not.toMatchObject({ bg: rgb(palette.bgVisual) })
  })

  it("keeps all wide-layout actions visible at exactly 90 columns", () => {
    const r = make(90, 24)
    draw(r, (view) => renderWelcome({ x: 0, y: 0, w: 90, h: 24 }, state, prompt, view, palette, GLYPHS))
    const text = Array.from({ length: 24 }, (_, y) => rowText(r, y)).join("\n")

    expect(rowText(r, 2)).toContain("I-harness")
    expect(rowText(r, 2)).toContain("ctrl+n New session")
    expect(text).toContain("ctrl+s Resume session")
    expect(text).toContain("F2 Settings")
    expect(text).toContain("ctrl+q Quit")
  })

  it("stacked below 90 cols: logo/subtitle then the menu rows, one column", () => {
    const r = make(60, 30)
    draw(r, (view) => renderWelcome({ x: 0, y: 0, w: 60, h: 30 }, state, prompt, view, palette, GLYPHS))
    expect(rowText(r, 1)).toContain("╭")
    expect(rowText(r, 2)).toContain("I-harness")
    expect(rowText(r, 3)).toContain("Thanks for trying I-harness, give feedback with")
    expect(rowText(r, 4)).toContain("ctrl+n New session")
    expect(rowText(r, 5)).toContain("ctrl+s Resume session")
    expect(rowText(r, 6)).toContain("F2 Settings")
    expect(rowText(r, 7)).toContain("ctrl+q Quit")
    expect(rowText(r, 1)).toContain("v0.1.0")
  })

  it("error line above the box, red", () => {
    const r = make(100, 30)
    draw(r, (view) => renderWelcome({ x: 0, y: 0, w: 100, h: 30 }, { ...state, startupError: "trust issue" }, prompt, view, palette, GLYPHS))
    expect(rowText(r, 1)).toContain("trust issue")
    expect(cellAt(r, 2, 1).style).toMatchObject(fg(palette.accentError))
    expect(rowText(r, 3).slice(2, 4)).toBe("╭─") // hero shifts below error + gap
  })

  it("menu key hints bold accent_user", () => {
    const r = make(100, 30)
    draw(r, (view) => renderWelcome({ x: 0, y: 0, w: 100, h: 30 }, state, prompt, view, palette, GLYPHS))
    // menu at right column x=50: 'c' of ctrl+s at 50.
    expect(cellAt(r, 50, 2).style).toMatchObject(fg(palette.accentUser))
  })

  it("keeps the prompt, model status, and a following content row visible at 80x24 and 120x32", () => {
    for (const [cols, rows] of [[80, 24], [120, 32]] as const) {
      const layout = layoutWelcome({ x: 0, y: 0, w: cols, h: rows }, state, prompt)
      expect(layout.hero.w).toBeLessThanOrEqual(120)
      expect(layout.prompt.h).toBeGreaterThanOrEqual(3)
      expect(layout.modelStatus.y).toBe(layout.prompt.y + layout.prompt.h)
      expect(layout.nextContent.y).toBeLessThan(rows)
    }
  })

  it("shows a disabled prompt CTA when no model is configured", () => {
    const r = make(80, 24)
    const unconfigured: WelcomeState = {
      ...state,
      modelState: { status: "unconfigured", reason: "No model configured" },
    }
    draw(r, (view) => renderWelcome({ x: 0, y: 0, w: 80, h: 24 }, unconfigured, prompt, view, palette, GLYPHS))
    const text = Array.from({ length: 24 }, (_, y) => rowText(r, y)).join("\n")
    expect(text).toContain("No model configured")
    expect(text).toContain("Settings > Models & Providers")
    expect(text).not.toContain("mock-model")
  })
})

describe("TuiApp Welcome model gate", () => {
  it("starts on Welcome and disables prompt when no model is configured", async () => {
    const backend = recordingBackend({ status: "unconfigured", reason: "No model configured" })
    const { app, renderer } = testApp(backend, await providerController())

    expect(app.state().view).toEqual({ kind: "welcome" })
    await app.initialize({ renderWelcomeBeforeModel: true })
    app.frame()

    const text = frontText(renderer)
    expect(text).toContain("No model configured")
    expect(text).toContain("Settings > Models & Providers")
  })

  it("Enter on a disabled Welcome prompt opens Models & Providers without submitting", async () => {
    const backend = recordingBackend({ status: "unconfigured", reason: "No model configured" })
    const { app, renderer } = testApp(backend, await providerController())
    await app.initialize({ renderWelcomeBeforeModel: true })
    app.state().prompt.text = "hello"
    app.state().prompt.cursor = 5

    app.feedInput(enterKey())
    await waitFor(() => (app.state().overlay as { kind?: string } | undefined)?.kind === "settings")
    app.frame()

    expect(backend.submissions).toEqual([])
    expect(app.state().prompt.text).toBe("hello")
    expect(frontText(renderer)).toContain("Models & Providers")
  })

  it("routes Esc to the Settings overlay before the underlying Welcome menu", async () => {
    const backend = recordingBackend({ status: "unconfigured", reason: "No model configured" })
    const { app } = testApp(backend, await providerController())
    await app.initialize({ renderWelcomeBeforeModel: true })
    app.state().prompt.text = "hello"
    app.state().prompt.cursor = 5

    app.feedInput(enterKey())
    await waitFor(() => (app.state().overlay as { kind?: string } | undefined)?.kind === "settings")

    app.feedInput(escapeKey())
    expect((app.state().overlay as { kind?: string } | undefined)?.kind).toBe("settings")
    app.feedInput(escapeKey())

    expect(app.state().overlay).toBeUndefined()
    expect(app.state().prompt.text).toBe("hello")
  })

  it("routes Welcome Resume picker navigation and selection to the session surface", async () => {
    const backend = recordingBackend(
      { status: "ready", providerId: "fixture", modelId: "model", label: "fixture:model" },
      [
        { id: "resume-1", title: "First", updatedAt: 1 },
        { id: "resume-2", title: "Second", updatedAt: 2 },
      ],
    )
    const { app } = testApp(backend, await providerController())
    await app.initialize({ renderWelcomeBeforeModel: true })
    app.dispatch("sessions")
    await waitFor(() => app.state().sessions?.loading === false)

    app.feedInput(downKey())
    expect(app.state().sessions?.cursor).toBe(1)
    app.feedInput(enterKey())
    await waitFor(() => app.state().view?.kind === "agent")

    expect(app.state().view).toEqual({ kind: "agent", sessionId: "resume-2" })
    expect(backend.calls).toContain("open:resume-2")
  })

  it("runs Ctrl+N independently of the Welcome menu cursor", async () => {
    const modelState: BackendModelState = {
      status: "ready",
      providerId: "fixture",
      modelId: "model",
      label: "fixture:model",
    }
    const newBackend = recordingBackend(modelState)
    const { app: newApp } = testApp(newBackend, await providerController())
    await newApp.initialize({ renderWelcomeBeforeModel: true })
    newApp.state().welcome!.cursor = 3

    newApp.feedInput(ctrlKey("n"))
    await waitFor(() => newApp.state().view?.kind === "agent")
    expect(newApp.state().view).toEqual({ kind: "agent", sessionId: "created-1" })
  })

  it("runs Ctrl+S independently of the Welcome menu cursor", async () => {
    const modelState: BackendModelState = {
      status: "ready",
      providerId: "fixture",
      modelId: "model",
      label: "fixture:model",
    }
    const resumeBackend = recordingBackend(modelState)
    const { app: resumeApp } = testApp(resumeBackend, await providerController())
    await resumeApp.initialize({ renderWelcomeBeforeModel: true })
    resumeApp.state().welcome!.cursor = 0

    resumeApp.feedInput(ctrlKey("s"))
    await waitFor(() => resumeApp.state().sessions?.loading === false)
    expect(resumeApp.state().sessions?.title).toBe("Resume session")
  })

  it("opens Welcome Settings with F2 independently of the menu cursor", async () => {
    const backend = recordingBackend({ status: "unconfigured", reason: "No model configured" })
    const { app, renderer } = testApp(backend, await providerController())
    await app.initialize({ renderWelcomeBeforeModel: true })
    app.state().welcome!.cursor = 3

    app.feedInput(f2Key())
    app.frame()

    expect((app.state().overlay as { kind?: string } | undefined)?.kind).toBe("settings")
    expect(frontText(renderer)).toContain("Models & Providers")
  })

  it("a ready Welcome prompt creates and opens a session before submitting", async () => {
    const backend = recordingBackend({ status: "ready", providerId: "fixture", modelId: "model", label: "fixture:model" })
    const { app } = testApp(backend, await providerController())
    await app.initialize({ renderWelcomeBeforeModel: true })
    app.state().prompt.text = "ship it"
    app.state().prompt.cursor = 7

    app.feedInput(enterKey())
    await waitFor(() => app.state().view?.kind === "agent")

    expect(app.state().view).toEqual({ kind: "agent", sessionId: "created-1" })
    expect(backend.calls.slice(-4)).toEqual(["modelState", "createSession", "open:created-1", "submit:ship it"])
    expect(app.state().prompt.text).toBe("")
  })
})
