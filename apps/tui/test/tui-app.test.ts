// apps/tui — the tui command is thin wiring; this test pins the flag parser
// so the CLI surface cannot drift silently (the PTY proofs of the render
// pipeline live in packages/tui/test/harness — cases 011/014).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createCredentialStore } from "@i-harness/credentials"
import type { ModelClient } from "@i-harness/llm-seam"
import { createProviderRegistry } from "@i-harness/provider"
import { createProviderRuntime } from "@i-harness/provider-runtime"
import { SettingsStore } from "@i-harness/settings"
import { createRenderer, createUnknownCapabilities, makeGlyphs, resolvePalette } from "@i-harness/tui-core"
import { ProviderController, createEventMapState, createScrollbackEngine, mapSessionEvent } from "@i-harness/tui"
import type { BackendClient, InputSource, TuiEvent } from "@i-harness/tui"
import { createSessionService } from "@i-harness/session-executor"
import {
  buildEmbeddedSessionOptions,
  buildSdkArgs,
  createExecutableApp,
  createExecutableHost,
  createExecutableTui,
  pumpInteractionBridge,
  createTuiModelBindingFor,
  createTuiShutdownController,
  parseFlags,
  resolveExecutableScreenMode,
} from "../src/index.ts"
import type { InlineHost, RegionLine } from "@i-harness/tui"
import type { TerminalHandles } from "@i-harness/tui-core"

const cap = { ...createUnknownCapabilities(), colorLevel: "truecolor" as const, dark: true }
type BackendModelState = Awaited<ReturnType<BackendClient["modelState"]>>

function recordingBackend(modelState: BackendModelState): BackendClient & { calls: string[]; submissions: string[] } {
  const calls: string[] = []
  const submissions: string[] = []
  return {
    calls,
    submissions,
    listSessions: async () => {
      calls.push("listSessions")
      return [{ id: "s-list", title: "Listed", updatedAt: 1 }]
    },
    open: async (id) => { calls.push(`open:${id}`) },
    createSession: async () => {
      calls.push("createSession")
      calls.push("open:s-created")
      return "s-created"
    },
    forkSession: async () => "s-forked",
    modelState: async () => {
      calls.push("modelState")
      return modelState
    },
    setSessionModel: async () => modelState,
    submit: async (prompt) => {
      calls.push(`submit:${prompt}`)
      submissions.push(prompt)
    },
    steer: async (text) => {
      calls.push(`steer:${text}`)
    },
    cancel: async () => {},
    events: async function* (): AsyncIterable<TuiEvent> {},
    seqCursor: () => -1,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    close: async () => {},
  }
}

