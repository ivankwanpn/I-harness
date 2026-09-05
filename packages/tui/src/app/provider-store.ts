// @i-harness/tui — M46a G1: the TUI provider store.
//
// The cc-custom v2 provider registry, stored in the SETTINGS document's
// appended `tui.providers` section ({ version: 1, activeProviderId,
// providers: Record<id, ProviderEntry> }) — refs-not-values: the raw API key
// NEVER touches settings; the entry carries `apiKeyRef` (a packages/credentials
// ref name) and the store writes the value through the credential store only.
// The discovery side is the web-host probe-apply machinery reused IN-PROCESS:
// candidate URLs from packages/provider's exported candidate strategy
// (probeCandidatePaths — {base}/v1/models + {base}/models + compat-stripped
// roots) with a `modelsUrl` override + a 15s timeout + the
// {data:[{id,owned_by,display_name}]} parse, MEMO-IZED per provider in runtime
// memory (no hardcoded catalog files) and the ADOPTED default recorded into
// the settings `llm.defaultModel` (first model when nothing was chosen).
//
// The fetch is dependency-injected (ProviderStoreOptions.fetchFn) so tests and
// the PTY host run discovery against fakes — never CI network.

import { probeCandidatePaths } from "@i-harness/provider"
import type {
  Settings,
  SettingsStoreSurface,
  SettingsTuiProviderEntry,
  SettingsTuiProviderProtocol,
  SettingsTuiProviders,
} from "@i-harness/settings"

/** The TUI provider entry (settings shape — the single source of truth). */
export type ProviderEntry = SettingsTuiProviderEntry
export type ProviderProtocol = SettingsTuiProviderProtocol

/** One catalog row (discovery result). */
export interface FetchedModel {
  id: string
  /** Display name — `display_name`/`name` first, `owned_by` as honest last resort. */
  name?: string
}

/** The credential-store face the provider store needs (structural — a host or
 * test passes the real @i-harness/credentials store; this module never carries
 * key material). `resolve` hands the value to the BUILD path (factory), never
 * a UI-facing reader. */
export interface CredentialFace {
  describe(refs: string[]): Record<string, { configured: boolean; source: "env" | "file"; writable: boolean }>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  resolve(ref: string): string | undefined
}

export interface ProviderStoreOptions {
  /** The settings store (a SettingsStore OR LayeredSettingsStore — the
   * SettingsStoreSurface protocol). Expected loaded. */
  settings: SettingsStoreSurface
  /** Credential refs (never the values — except resolve() to the builder). */
  credentials: CredentialFace
  /** Injection point: fetch for model discovery (defaults to global fetch). */
  fetchFn?: typeof fetch
  /** Discovery timeout per candidate (default 15_000). */
  timeoutMs?: number
}

export const PROVIDER_STORE_VERSION = 1
export const DISCOVERY_TIMEOUT_MS = 15_000

/** Ref-name derivation: env-grammar-safe `${ID}_API_KEY` ("deepseek" →
 * "DEEPSEEK_API_KEY"; "my-deep" → "MY_DEEP_API_KEY"). */
export function providerApiKeyRef(id: string): string {
  const safe = id.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_/, "")
  return `${safe === "" ? "PROVIDER" : safe}_API_KEY`
}

/** The ordered discovery candidates for one entry: the `modelsUrl` override
 * wins; otherwise the exported probe candidate strategy (web-host parity —
 * base dual candidates + compat-stripped roots, deduped). */
export function discoveryCandidates(entry: ProviderEntry): string[] {
  if (entry.modelsUrl !== undefined && entry.modelsUrl !== "") return [entry.modelsUrl]
  return probeCandidatePaths(entry.baseUrl)
}

/** Mask display for a credential: `x…` + the last 4 chars of the resolved
 * value; "not set" when the ref is unconfigured. NEVER shows the full key. */
export function maskKey(value: string | undefined): string {
  if (value === undefined || value === "") return "not set"
  const tail = value.length > 4 ? value.slice(-4) : value
  return `x…${tail}`
}

/** Parse the {data:[{id,owned_by,display_name,name}]} body (opencode/cc-switch
 * array shape — the web-host probe's primary response form). Rows without an
 * id are dropped; a non-array body yields undefined (branded failure). */
export function parseModelsBody(body: unknown): FetchedModel[] | undefined {
  if (Array.isArray(body)) return normalizeModelRows(body)
  if (typeof body !== "object" || body === null) return undefined
  const data = (body as Record<string, unknown>).data
  if (Array.isArray(data)) return normalizeModelRows(data)
  return undefined
}

function normalizeModelRows(rows: unknown[]): FetchedModel[] {
  const out: FetchedModel[] = []
  for (const row of rows) {
    if (typeof row === "string" && row !== "") {
      out.push({ id: row })
      continue
    }
    if (typeof row === "object" && row !== null) {
      const r = row as Record<string, unknown>
      const id = typeof r.id === "string" && r.id !== "" ? r.id : undefined
      if (id === undefined) continue
      const display = typeof r.display_name === "string" && r.display_name !== "" ? r.display_name
        : typeof r.name === "string" && r.name !== "" ? r.name
          : typeof r.owned_by === "string" && r.owned_by !== "" ? r.owned_by
            : undefined
      const outRow: FetchedModel = { id }
      if (display !== undefined) outRow.name = display
      out.push(outRow)
      continue
    }
    // junk row — dropped (lenient parse; the branded lists never mix)
  }
  return out
}

