/**
 * Task 2A (2026-09-17): the TUI-only settings keys are retired.
 *
 * Deleting a key from the settings schema is not the same as deleting an unused
 * export — users have `settings.json` files on disk that already carry these
 * keys (`C:\Users\IvanKwan\.i-harness\settings.json` is one: it carries `theme`,
 * `transcriptMode`, `busyEnter` and the whole `tui.prefs` block). What happens to
 * such a document once the key is gone is the question this file pins.
 *
 * The answer, established by reading the loader rather than by adding a shim
 * (line numbers are as of the change that retired the keys):
 *
 *   TOLERATED ON READ. `normalizeSettings` (`packages/settings/src/index.ts:542`)
 *   is a field-by-field projection — it names each key it knows
 *   (`:558` `sandboxMode: oneOf(raw.sandboxMode, …)`, `:561`
 *   `fontSize: numberInList(raw.fontSize, …)`, …) and simply never reads a key it
 *   does not name. Nothing validates the document against the schema, no
 *   `satisfies`, no strict-parse; and `load()` (`:656`) wraps the whole read in
 *   try/catch, so even a corrupt file degrades to defaults instead of throwing.
 *   Removing a key from the projection therefore cannot make an existing document
 *   unloadable.
 *
 *   DROPPED ON THE NEXT WRITE. `persist()` (`:764`) writes `rawWithPins()`
 *   (`:750`), i.e. the NORMALIZED snapshot, so the first `set()`/`reset()` after
 *   the upgrade rewrites the file without the retired keys. That is this
 *   package's documented D5 stance — "no migration chain, no file rewrite"
 *   (`:59`, `:133`, `:247`) — so the drop IS the migration and no migration code
 *   is warranted.
 *
 * Red-first: the `toEqual([])` assertions below failed while the keys were still
 * in the schema (measured output in the task report).
 */
import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SettingsStore } from "../src/index.ts"

/** The 14 `unconsulted-setting` rows the classification puts in bucket T. */
const RETIRED_KEYS = [
  "theme",
  "busyEnter",
  "transcriptMode",
  "tui.prefs.timestamps",
  "tui.prefs.alwaysApprove",
  "tui.prefs.scrollSpeed",
  "tui.prefs.scrollMode",
  "tui.prefs.scrollLines",
  "tui.prefs.invertScroll",
  "tui.prefs.keepTextSelection",
  "tui.prefs.wordSeparators",
  "tui.prefs.mouseReportingToggle",
  "tui.prefs.screenMode",
  "tui.prefs.dashboard.pinned",
] as const

/** A user's on-disk document: every retired key set to a NON-default value, so a
 *  surviving key is visible as data rather than as a coincidental default. */
const USER_DOCUMENT = {
  sandboxMode: "read-only",
  model: "deepseek:deepseek-flash",
  language: "zh",
  theme: "grok-night",
  fontSize: 15,
  transcriptMode: "compact",
  busyEnter: "wait",
  searchBackend: "jsonl",
  plugins: { agentLoop: true, bash: false, webSearch: true, subagentModel: false },
  llm: {
    providers: { deepseek: { baseURL: "https://api.deepseek.com", protocol: "openai-completions" } },
    defaultModel: { provider: "deepseek", model: "deepseek-flash" },
  },
  onboarding: { welcomeNoticeVersion: "2026-08-30.1" },
  compaction: { auto: true },
  tui: {
    prefs: {
      timestamps: true,
      compact: true,
      guardian: true,
      alwaysApprove: false,
      scrollSpeed: 3,
      scrollMode: "trackpad",
      scrollLines: 7,
      invertScroll: true,
      keepTextSelection: "hold",
      wordSeparators: "abc",
      mouseReportingToggle: true,
      screenMode: "minimal",
      dashboard: { pinned: ["s1", "s2"], order: ["s2", "s1"] },
      statusLine: { mode: "command", items: ["cwd", "queue"], command: "git status --short", refreshMs: 500 },
    },
  },
}

