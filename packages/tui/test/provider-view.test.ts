// M49 Task 6: the /provider master/detail — the editor state machine + the
// binder's list → edit → discovery → models → default/session selection and
// delete semantics. Driven through the OverlaySeam contract (act() with
// AppActions + the freeform slot) — exactly the loop's dispatch path.

import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SettingsStore } from "@i-harness/settings"
import { createCredentialStore } from "@i-harness/credentials"
import { createProviderRegistry } from "@i-harness/provider"
import { createProviderRuntime } from "@i-harness/provider-runtime"
import { ProviderController } from "../src/app/provider-controller.ts"
import {
  bindProviderOverlay,
  editorAdvance,
  editorAppend,
  editorBackspace,
  editorSwitchField,
  makeDraft,
  manualModelOf,
  providerRows,
  type ProviderEditorState,
} from "../src/views/provider.ts"

async function fixture(options: {
  providers?: Record<string, unknown>
  defaultModel?: { provider: string; model: string }
  credentials?: Record<string, string>
  probe?: (registry: ReturnType<typeof createProviderRegistry>) => void
} = {}): Promise<{ controller: ProviderController; settings: SettingsStore; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "tui-provider-view-"))
  const settings = new SettingsStore({ path: join(root, "settings.json") })
  await settings.load()
  if (options.providers !== undefined) {
    await settings.set({
      llm: {
        providers: options.providers as never,
        defaultModel: options.defaultModel ?? { provider: "", model: "" },
      },
    })
  }
  const credentials = createCredentialStore(join(root, "credentials.json"))
  for (const [ref, value] of Object.entries(options.credentials ?? {})) {
    await credentials.set(ref, value)
  }
  const registry = createProviderRegistry()
  options.probe?.(registry)
  const runtime = createProviderRuntime({
    settings,
    credentials,
    registry,
    buildClient: () => ({ async *stream() {} }),
  })
  const controller = new ProviderController({ runtime, settings })
  return { controller, settings, root }
}

const DEEPSEEK = {
  baseURL: "https://api.deepseek.com",
  protocol: "openai-completions",
  apiKeyEnv: "DEEPSEEK_API_KEY",
}

async function seededList(): Promise<{ controller: ProviderController; settings: SettingsStore; root: string }> {
  return fixture({
    providers: { deepseek: { ...DEEPSEEK } },
    credentials: { DEEPSEEK_API_KEY: "sk-key" },
    probe: (registry) => registry.registerProbe("deepseek", async () => [
      { id: "deepseek-chat", name: "DeepSeek Chat" },
      { id: "deepseek-reasoner", name: "Reasoner" },
    ]),
  })
}

function blankState(): ProviderEditorState {
  return {
    mode: "list",
    cursor: 0,
    rows: [],
    draft: undefined,
    field: 0,
    editingId: undefined,
    hasExistingKey: false,
    models: [],
    manual: undefined,
    providerId: "",
    pendingId: undefined,
    error: undefined,
  }
}

async function seededState(f: { controller: ProviderController }): Promise<ProviderEditorState> {
  const state = blankState()
  state.rows = providerRows(await f.controller.directory())
  return state
}