/**
 * The TUI provider store: CRUD over the settings `tui.providers` section +
 * credential refs + injected-fetch discovery. Every mutating op persists
 * through the settings store (atomic, comment-preserving) and never carries
 * key material. Pure TS — no fs, no transport.
 */
export class ProviderStore {
  private readonly opts: ProviderStoreOptions
  private readonly memo = new Map<string, FetchedModel[]>()
  private readonly fetchFn: typeof fetch

  constructor(opts: ProviderStoreOptions) {
    this.opts = opts
    this.fetchFn = opts.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  }

  // ------------------------------------------------------------------ section

  /** The stored `tui.providers` section (normalized by the settings store —
   * an activeProviderId that lost its provider normalizes to ""). */
  section(): SettingsTuiProviders {
    return this.opts.settings.get().tui.providers
  }

  /** The settings store this registry writes through (the settings modal's
   * knob writes share it — one document, one write path). */
  settingsSurface(): SettingsStoreSurface {
    return this.opts.settings
  }

  private async commit(next: SettingsTuiProviders): Promise<void> {
    const current: Settings = this.opts.settings.get()
    await this.opts.settings.set({ tui: { ...current.tui, providers: next } })
  }

  // ------------------------------------------------------------------ CRUD

  list(): ProviderEntry[] {
    return Object.values(this.section().providers).sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id: string): ProviderEntry | undefined {
    const entry = this.section().providers[id]
    return entry === undefined ? undefined : { ...entry }
  }

  has(id: string): boolean {
    return id in this.section().providers
  }

  /** The pinned active provider (undefined = none configured — mock path). */
  activeEntry(): ProviderEntry | undefined {
    const s = this.section()
    if (s.activeProviderId === "") return undefined
    const entry = s.providers[s.activeProviderId]
    return entry === undefined ? undefined : { ...entry }
  }

  activeId(): string {
    return this.section().activeProviderId
  }

  async setActive(id: string): Promise<void> {
    if (!this.has(id)) throw new Error(`provider "${id}" is not configured (use /provider add first)`)
    const s = this.section()
    if (s.activeProviderId === id) return
    await this.commit({ ...s, activeProviderId: id })
  }

  /** Add or replace one entry (addressable by entry.id). Persists the whole
   * section verbatim — the entry is already schema-normalized by the caller. */
  async upsert(entry: ProviderEntry): Promise<void> {
    if (entry.id === "" || entry.baseUrl === "") {
      throw new Error("provider id and base URL are required")
    }
    const s = this.section()
    await this.commit({ ...s, providers: { ...s.providers, [entry.id]: { ...entry } } })
  }

  /** Remove one provider. Removing the active one clears the pin (no provider
   * is active afterward — the honest unset). */
  async remove(id: string): Promise<void> {
    const s = this.section()
    if (!(id in s.providers)) return
    const providers = { ...s.providers }
    delete providers[id]
    await this.commit({
      ...s,
      activeProviderId: s.activeProviderId === id ? "" : s.activeProviderId,
      providers,
    })
  }

  // ------------------------------------------------------------------ keys (refs only)

  /** The credential ref name bound to the provider, if any. */
  apiKeyRefOf(id: string): string | undefined {
    return this.get(id)?.apiKeyRef
  }

  credentialInfo(id: string): { configured: boolean; source: "env" | "file"; writable: boolean } | undefined {
    const ref = this.apiKeyRefOf(id)
    if (ref === undefined) return undefined
    const info = this.opts.credentials.describe([ref])[ref]
    return info === undefined ? undefined : { ...info }
  }

  /** Mask for the UI row (never the raw value). */
  maskFor(id: string): string {
    const ref = this.apiKeyRefOf(id)
    if (ref === undefined) return "not set"
    const info = this.opts.credentials.describe([ref])[ref]
    if (info === undefined || !info.configured) return "not set"
    return maskKey(this.opts.credentials.resolve(ref))
  }

  /** The BUILD path's key read: resolve the provider's ref to its value.
   * Never a UI-facing reader (echo rule — the value goes to a builder). */
  resolveKey(id: string): string | undefined {
    const ref = this.apiKeyRefOf(id)
    return ref === undefined ? undefined : this.opts.credentials.resolve(ref)
  }

  /** Store a raw key through the credential store and bind its ref to the
   * provider entry. The settings document keeps ONLY the ref name. The ref
   * name is derived (providerApiKeyRef) so it is id-stable — an
   * env-shadowed write is rejected by the credential store (fail loud). */
  async setApiKey(id: string, value: string): Promise<void> {
    if (!this.has(id)) throw new Error(`provider "${id}" is not configured`)
    const ref = providerApiKeyRef(id)
    await this.opts.credentials.set(ref, value)
    await this.updateEntry(id, { apiKeyRef: ref })
  }

