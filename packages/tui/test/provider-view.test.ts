// M46a G1: the /provider view — the wizard state machine + the binder's
// nav/save/delete semantics. The binder is driven through its OverlaySeam
// contract: act() with AppActions + the FREEform slot (chars/Enter/Esc) —
// exactly the loop's dispatch path (freeform pre-keymap, then the keymap's
// overlay actions for nav).

import { describe, expect, it } from "vitest"
import { normalizeSettings, type Settings, type SettingsStoreSurface } from "@i-harness/settings"
import {
  bindProviderOverlay,
  makeWizard,
  menuRows,
  wizardAdvance,
  wizardAppend,
  wizardBackspace,
  wizardEntryOf,
  wizardSwitchField,
  type ProviderViewState,
} from "../src/views/provider.ts"
import { ProviderStore, type FetchedModel, type ProviderEntry } from "../src/app/provider-store.ts"

const ENTRY: ProviderEntry = { id: "deepseek", baseUrl: "https://api.deepseek.com", protocol: "openai-compatible" }

function fakeSettings(initial: Partial<Settings> = {}): SettingsStoreSurface {
  let current = normalizeSettings(initial)
  return {
    get: () => current,
    isLoaded: () => true,
    load: async () => current,
    set: async (patch) => {
      current = normalizeSettings({ ...current, ...patch })
      return current
    },
    reset: async () => {
      current = normalizeSettings(undefined)
      return current
    },
    getSectionRevision: () => 0,
  }
}

function harness(initial: Partial<Settings> = {}, fetched: FetchedModel[] = []): {
  store: ProviderStore
  settings: SettingsStoreSurface
  saved: Array<{ kind: "add" | "update" | "delete"; id: string }>
  closed: () => boolean
} {
  const settings = fakeSettings(initial)
  const values = new Map<string, string>()
  const store = new ProviderStore({
    settings,
    credentials: {
      describe: (refs) => Object.fromEntries(refs.map((r) => [r, { configured: values.has(r), source: "file" as const, writable: true }])),
      set: async (ref, v) => { values.set(ref, v) },
      unset: async (ref) => { values.delete(ref) },
      resolve: (ref) => values.get(ref),
    },
    fetchFn: (async () => new Response(JSON.stringify({ data: fetched }), { status: 200 })) as unknown as typeof fetch,
  })
  const saved: Array<{ kind: "add" | "update" | "delete"; id: string }> = []
  let closed = false
  const ctx = { store, settings, saved, closed: () => closed } as { store: ProviderStore; settings: SettingsStoreSurface; saved: Array<{ kind: "add" | "update" | "delete"; id: string }>; closed: () => boolean }
  return { ...ctx, closed: () => closed, store, settings, saved }
}

// ------------------------------------------------------------------ pure wizard

describe("provider view — wizard state machine (pure)", () => {
  it("append/backspace target the ACTIVE field only; ↑↓ switches fields", () => {
    const w = makeWizard()
    wizardAppend(w, "deep")
    wizardSwitchField(w, 1)
    wizardAppend(w, "https://api.deepseek.com")
    wizardSwitchField(w, 1)
    wizardAppend(w, "sk-123456")
    expect(w.buffers).toEqual(["deep", "https://api.deepseek.com", "sk-123456"])
    expect(w.field).toBe(2)
    wizardSwitchField(w, -1)
    expect(w.field).toBe(1)
    expect(wizardAdvance(w)).toBe("next")
    wizardBackspace(w)
    expect(w.buffers[1]).toBe("https://api.deepseek.co")
  })

  it("wizardAdvance: empty id/url → error; step 2 → save", () => {
    const w = makeWizard()
    expect(wizardAdvance(w)).toBe("error")
    wizardAppend(w, "deepseek")
    expect(wizardAdvance(w)).toBe("next")
    w.field = 1
    expect(wizardAdvance(w)).toBe("error")
    wizardAppend(w, "https://x")
    expect(wizardAdvance(w)).toBe("next")
    w.field = 2
    expect(wizardAdvance(w)).toBe("save")
    expect(wizardEntryOf(w)).toEqual({ id: "deepseek", baseUrl: "https://x", protocol: "openai-compatible" })
  })

  it("menuRows: providers then `+ Add provider` then `Delete provider...`", () => {
    expect(menuRows([ENTRY])).toEqual([
      { kind: "provider", id: "deepseek" },
      { kind: "add" },
      { kind: "delete" },
    ])
  })
})

// ------------------------------------------------------------------ binder