async function executableFixture(
  flags: Parameters<typeof createExecutableApp>[0]["flags"],
  backend: BackendClient,
  input?: InputSource,
  settingsSeed?: Record<string, unknown>,
) {
  const root = mkdtempSync(join(tmpdir(), "ih-tui-executable-"))
  if (settingsSeed !== undefined) {
    writeFileSync(join(root, "settings.json"), JSON.stringify(settingsSeed))
  }
  const settings = new SettingsStore({ path: join(root, "settings.json") })
  await settings.load()
  const credentials = createCredentialStore(join(root, "credentials.json"))
  const runtime = createProviderRuntime({ settings, credentials, registry: createProviderRegistry() })
  const providerController = new ProviderController({ runtime, settings, backend })
  const renderer = createRenderer({ cols: 80, rows: 24, cap })
  const created = await createExecutableApp({
    flags,
    backend,
    renderer,
    engine: createScrollbackEngine({ width: 80 }),
    capabilities: cap,
    palette: resolvePalette(cap),
    glyphs: makeGlyphs(true),
    providerController,
    // M49 Task 7: the same persisted→option mapping the run-tui host wires.
    busyEnter: settings.get().busyEnter === "interrupt" ? "steer" : "queue",
    ...(input !== undefined ? { input } : {}),
    write: () => {},
  })
  return { ...created, root }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not settle")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("tui flag parser", () => {
  it.each([
    { name: "resume", flags: { yes: false, resume: "s1" } },
    { name: "attach", flags: { yes: false, attach: "s1" } },
  ])("opens an explicit $name session after model resolution and before Agent", async ({ flags }) => {
    const backend = recordingBackend({ status: "ready", providerId: "fixture", modelId: "m", label: "fixture:m" })
    const fixture = await executableFixture(flags, backend)
    try {
      expect(backend.calls.slice(0, 2)).toEqual(["modelState", "open:s1"])
      expect(fixture.app.state().view).toEqual({ kind: "agent", sessionId: "s1" })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("preserves --prompt on Welcome when model resolution is invalid", async () => {
    const backend = recordingBackend({ status: "invalid", reason: "Missing credential", providerId: "fixture", modelId: "m" })
    const fixture = await executableFixture({ yes: false, prompt: "keep me" }, backend)
    try {
      expect(fixture.app.state().view).toEqual({ kind: "welcome" })
      expect(fixture.app.state().prompt.text).toBe("keep me")
      expect(backend.submissions).toEqual([])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("submits a ready --prompt only after creating and opening its session", async () => {
    const backend = recordingBackend({ status: "ready", providerId: "fixture", modelId: "m", label: "fixture:m" })
    const fixture = await executableFixture({ yes: false, prompt: "start now" }, backend)
    try {
      await waitFor(() => backend.submissions.length === 1)
      expect(backend.calls.slice(0, 4)).toEqual([
        "modelState",
        "createSession",
        "open:s-created",
        "submit:start now",
      ])
      expect(fixture.app.state().view).toEqual({ kind: "agent", sessionId: "s-created" })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([false, true])("passes provider settings and backend session listing when input attached=%s", async (attached) => {
    const backend = recordingBackend({ status: "unconfigured", reason: "No model configured" })
    const input: InputSource | undefined = attached
      ? { async *next() {} }
      : undefined
    const fixture = await executableFixture({ yes: false }, backend, input)
    try {
      fixture.app.dispatch("sessions")
      await waitFor(() => fixture.app.state().sessions?.loading === false)
      expect(fixture.app.state().sessions?.groups[0]?.sessions[0]?.id).toBe("s-list")
      fixture.app.dispatch("open-settings")
      expect((fixture.app.state().overlay as { kind?: string } | undefined)?.kind).toBe("settings")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("wires the persisted busyEnter into busy-Enter (M49): interrupt steers the busy turn", async () => {
    const backend = recordingBackend({ status: "ready", providerId: "fixture", modelId: "m", label: "fixture:m" })
    const fixture = await executableFixture({ yes: false }, backend, undefined, { busyEnter: "interrupt" })
    try {
      fixture.app.state().prompt.text = "busy text"
      fixture.app.state().turn = {
        phase: "responding", attempts: 1, phaseMs: 0, turnMs: 0, tokens: 0, nowMs: 0, canStop: true,
      }
      fixture.app.dispatch("submit")
      expect(backend.calls).toContain("steer:busy text")
      expect(backend.calls).not.toContain("submit:busy text")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("busyEnter wait queues the draft through the submit path (pre-M49 behavior)", async () => {
    const backend = recordingBackend({ status: "ready", providerId: "fixture", modelId: "m", label: "fixture:m" })
    const fixture = await executableFixture({ yes: false }, backend, undefined, { busyEnter: "wait" })
    try {
      fixture.app.state().prompt.text = "busy text"
      fixture.app.state().turn = {
        phase: "responding", attempts: 1, phaseMs: 0, turnMs: 0, tokens: 0, nowMs: 0, canStop: true,
      }
      fixture.app.dispatch("submit")
      expect(backend.calls).toContain("submit:busy text")
      expect(backend.calls).not.toContain("steer:busy text")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("writer + discovery + selection compose a ready canonical runtime (M49 controller plane)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ih-tui-provider-runtime-"))
    const settings = new SettingsStore({ path: join(root, "settings.json") })
    const credentials = createCredentialStore(join(root, "credentials.json"))
    const model: ModelClient = { async *stream() {} }
    try {
      await settings.load()
      await settings.set({
        llm: {
          providers: {
            fixture: {
              models: [{ id: "manual-model", name: "Manual", contextWindow: 64_000 }],
            },
          },
          defaultModel: { provider: "", model: "" },
        },
      })
      const registry = createProviderRegistry()
      registry.registerProbe("fixture", async () => [{ id: "discovered-model", name: "Discovered" }])
      const runtime = createProviderRuntime({ settings, credentials, registry, buildClient: () => model })
      const controller = new ProviderController({ runtime, settings })

      await controller.saveProvider({
        id: "fixture",
        displayName: "Fixture Provider",
        protocol: "openai-completions",
        baseURL: "https://fixture.example/v1/",
        modelsURL: "https://fixture.example/v1/models",
        apiKey: "fixture-key",
      })
      await controller.selectProvider("fixture")
      await controller.selectModel("discovered-model")

      await expect(runtime.resolveModel({})).resolves.toEqual({
        status: "ready",
        binding: {
          client: model,
          providerId: "fixture",
          modelId: "discovered-model",
          label: "fixture:discovered-model",
        },
      })
      expect(settings.getSectionMutationBase("llm")).toEqual({
        providers: {
          fixture: {
            displayName: "Fixture Provider",
            baseURL: "https://fixture.example",
            modelsURL: "https://fixture.example/v1/models",
            apiKeyEnv: "FIXTURE_API_KEY",
            protocol: "openai-completions",
            models: [
              { id: "manual-model", name: "Manual", contextWindow: 64_000 },
              { id: "discovered-model", name: "Discovered" },
            ],
          },
        },
        defaultModel: { provider: "fixture", model: "discovered-model" },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("adapts provider runtime clients into session-executor model bindings", async () => {
    const client = { async *stream() { yield { type: "end" as const } } }
    const seen: unknown[] = []
    const bindingFor = createTuiModelBindingFor({
      async resolveModel(input: unknown) {
        seen.push(input)
        return {
          status: "ready" as const,
          binding: {
            client,
            providerId: "fixture",
            modelId: "flag-model",
            label: "fixture:flag-model",
            reasoningEffort: "high" as const,
            contextWindow: 128_000,
          },
        }
      },
    }, "fixture:flag-model")

    await expect(bindingFor("s1", {
      modelSelection: { provider: "session", model: "selected" },
    } as never)).resolves.toEqual({
      status: "ready",
      binding: {
        model: client,
        providerId: "fixture",
        modelId: "flag-model",
        label: "fixture:flag-model",
        reasoningEffort: "high",
        contextWindow: 128_000,
      },
    })
    expect(seen).toEqual([{
      sessionSelection: { provider: "session", model: "selected" },
      override: "fixture:flag-model",
    }])
  })

  it("parses value flags in any order plus the boolean --yes", () => {
    expect(
      parseFlags(["--prompt", "hi there", "--workspace", "C:\\w", "--model", "deepseek:deepseek-chat", "--yes", "--session-dir", "C:\\sessions", "--resume", "s-123"]),
    ).toEqual({
      prompt: "hi there",
      workspace: "C:\\w",
      model: "deepseek:deepseek-chat",
      yes: true,
      sessionDir: "C:\\sessions",
      resume: "s-123",
    })
  })

  it("builds durable resume options without an initial kickoff", () => {
    expect(buildEmbeddedSessionOptions({ sessionDir: "C:\\sessions", resume: "s-123", prompt: "kickoff" })).toEqual({ prompt: "", storeRoot: "C:\\sessions", rewindStoreRoot: "C:\\sessions", resumeSessionId: "s-123" })
  })

  it("rejects resume without a durable session directory", () => {
    expect(() => buildEmbeddedSessionOptions({ resume: "s-123", prompt: "" })).toThrow(
      "--resume requires --session-dir",
    )
  })

  it("passes the durable root to the attached SDK and preserves ephemeral attach args", () => {
    expect(buildSdkArgs({ sessionDir: "C:\\sessions" })).toEqual(["sdk", "--session-dir", "C:\\sessions"])
    expect(buildSdkArgs({ sessionDir: undefined })).toEqual(["sdk"])
  })

  it("awaits backend close before teardown and shares concurrent shutdowns", async () => {
    const events: string[] = []
    let release!: () => void
    const close = () => new Promise<void>(resolve => { events.push("close-start"); release = () => { events.push("close-end"); resolve() } })
    const controller = createTuiShutdownController({ close, stop: () => events.push("stop"), teardown: () => events.push("teardown") })
    const first = controller.shutdown()
    const second = controller.shutdown()
    expect(first).toBe(second)
    await Promise.resolve()
    expect(events).toEqual(["stop", "close-start"])
    release()
    await first
    expect(events).toEqual(["stop", "close-start", "close-end", "teardown"])
  })

  it("attempts teardown and preserves close failures", async () => {
    const events: string[] = []
    const failure = new Error("flush failed")
    const controller = createTuiShutdownController({
      close: async () => { events.push("close"); throw failure },
      stop: () => events.push("stop"),
      teardown: () => events.push("teardown"),
    })

    await expect(controller.shutdown()).rejects.toBe(failure)
    expect(events).toEqual(["stop", "close", "teardown"])
  })

  it("treats every flag as optional and unknown flags as no-ops", () => {
    expect(parseFlags([])).toEqual({ yes: false })
    expect(parseFlags(["--unknown"])).toEqual({ yes: false })
  })
})

describe("tui production startup split (M49 Task 8)", () => {
  /** The REAL initSequence preamble with the full five-mode mouse set — its
   * PRESENCE in minimal proves the terminal was initialized (the red line). */
  function recordingTerminal(): TerminalHandles & { bytes: string } {
    const rec = { bytes: "" }
    return {
      get bytes(): string { return rec.bytes },
      init(): string {
        const seq = "\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h"
        rec.bytes += seq
        return seq
      },
      teardown(): string { return "" },
    }
  }

  const fakeInline = (): InlineHost => ({
    commit: (_lines: RegionLine[], write: (s: string) => void) => write(""),
    drawRegion: (write: (s: string) => void) => write(""),
    regionRows: () => 8,
    resize: () => {},
  })

  async function tuiFixture(options: {
    screenMode: "fullscreen" | "minimal"
    settingsSeed?: Record<string, unknown>
    loadInline?: (cols: number, rows: number) => Promise<InlineHost | undefined>
  }) {
    const root = mkdtempSync(join(tmpdir(), "ih-tui-exec-split-"))
    const settingsPath = join(root, "settings.json")
    if (options.settingsSeed !== undefined) {
      writeFileSync(settingsPath, JSON.stringify(options.settingsSeed))
    }
    const settings = new SettingsStore({ path: settingsPath })
    await settings.load()
    const credentials = createCredentialStore(join(root, "credentials.json"))
    const runtime = createProviderRuntime({ settings, credentials, registry: createProviderRegistry() })
    const backend = recordingBackend({ status: "ready", providerId: "fixture", modelId: "m", label: "fixture:m" })
    const providerController = new ProviderController({ runtime, settings, backend })
    const terminal = recordingTerminal()
    // the fixture mirrors runTui: the rendered palette resolves from the
    // PERSISTED theme (system = auto polarity), never a fixed default.
    const activeTheme = settings.get().theme
    const created = await createExecutableTui({
      flags: { yes: false },
      screenMode: options.screenMode,
      terminalFactory: () => terminal,
      cols: 80,
      rows: 24,
      renderer: createRenderer({ cols: 80, rows: 24, cap }),
      backend,
      engine: createScrollbackEngine({ width: 80 }),
      capabilities: cap,
      palette: resolvePalette(cap, activeTheme === "system" ? undefined : activeTheme),
      glyphs: makeGlyphs(true),
      write: () => {},
      settings,
      providerController,
      workspace: root,
      ...(options.loadInline !== undefined ? { loadInline: options.loadInline } : {}),
    })
    return { ...created, terminal, root, settingsPath }
  }

  it("seeds the runtime theme from the persisted choice — bare /theme anchors at the active theme", async () => {
    const fixture = await tuiFixture({
      screenMode: "fullscreen",
      settingsSeed: { theme: "tokyo-night" },
    })
    try {
      // the runtime state matches the rendered palette (persisted anchor).
      expect(fixture.app.state().theme).toBe("tokyo-night")
      fixture.app.state().prompt.text = "/theme"
      fixture.app.dispatch("submit")
      // the FIRST bare /theme is the NEXT in the cycle — never a discard of
      // the persisted choice to grok-night.
      await waitFor(() => fixture.app.state().theme === "rose-pine-moon" && fixture.app.state().theme !== "tokyo-night")
      expect(fixture.app.state().theme).toBe("rose-pine-moon")
      // the durable write lands the same value (rollback would restore the
      // anchor on failure — the preview is committed through the SAME path).
      await waitFor(() => JSON.parse(readFileSync(fixture.settingsPath, "utf8")).theme === "rose-pine-moon")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("uses explicit flag then persisted screen mode", () => {
    expect(resolveExecutableScreenMode({ flag: "fullscreen", persisted: "minimal" })).toBe("fullscreen")
    expect(resolveExecutableScreenMode({ persisted: "minimal" })).toBe("minimal")
    expect(resolveExecutableScreenMode({ flag: "minimal", persisted: "fullscreen" })).toBe("minimal")
    expect(resolveExecutableScreenMode({})).toBe("fullscreen")
    expect(resolveExecutableScreenMode({ persisted: "unknown" })).toBe("fullscreen")
  })

  it("does not initialize the alternate screen in minimal mode", async () => {
    const fixture = await tuiFixture({ screenMode: "minimal", loadInline: async () => fakeInline() })
    try {
      expect(fixture.terminal.bytes).toBe("")
      expect(fixture.terminal.bytes).not.toContain("\x1b[?1049h")
      expect(fixture.terminal.bytes).not.toMatch(/\x1b\[\?100[0-6]h/)
      expect(fixture.screenMode).toBe("minimal")
      expect(fixture.app.state().screen).toBe("minimal")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("fullscreen mode initializes the terminal (alt screen + five-mode mouse)", async () => {
    const fixture = await tuiFixture({ screenMode: "fullscreen" })
    try {
      expect(fixture.terminal.bytes).toContain("\x1b[?1049h")
      expect(fixture.terminal.bytes).toMatch(/\x1b\[\?100[0-6]h/)
      expect(fixture.screenMode).toBe("fullscreen")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("inline-engine failure: ONE warning, fullscreen fallback, persisted screen mode untouched", async () => {
    const warns: string[] = []
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warns.push(args.join(" ")) })
    const fixture = await tuiFixture({
      screenMode: "minimal",
      settingsSeed: { tui: { prefs: { screenMode: "minimal" } } },
      loadInline: async () => undefined,
    })
    spy.mockRestore()
    try {
      expect(warns).toHaveLength(1)
      expect(warns[0]).toMatch(/inline engine is unavailable/i)
      // fall back to fullscreen — the terminal was initialized.
      expect(fixture.terminal.bytes).toContain("\x1b[?1049h")
      expect(fixture.screenMode).toBe("fullscreen")
      // the fallback is a REAL fullscreen start (the welcome screen).
      expect(fixture.app.state().screen).toBe("welcome")
      // the persisted choice is NOT rewritten.
      expect(JSON.parse(readFileSync(fixture.settingsPath, "utf8")).tui.prefs.screenMode).toBe("minimal")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})


describe("tui production interaction bridges (M49 Task 10)", () => {
  async function waitHost(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!cond()) {
      if (Date.now() >= deadline) throw new Error("condition did not settle")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  /** Poll-based event projection of a live session's durable log (the
   * production mapper — no subscription needed). */
  function mappedOf(service: ReturnType<typeof createSessionService>, sessionId: string): TuiEvent[] {
    const session = service.liveSession(sessionId)
    if (session === undefined) return []
    const state = createEventMapState()
    const out: TuiEvent[] = []
    for (const ev of session.events) {
      const m = mapSessionEvent(ev as never, state)
      if (m !== undefined) out.push(m)
    }
    return out
  }

  it("attaches approval and question bridges to every production assembly (approveAll:false)", async () => {
    const host = await createExecutableHost({ approveAll: false })
    try {
      const assembly = await host.service.assemblyFor("s1")
      expect(host.approvals.isAttached(assembly.ctx)).toBe(true)
      expect(host.questions.isAttached(assembly.ctx)).toBe(true)
    } finally {
      await host.close()
    }
  })

  it("fail-closed: an assembly without a UI provider denies the ask (no answerer registered)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ih-host-failclosed-"))
    const service = createSessionService({
      workspace,
      approveAll: false,
      modelPolicy: "test-mock",
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "bash", args: { command: "rm -rf node_modules" } }] },
        { role: "assistant", text: "done" },
      ],
    })
    try {
      await service.assemblyFor("s1") // build the assembly WITHOUT any bridge
      // the deny happens at the dispatch (no answerer ⇒ fail closed) — the
      // turn REJECTS with the verdict; the call event is still in the log.
      await expect(service.submit("s1", "run it", new AbortController().signal))
        .rejects.toThrow(/no answerer|fail closed|approval required/i)
      const running = mappedOf(service, "s1").filter((e) => e.type === "tool" && e.status === "running")
      expect(running.length).toBeGreaterThanOrEqual(1)
    } finally {
      await service.close().catch(() => {})
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 60_000)

  it("one-shot real: an approval answered through the bridge lets the bash tool RUN", async () => {
    const host = await createExecutableHost({
      approveAll: false,
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "bash", args: { command: "rm -rf node_modules && echo bridge-ran" } }] },
        { role: "assistant", text: "done" },
      ],
    })
    try {
      const it = host.bridge.approvals()[Symbol.asyncIterator]()
      await host.service.assemblyFor("s1")
      const submitP = host.service.submit("s1", "run it", new AbortController().signal).catch(() => {})
      await waitHost(() => mappedOf(host.service, "s1").some((e) => e.type === "tool" && e.status === "running"), 30_000)
      // the bridge surfaced exactly one permission for this turn
      const surface = (await Promise.race([
        it.next().then((r) => r.value),
        new Promise((resolve) => setTimeout(() => resolve(undefined), 8_000)),
      ])) as { id: string } | undefined
      expect(surface).toBeDefined()
      expect(surface).toMatchObject({ kind: "bash" })
      await host.bridge.answerApproval(surface!.id, { approved: true })
      await waitHost(() => mappedOf(host.service, "s1").some((e) => e.type === "tool" && e.status === "done"), 30_000)
      const done = mappedOf(host.service, "s1").find((e) => e.type === "tool" && e.status === "done")!
      expect(done.type === "tool" && done.output).toContain("bridge-ran")
      // one-shot: a second answer to the same surface id is a no-op
      await expect(host.bridge.answerApproval(surface!.id, { approved: false })).resolves.toBeUndefined()
    } finally {
      await host.close()
    }
  }, 120_000)

  it("production pump: a real approval through runTui's pumpInteractionBridge surfaces into the app overlay and the answer lets the guarded shell run", async () => {
    const host = await createExecutableHost({
      approveAll: false,
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "bash", args: { command: "rm -rf node_modules && echo pumped-ok" } }] },
        { role: "assistant", text: "done" },
      ],
    })
    const backend = recordingBackend({ status: "ready", providerId: "fixture", modelId: "m", label: "fixture:m" })
    const fixture = await executableFixture({ yes: false }, backend)
    try {
      const pumpP = pumpInteractionBridge(fixture.app, host.bridge)
      await host.service.assemblyFor("s1")
      const submitP = host.service.submit("s1", "run it", new AbortController().signal).catch(() => {})
      // THE production route: bridge → pump → app.state().overlay (permission).
      await waitHost(() => {
        const ov = fixture.app.state().overlay
        return ov !== undefined && (ov as { kind?: string }).kind === "permission"
      }, 30_000)
      // answer through the overlay's own digit-accept path (1-based: 3 = "Yes, proceed").
      fixture.app.dispatch({ type: "overlay-accept", index: 3 })
      // the guard's shell REALLY runs after the real approval.
      await waitHost(() => mappedOf(host.service, "s1").some((e) => e.type === "tool" && e.status === "done"), 30_000)
      const done = mappedOf(host.service, "s1").find((e) => e.type === "tool" && e.status === "done")!
      expect(done.type === "tool" && done.output).toContain("pumped-ok")
      await submitP
      void pumpP // the pump never settles (the streams stay open) — fire-and-forget
    } finally {
      await host.close()
    }
  }, 120_000)
})