  /** Drop the key: unset the credential + remove the ref from the entry. */
  async clearApiKey(id: string): Promise<void> {
    const ref = this.apiKeyRefOf(id)
    if (ref !== undefined) await this.opts.credentials.unset(ref).catch(() => {})
    await this.updateEntry(id, { apiKeyRef: undefined })
  }

  private async updateEntry(id: string, patch: Partial<ProviderEntry>): Promise<void> {
    const s = this.section()
    const entry = s.providers[id]
    if (entry === undefined) throw new Error(`provider "${id}" is not configured`)
    // An explicit `apiKeyRef: undefined` removes the ref from the entry (the
    // JSON serialization drops undefined leaves).
    await this.commit({
      ...s,
      providers: { ...s.providers, [id]: { ...entry, ...patch } },
    })
  }

  // ------------------------------------------------------------------ default model (llm section)

  /** The settings default model ({provider, model} — "" = unset). */
  defaultModel(): { provider: string; model: string; reasoningEffort?: string } {
    const dm = this.opts.settings.get().llm.defaultModel
    return { ...dm }
  }

  /** (no override) → {provider:"",model:""}; a model id → pinned to the ACTIVE
   * provider (the picker's selection semantics: the active provider + chosen
   * model = the settings default). */
  async setDefaultModel(modelId: string): Promise<void> {
    if (modelId === "") {
      await settings_setDefault(this.opts.settings, { provider: "", model: "" })
      return
    }
    const active = this.activeEntry()
    if (active === undefined) throw new Error("no active provider (configure + activate a provider first)")
    await settings_setDefault(this.opts.settings, { provider: active.id, model: modelId })
  }

  // ------------------------------------------------------------------ discovery

  /** Runtime memo (memory only — no catalog files; the durable record is the
   * adopted defaults in settings). */
  cachedModels(id: string): FetchedModel[] | undefined {
    const found = this.memo.get(id)
    return found === undefined ? undefined : [...found]
  }

  /**
   * Discover the provider's model catalog: candidate URLs (modelsUrl override
   * or the exported candidate strategy), 15s timeout each, parse
   * {data:[{id,owned_by,display_name}]} (junk rows dropped). Results are
   * MEMO-IZED in runtime memory per provider; `force` re-runs. On a successful
   * discovery with NO default model chosen yet ({ "", "" } or provider-pinned
   * but model unset), the FIRST model is adopted into settings
   * llm.defaultModel (the probe-apply adoption record). A failure throws
   * (branded message) — the caller surfaces it honestly.
   */
  async discoverModels(id: string, opts: { force?: boolean } = {}): Promise<FetchedModel[]> {
    if (!opts.force && this.memo.has(id)) return this.cachedModels(id)!
    const entry = this.get(id)
    if (entry === undefined) throw new Error(`provider "${id}" is not configured`)
    const timeoutMs = this.opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS
    const failures: string[] = []
    for (const url of discoveryCandidates(entry)) {
      let response: Response
      try {
        response = await this.fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
      } catch (error) {
        const timedOut = error instanceof DOMException
          && (error.name === "TimeoutError" || error.name === "AbortError")
        failures.push(`GET ${url} ${timedOut ? `timed out after ${timeoutMs / 1000}s` : "failed (network error)"}`)
        continue
      }
      if (!response.ok) {
        failures.push(`GET ${url} → ${response.status}`)
        continue
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        failures.push(`GET ${url} body is not JSON`)
        continue
      }
      const models = parseModelsBody(body)
      if (models === undefined) {
        failures.push(`GET ${url} returned an unsupported shape (expected {data:[{id,…}]})`)
        continue
      }
      this.memo.set(id, models)
      await this.adoptDefault(id, models)
      return [...models]
    }
    const summary = failures.length === 1
      ? failures[0] as string
      : `${failures.length} candidate attempts failed: ${failures.join("; ")}`
    throw new Error(`model discovery failed for "${id}": ${summary}`)
  }

  /** Adopt the first discovered model into settings llm.defaultModel when the
   * user never chose one (probe-apply adoption; a user pick always wins). */
  private async adoptDefault(id: string, models: FetchedModel[]): Promise<void> {
    if (models.length === 0) return
    const dm = this.defaultModel()
    const unset = dm.provider === "" && dm.model === ""
    const needsModel = dm.provider === id && dm.model === ""
    if (!unset && !needsModel) return
    await settings_setDefault(this.opts.settings, { provider: id, model: models[0]!.id })
  }
}

/** The llm.defaultModel write (provider+model; reasoningEffort preserved). */
async function settings_setDefault(
  settings: SettingsStoreSurface,
  value: { provider: string; model: string },
): Promise<void> {
  const cur = settings.get()
  await settings.set({
    llm: {
      ...cur.llm,
      defaultModel: {
        provider: value.provider,
        model: value.model,
        ...(cur.llm.defaultModel.reasoningEffort !== undefined
          ? { reasoningEffort: cur.llm.defaultModel.reasoningEffort }
          : {}),
      },
    },
  })
}