describe("provider view — binder flow (store + discovery + active)", () => {
  it("menu → `+ Add provider` → wizard → 3 Enter-saves → upsert + key-ref + setActive + discovery + onSaved(add)", async () => {
    const h = harness({}, [{ id: "deepseek-chat" }, { id: "deepseek-reasoner", name: "Reasoner" }])
    const state: ProviderViewState = {
      phase: "menu", cursor: 0, providers: h.store.list(), wizard: undefined, pendingId: undefined, error: undefined,
    }
    const seam = bindProviderOverlay(state, {
      store: h.store,
      activeId: "",
      onSaved: (o) => h.saved.push(o),
      onClose: () => {},
      onToast: () => {},
    })
    // an EMPTY store's menu rows are [add, delete] — row 0 = `+ Add provider`
    seam.act!("overlay-select")
    expect(state.phase).toBe("wizard")
    expect(state.wizard?.field).toBe(0)
    const ff = seam.freeform!
    // field 0: id
    ff.append("deepseek")
    ff.submit()
    expect(state.wizard?.field).toBe(1)
    // field 1: url
    ff.append("https://api.deepseek.com")
    ff.submit()
    expect(state.wizard?.field).toBe(2)
    // ↑↓ switches fields (the keymap fall-through)
    seam.act!("overlay-nav-prev")
    expect(state.wizard?.field).toBe(1)
    seam.act!("overlay-nav-next")
    expect(state.wizard?.field).toBe(2)
    // field 2: key (masked at render — buffers keep the raw for the store write)
    ff.append("sk-dummy-key-1234")
    ff.submit()
    await new Promise((r) => setTimeout(r, 20)) // the save's async writes resolve
    const doc = h.store.get("deepseek")
    expect(doc).toMatchObject({ baseUrl: "https://api.deepseek.com", protocol: "openai-compatible", apiKeyRef: "DEEPSEEK_API_KEY" })
    expect(h.store.resolveKey("deepseek")).toBe("sk-dummy-key-1234")
    expect(h.store.activeId()).toBe("deepseek")
    expect(h.saved).toEqual([{ kind: "add", id: "deepseek" }])
    // discovery memoized (the injectable fetch returned the two fake models)
    await h.store.discoverModels("deepseek")
    expect(h.store.cachedModels("deepseek")?.map((m) => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner"])
  })

  it("editing keeps the existing key when the key field is left empty (keep-current-key)", async () => {
    const h = harness()
    await h.store.upsert(ENTRY)
    await h.store.setApiKey("deepseek", "sk-original")
    const state: ProviderViewState = {
      phase: "menu", cursor: 0, providers: h.store.list(), wizard: undefined, pendingId: undefined, error: undefined,
    }
    const seam = bindProviderOverlay(state, {
      store: h.store,
      activeId: "deepseek",
      onSaved: (o) => h.saved.push(o),
      onClose: () => {},
      onToast: () => {},
    })
    const ff = seam.freeform!
    // simulate reopening the wizard editing (the binder's own open path):
    state.phase = "wizard"
    state.wizard = makeWizard(ENTRY, true)
    ff.submit() // field 0 → 1
    ff.submit() // field 1 → 2
    ff.submit() // field 2 -> save (empty key → ref kept)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.store.resolveKey("deepseek")).toBe("sk-original")
    expect(h.store.get("deepseek")?.apiKeyRef).toBe("DEEPSEEK_API_KEY")
  })

  it("menu Enter on a provider row = use (setActive) + onSaved(update) + close", async () => {
    const h = harness()
    await h.store.upsert(ENTRY)
    await h.store.setApiKey("deepseek", "sk-k")
    const state: ProviderViewState = {
      phase: "menu", cursor: 0, providers: h.store.list(), wizard: undefined, pendingId: undefined, error: undefined,
    }
    let closed = false
    const seam = bindProviderOverlay(state, {
      store: h.store,
      activeId: "",
      onSaved: (o) => h.saved.push(o),
      onClose: () => { closed = true },
      onToast: () => {},
    })
    seam.act!("overlay-select")
    await new Promise((r) => setTimeout(r, 10))
    expect(h.store.activeId()).toBe("deepseek")
    expect(h.saved).toEqual([{ kind: "update", id: "deepseek" }])
    expect(closed).toBe(true)
  })

  it("delete flow: menu → `Delete provider...` → list → Enter → confirm → y row → remove + onSaved(delete)", async () => {
    const h = harness()
    await h.store.upsert(ENTRY)
    const state: ProviderViewState = {
      phase: "menu", cursor: 0, providers: h.store.list(), wizard: undefined, pendingId: undefined, error: undefined,
    }
    const seam = bindProviderOverlay(state, {
      store: h.store,
      activeId: "",
      onSaved: (o) => h.saved.push(o),
      onClose: () => {},
      onToast: () => {},
    })
    const rows = menuRows(state.providers) // 1 provider + add + delete
    state.cursor = rows.length - 1
    seam.act!("overlay-select") // → delete phase
    expect(state.phase).toBe("delete")
    seam.act!("overlay-select") // → confirm (cursor on the row)
    expect(state.phase).toBe("confirm-delete")
    expect(state.pendingId).toBe("deepseek")
    seam.act!("overlay-select") // y row → remove
    await new Promise((r) => setTimeout(r, 10))
    expect(h.store.has("deepseek")).toBe(false)
    expect(h.saved).toEqual([{ kind: "delete", id: "deepseek" }])
  })

  it("Esc semantics: wizard → menu (freeform abort), menu → close", async () => {
    const h = harness()
    const state: ProviderViewState = {
      phase: "menu", cursor: 0, providers: [], wizard: undefined, pendingId: undefined, error: undefined,
    }
    let closed = false
    const seam = bindProviderOverlay(state, {
      store: h.store,
      activeId: "",
      onSaved: () => {},
      onClose: () => { closed = true },
      onToast: () => {},
    })
    // open the wizard through the add row (0 providers → index 0 = add)
    seam.act!("overlay-select")
    expect(state.phase).toBe("wizard")
    seam.freeform!.abort() // the loop's Esc → freeform abort
    expect(state.phase).toBe("menu")
    seam.act!("overlay-dismiss") // menu Esc → close
    expect(closed).toBe(true)
  })
})