describe("provider master/detail — pure editor helpers", () => {
  it("append/backspace target the ACTIVE field only; ↑↓ switches fields", () => {
    const state: ProviderEditorState = { ...blankState(), mode: "edit", draft: makeDraft() }
    editorAppend(state, "deep")
    editorSwitchField(state, 1)
    editorAppend(state, "https://api.deepseek.com")
    editorSwitchField(state, 1)
    editorAppend(state, "sk-123456")
    expect(state.draft).toEqual({ id: "deep", baseURL: "https://api.deepseek.com", apiKey: "sk-123456" })
    expect(state.field).toBe(2)
    editorSwitchField(state, -1)
    expect(state.field).toBe(1)
    expect(editorAdvance(state)).toBe("next")
    editorBackspace(state)
    expect(state.draft?.baseURL).toBe("https://api.deepseek.co")
  })

  it("editorAdvance: empty id/url → error; step 2 → save", () => {
    const state: ProviderEditorState = { ...blankState(), mode: "edit", draft: makeDraft() }
    expect(editorAdvance(state)).toBe("error")
    editorAppend(state, "deepseek")
    expect(editorAdvance(state)).toBe("next")
    state.field = 1
    expect(editorAdvance(state)).toBe("error")
    editorAppend(state, "https://x")
    expect(editorAdvance(state)).toBe("next")
    state.field = 2
    expect(editorAdvance(state)).toBe("save")
  })

  it("manualModelOf validates a non-empty id + positive optional capacities", () => {
    expect(manualModelOf({ field: 2, buffers: ["m1", "", ""] })).toEqual({ model: { id: "m1" } })
    expect(manualModelOf({ field: 2, buffers: ["m1", "128000", "4096"] })).toEqual({
      model: { id: "m1", contextWindow: 128000, maxTokens: 4096 },
    })
    expect(manualModelOf({ field: 2, buffers: ["", "", ""] })).toEqual({ error: "model id is required" })
    expect(manualModelOf({ field: 2, buffers: ["m1", "-1", ""] })).toEqual({ error: "contextWindow must be a positive integer" })
    expect(manualModelOf({ field: 2, buffers: ["m1", "0", ""] })).toEqual({ error: "contextWindow must be a positive integer" })
  })

  it("providerRows maps the runtime directory rows (configured flag + key state)", async () => {
    const f = await seededList()
    try {
      const rows = providerRows(await f.controller.directory())
      expect(rows).toEqual([{
        id: "deepseek",
        displayName: "deepseek",
        configured: true,
        hasKey: true,
      }])
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})

describe("provider master/detail — binder flow", () => {
  function harness(controller: ProviderController, state: ProviderEditorState) {
    const saved: Array<{ kind: "add" | "update" | "delete"; id: string }> = []
    const toasts: string[] = []
    let closed = false
    const seam = bindProviderOverlay(state, {
      controller,
      onSaved: (o) => saved.push(o),
      onClose: () => { closed = true },
      onToast: (text) => toasts.push(text),
    })
    return { seam, saved, toasts, closed: () => closed }
  }

  it("list → Enter on a configured row → editor → save (empty key keeps the current) → discovery → models → Enter selects + closes", async () => {
    const f = await seededList()
    try {
      const state = await seededState(f)
      const h = harness(f.controller, state)
      seamOpenConfigured(h.seam, state)
      // editor prefilled (id/baseURL from the stored config; key field empty)
      expect(state.draft).toEqual({ id: "deepseek", baseURL: "https://api.deepseek.com", apiKey: "" })
      expect(state.hasExistingKey).toBe(true)
      const ff = h.seam.freeform!
      ff.submit() // field 0 → 1 (id prefilled — no typing needed)
      expect(state.field).toBe(1)
      ff.submit() // field 1 → 2 (url prefilled — skipped)
      expect(state.field).toBe(2)
      ff.submit() // empty key → KEEPS the current key (no setApiKey)
      await new Promise((r) => setTimeout(r, 80)) // save → selectProvider (discovery) → models
      expect(state.mode).toBe("models")
      expect(state.providerId).toBe("deepseek")
      expect(state.models.map((m) => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner"])
      expect(f.settings.get().llm.providers.deepseek?.apiKeyEnv).toBe("DEEPSEEK_API_KEY")
      expect(h.toasts.some((t) => t.includes("2 model(s)"))).toBe(true)
      // Enter on the first model → the durable default is set + the flow closes.
      h.seam.act!("overlay-select")
      await new Promise((r) => setTimeout(r, 20))
      expect(f.settings.get().llm.defaultModel).toEqual({ provider: "deepseek", model: "deepseek-chat" })
      expect(h.closed()).toBe(true)
      expect(h.saved).toEqual([{ kind: "update", id: "deepseek" }])
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it("a failed discovery preserves stored models and shows the attempt summary in the models mode", async () => {
    const f = await fixture({
      providers: { deepseek: { ...DEEPSEEK, models: [{ id: "manual-model" }] } },
      credentials: { DEEPSEEK_API_KEY: "sk-key" },
      probe: (registry) => registry.registerProbe("deepseek", async () => { throw new Error("GET https://api.deepseek.com → 500; GET https://api.deepseek.com → 500") }),
    })
    try {
      const state = await seededState(f)
      const h = harness(f.controller, state)
      seamOpenConfigured(h.seam, state)
      h.seam.freeform!.submit()
      h.seam.freeform!.submit()
      h.seam.freeform!.submit()
      await new Promise((r) => setTimeout(r, 60))
      expect(state.mode).toBe("models")
      expect(state.models.map((m) => m.id)).toEqual(["manual-model"]) // preserved
      expect(state.error).toMatch(/→ 500/)
      expect(h.toasts.some((t) => t.includes("stored models preserved"))).toBe(true)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it("manual model add validates + merges into the stored catalog (custom capacities kept)", async () => {
    const f = await fixture({
      providers: { deepseek: { ...DEEPSEEK } },
      credentials: { DEEPSEEK_API_KEY: "sk-key" },
      probe: (registry) => registry.registerProbe("deepseek", async () => [{ id: "deepseek-chat" }]),
    })
    try {
      const state = await seededState(f)
      state.mode = "models"
      state.providerId = "deepseek"
      state.models = await f.controller.modelsOf("deepseek")
      const h = harness(f.controller, state)
      // Enter on `+ Add model (manual)` (row after the catalog tail).
      state.cursor = state.models.length
      h.seam.act!("overlay-select")
      expect(state.manual).toBeDefined()
      h.seam.freeform!.append("manual-model")
      h.seam.freeform!.submit() // → contextWindow field
      h.seam.freeform!.append("64000")
      h.seam.freeform!.submit() // → maxTokens field
      h.seam.freeform!.append("0")
      h.seam.freeform!.submit() // invalid: capacity must be positive
      await new Promise((r) => setTimeout(r, 10))
      expect(state.error).toBe("maxTokens must be a positive integer")
      h.seam.freeform!.backspace() // "0" → ""
      h.seam.freeform!.submit()
      await new Promise((r) => setTimeout(r, 30))
      expect(state.manual).toBeUndefined()
      expect(state.models.some((m) => m.id === "manual-model" && m.contextWindow === 64000)).toBe(true)
      expect(f.settings.get().llm.providers.deepseek?.models?.some((m) => m.id === "manual-model")).toBe(true)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it("delete flow: list → `Delete provider...` → confirm → y row → remove + close", async () => {
    const f = await seededList()
    try {
      const state = await seededState(f)
      const h = harness(f.controller, state)
      const rows = state.rows.length
      state.cursor = rows + 1 // the Delete provider... row
      h.seam.act!("overlay-select")
      expect(state.mode).toBe("confirm-delete")
      expect(state.pendingId).toBe("deepseek")
      h.seam.act!("overlay-select") // y row → remove
      await new Promise((r) => setTimeout(r, 20))
      expect(f.settings.get().llm.providers.deepseek).toBeUndefined()
      expect(h.saved).toEqual([{ kind: "delete", id: "deepseek" }])
      expect(h.closed()).toBe(true)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it("add flow: `+ Add provider` → editor → id/url/key → save + discovery + add-side toast", async () => {
    const f = await fixture({
      probe: (registry) => registry.registerProbe("custom", async () => [{ id: "custom-model" }]),
    })
    try {
      const state = await seededState(f)
      const h = harness(f.controller, state)
      // empty list → row 0 = `+ Add provider`
      h.seam.act!("overlay-select")
      expect(state.mode).toBe("edit")
      expect(state.editingId).toBeUndefined()
      const ff = h.seam.freeform!
      ff.append("custom")
      ff.submit()
      ff.append("https://api.custom.example")
      ff.submit()
      ff.append("sk-custom-key")
      ff.submit() // key bound through the credential store
      await new Promise((r) => setTimeout(r, 80))
      expect(state.mode).toBe("models")
      expect(state.models.map((m) => m.id)).toEqual(["custom-model"])
      expect(f.settings.get().llm.providers.custom).toMatchObject({
        baseURL: "https://api.custom.example",
        protocol: "openai-completions",
        apiKeyEnv: "CUSTOM_API_KEY",
      })
      expect(h.saved).toEqual([{ kind: "add", id: "custom" }])
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it("a duplicate id on add fails loud (never overwrites an unknown provider)", async () => {
    const f = await seededList()
    try {
      const state = await seededState(f)
      const h = harness(f.controller, state)
      state.cursor = state.rows.length // the `+ Add provider` row
      h.seam.act!("overlay-select")
      h.seam.freeform!.append("deepseek")
      h.seam.freeform!.submit()
      h.seam.freeform!.append("https://x")
      h.seam.freeform!.submit()
      h.seam.freeform!.submit()
      await new Promise((r) => setTimeout(r, 10))
      expect(state.error).toBe('provider "deepseek" already exists')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it("Esc semantics: editor → list (freeform abort), list → close", async () => {
    const f = await seededList()
    try {
      const state = await seededState(f)
      const h = harness(f.controller, state)
      h.seam.act!("overlay-select") // open editor on deepseek (row 0)
      expect(state.mode).toBe("edit")
      h.seam.freeform!.abort()
      expect(state.mode).toBe("list")
      h.seam.act!("overlay-dismiss")
      expect(h.closed()).toBe(true)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})

/** Drive: list → Enter on the configured provider row (the state is seeded
 * over the roster). */
function seamOpenConfigured(seam: ReturnType<typeof bindProviderOverlay>, state: ProviderEditorState): void {
  state.cursor = 0
  seam.act!("overlay-select")
  expect(state.mode).toBe("edit")
}
