// apps/tui — the tui command is thin wiring; this test pins the flag parser
// so the CLI surface cannot drift silently (the PTY proofs of the render
// pipeline live in packages/tui/test/harness — cases 011/014).

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createCredentialStore } from "@i-harness/credentials"
import type { ModelClient } from "@i-harness/llm-seam"
import { createProviderRegistry } from "@i-harness/provider"
import { createProviderRuntime } from "@i-harness/provider-runtime"
import { SettingsStore } from "@i-harness/settings"
import { createRenderer, createUnknownCapabilities, makeGlyphs, resolvePalette } from "@i-harness/tui-core"
import { ProviderController, createScrollbackEngine } from "@i-harness/tui"
import type { BackendClient, InputSource, TuiEvent } from "@i-harness/tui"
import {
  buildEmbeddedSessionOptions,
  buildSdkArgs,
  createExecutableApp,
  createTuiModelBindingFor,
  createTuiShutdownController,
  parseFlags,
} from "../src/index.ts"

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
    steer: async () => {},
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
) {
  const root = mkdtempSync(join(tmpdir(), "ih-tui-executable-"))
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