function atPath(doc: unknown, path: string): unknown {
  let cur: unknown = doc
  for (const seg of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** Paths still present, so a failure names the survivors instead of just saying
 *  "expected []". */
function survivors(doc: unknown): string[] {
  return RETIRED_KEYS.filter((key) => atPath(doc, key) !== undefined)
}

async function withUserDocument<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ih-settings-retired-"))
  const file = join(root, "settings.json")
  await writeFile(file, JSON.stringify(USER_DOCUMENT, null, 2), "utf8")
  try {
    return await fn(file)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("retired TUI-only settings keys (Task 2A)", () => {
  it("an existing settings.json carrying every retired key still loads, and none of them reaches the snapshot", async () => {
    await withUserDocument(async (file) => {
      const store = new SettingsStore({ path: file })
      // The whole point: this must resolve, not reject. A document written by an
      // older build is not a document this build may refuse to read.
      const loaded = (await store.load()) as unknown as Record<string, unknown>

      expect(survivors(loaded)).toEqual([])

      // The drop is targeted: the surviving keys are read from the same file.
      expect(loaded.sandboxMode).toBe("read-only")
      expect(loaded.model).toBe("deepseek:deepseek-flash")
      expect(loaded.fontSize).toBe(15)
      expect(atPath(loaded, "llm.providers.deepseek.baseURL")).toBe("https://api.deepseek.com")
      expect(atPath(loaded, "tui.prefs.compact")).toBe(true)
      expect(atPath(loaded, "tui.prefs.guardian")).toBe(true)
      expect(atPath(loaded, "tui.prefs.dashboard.order")).toEqual(["s2", "s1"])
      expect(atPath(loaded, "tui.prefs.statusLine.mode")).toBe("command")
    })
  })

  it("the retired keys are absent from the defaults document and from an empty normalize", async () => {
    const { normalizeSettings, SETTINGS_DEFAULTS } = await import("../src/index.ts")
    expect(survivors(SETTINGS_DEFAULTS)).toEqual([])
    expect(survivors(normalizeSettings(undefined))).toEqual([])
    // A document whose ONLY content is retired keys is not a special case: it
    // normalizes to the defaults rather than throwing.
    const onlyRetired = normalizeSettings({ theme: "grokn-night", busyEnter: "wait", tui: { prefs: { scrollSpeed: 3 } } })
    expect(survivors(onlyRetired)).toEqual([])
    expect(onlyRetired.sandboxMode).toBe(SETTINGS_DEFAULTS.sandboxMode)
  })

  it("the first write after the upgrade drops them from the file, and the file stays loadable", async () => {
    await withUserDocument(async (file) => {
      const store = new SettingsStore({ path: file })
      await store.load()
      await store.set({ fontSize: 16 })

      const persisted = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
      expect(survivors(persisted)).toEqual([])

      // ...and the write did not take the surviving document with it.
      expect(persisted.sandboxMode).toBe("read-only")
      expect(persisted.model).toBe("deepseek:deepseek-flash")
      expect(persisted.fontSize).toBe(16)
      expect(atPath(persisted, "llm.providers.deepseek.baseURL")).toBe("https://api.deepseek.com")
      expect(atPath(persisted, "tui.prefs.statusLine.mode")).toBe("command")
      expect(atPath(persisted, "tui.prefs.dashboard.order")).toEqual(["s2", "s1"])

      const reloaded = new SettingsStore({ path: file })
      const again = await reloaded.load()
      expect(again.fontSize).toBe(16)
      expect(again.sandboxMode).toBe("read-only")
    })
  })

  it("retired keys inside the legacy tui.providers plane are unaffected (only prefs keys go)", async () => {
    // `tui.providers` is the pre-canonical provider plane and is NOT a T row;
    // its read migration must survive the prefs retirement intact.
    const { normalizeSettings } = await import("../src/index.ts")
    const out = normalizeSettings({
      tui: {
        prefs: { scrollSpeed: 3, screenMode: "minimal" },
        providers: {
          version: 1,
          activeProviderId: "custom",
          providers: { custom: { id: "custom", baseUrl: "https://a.example/v1/", protocol: "openai-compatible" } },
        },
      },
    })
    expect(survivors(out)).toEqual([])
    expect(out.llm.providers.custom).toEqual({
      baseURL: "https://a.example",
      protocol: "openai-completions",
    })
    expect(out.llm.defaultModel.provider).toBe("custom")
  })
})
