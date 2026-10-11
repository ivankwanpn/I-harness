/**
 * Codex-compatible account credentials, model catalog, usage and reset cards.
 * Inference transport stays in the existing Responses adapter; this service
 * supplies the same validated workspace credential to inference and management.
 * Wire contracts: codex-rs 0.160.0 login/device_code_auth.rs and
 * backend-client/{types,client/rate_limit_resets}.rs. This is a compatibility
 * connection using Codex's account protocol for both inference and management.
 */
import { createHash, randomUUID } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose"
import { writeFileAtomic } from "@i-harness/fs"
import { acquireSessionLock } from "@i-harness/fs-lock"
import { createSystemFetch } from "@i-harness/http-transport"
import { protectChatGptDirectory, protectChatGptFile } from "./chatgpt-protection.ts"

export interface CodexModel { id: string; name: string; inputModalities?: ("text" | "image")[]; contextWindow?: number }
export interface OpenAiManagementState {
  status: "disconnected" | "pending" | "connected" | "reauth-required"
  accountId?: string
  email?: string
  plan?: string
  login?: { userCode: string; verificationUrl: string }
  availableCount?: number
  creditBalance?: { balance?: string; unlimited?: boolean; hasCredits?: boolean }
  usageUpdatedAt?: number
  credits?: { id: string; status: string; resetType: string; title?: string; expiresAt?: number }[]
  windows?: { name: string; usedPercent: number; resetsAt?: number; limitSeconds?: number; scopeName?: string }[]
  pendingRedemption?: { requestId: string; creditId: string }
  outcome?: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed" | "unknown"
  message?: string
  models?: CodexModel[]
}
export interface CodexManagement {
  state(): Promise<OpenAiManagementState>
  start(): Promise<void>
  cancel(): Promise<void>
  refresh(): Promise<void>
  token(accountId: string, signal?: AbortSignal): Promise<{ accessToken: string; accountId: string }>
  models(accountId: string): Promise<CodexModel[]>
  signOut(expectedAccountId?: string): Promise<void>
  redeem(input: { accountId: string; creditId: string; confirmed: true }): Promise<void>
  close(): Promise<void>
}
export interface CodexManagementOptions {
  directory: string
  /** Trusted process injection for offline tests, never renderer/settings inputs. */
  trustedTestDependencies?: { fetch?: typeof fetch; now?: () => number; pollIntervalMs?: number; attemptTimeoutMs?: number }
}
type View = Pick<OpenAiManagementState, "plan" | "availableCount" | "creditBalance" | "usageUpdatedAt" | "credits" | "windows" | "outcome" | "message">
interface Profile {
  accountId: string; subject: string; workspaceId: string; email?: string; sessionId: string
  status: "connected" | "reauth-required"; accessToken?: string; refreshToken?: string; idToken?: string; expiresAt?: number
  view: View
  models: CodexModel[]
}
interface PendingRedemption { accountId: string; requestId: string; creditId: string }
interface Document {
  version: 1
  profile?: Profile
  attempt?: { id: string; expiresAt: number }
  redemptions: PendingRedemption[]
}
interface Login {
  id: string; expiresAt: number; controller: AbortController
  userCode?: string; deviceAuthId?: string; timer?: NodeJS.Timeout; task?: Promise<void>
}
const ISSUER = "https://auth.openai.com"
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const DEVICE = `${ISSUER}/api/accounts/deviceauth`
const TOKEN = `${ISSUER}/oauth/token`
const VERIFY = `${ISSUER}/codex/device`
const BACKEND = "https://chatgpt.com/backend-api/wham"
const TEMPORARY = "OpenAI management is temporarily unavailable. Try again."
const TERMINAL_REFRESH_ERRORS = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"])
class ManagementError extends Error {}
class IdentityError extends ManagementError {}
class HttpError extends ManagementError {
  constructor(readonly status: number, readonly oauthCode?: string) { super(TEMPORARY) }
}
const fail = (message: string) => new ManagementError(message)
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0
const headerCredential = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]+$/.test(value)
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("OpenAI management returned an invalid response")
  return value as Record<string, unknown>
}
function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
function creditBalance(value: unknown): OpenAiManagementState["creditBalance"] {
  const fields = optionalObject(value)
  if (!fields) return undefined
  const result: NonNullable<OpenAiManagementState["creditBalance"]> = {}
  // Codex's CreditStatusDetails maps has_credits/unlimited and nullable string
  // balance. Preserve valid decimal precision; numeric responses normalize to
  // strings. Absent/invalid values are unknown, never an invented zero.
  const raw = typeof fields.balance === "string" ? fields.balance.trim() : typeof fields.balance === "number" ? String(fields.balance) : ""
  if (/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) && Number.isFinite(Number(raw)) && Number(raw) >= 0) result.balance = raw
  if (typeof fields.unlimited === "boolean") result.unlimited = fields.unlimited
  if (typeof fields.hasCredits === "boolean") result.hasCredits = fields.hasCredits
  return Object.keys(result).length ? result : undefined
}
function clearTokens(profile: Profile): void {
  delete profile.accessToken; delete profile.refreshToken; delete profile.idToken; delete profile.expiresAt
  profile.status = "reauth-required"; profile.view = {}; profile.models = []
}
function publicView(view: View): View {
  // Explicit allowlist: disk/server records never become arbitrary IPC objects.
  const balance = creditBalance(view.creditBalance)
  return {
    ...(typeof view.plan === "string" ? { plan: view.plan } : {}),
    ...(count(view.availableCount) !== undefined ? { availableCount: view.availableCount } : {}),
    ...(balance ? { creditBalance: balance } : {}),
    ...(count(view.usageUpdatedAt) !== undefined ? { usageUpdatedAt: view.usageUpdatedAt } : {}),
    ...(view.credits ? { credits: view.credits.map(c => ({ id: c.id, status: c.status, resetType: c.resetType, ...(typeof c.title === "string" ? { title: c.title } : {}), ...(typeof c.expiresAt === "number" ? { expiresAt: c.expiresAt } : {}) })) } : {}),
    ...(view.windows ? { windows: view.windows.map(w => ({ name: w.name, usedPercent: w.usedPercent, ...(typeof w.scopeName === "string" && w.scopeName.trim() ? { scopeName: w.scopeName } : {}), ...(typeof w.resetsAt === "number" ? { resetsAt: w.resetsAt } : {}), ...(count(w.limitSeconds) !== undefined && w.limitSeconds! > 0 ? { limitSeconds: w.limitSeconds } : {}) })) } : {}),
    ...(view.outcome ? { outcome: view.outcome } : {}),
    ...(view.message ? { message: view.message } : {}),
  }
}

export function createCodexManagement(options: CodexManagementOptions): CodexManagement {
  const directory = resolve(options.directory), path = join(directory, "management.json")
  const transport = options.trustedTestDependencies?.fetch ? undefined : createSystemFetch()
  const fetcher = options.trustedTestDependencies?.fetch ?? transport!.fetch
  const now = options.trustedTestDependencies?.now ?? Date.now
  let initialized: Promise<void> | undefined, pending: Login | undefined, closed = false, message: string | undefined
  const initialize = () => initialized ??= protectChatGptDirectory(directory)
  async function read(): Promise<Document> {
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw fail("Unsafe management credential file")
      await protectChatGptFile(path)
      const value = object(JSON.parse(await readFile(path, "utf8")))
      if (value.version !== 1 || !Array.isArray(value.redemptions)) throw fail("Invalid management credential store")
      if (value.profile) {
        const p = object(value.profile)
        if (!["connected", "reauth-required"].includes(String(p.status)) || !text(p.accountId) || !text(p.subject) || !text(p.workspaceId) || !text(p.sessionId) || !optionalObject(p.view)) throw fail("Invalid management credential store")
      }
      if (value.attempt) { const a = object(value.attempt); if (!text(a.id) || typeof a.expiresAt !== "number") throw fail("Invalid management credential store") }
      for (const raw of value.redemptions) { const r = object(raw); if (!text(r.accountId) || !text(r.requestId) || !text(r.creditId)) throw fail("Invalid management credential store") }
      return value as unknown as Document
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, redemptions: [] }
      throw fail("OpenAI management credential store could not be read")
    }
  }
  const save = async (doc: Document) => { await writeFileAtomic(path, JSON.stringify(doc), 0o600) }
  async function locked<T>(fn: (doc: Document) => Promise<T>): Promise<T> {
    await initialize()
    const lease = await acquireSessionLock({ lockPath: join(directory, "management.lock"), deadlineMs: 90_000 })
    try { return await fn(await read()) } finally { await lease.release() }
  }
  async function request(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    try {
      // Headers can throw with the rejected value in the error message, so
      // construction belongs inside the same redaction boundary as transport.
      const headers = new Headers(init.headers); headers.set("User-Agent", "I-harness-codex-management")
      return await fetcher(url, { ...init, headers, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) })
    }
    catch { throw fail(TEMPORARY) }
  }
  async function json(response: Response): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> | undefined
    try { body = object(await response.json()) } catch { /* upstream bodies are never exposed */ }
    if (!response.ok) {
      const code = typeof body?.error === "string" ? body.error : optionalObject(body?.error)?.code ?? body?.code
      throw new HttpError(response.status, typeof code === "string" ? code.toLowerCase() : undefined)
    }
    if (!body) throw fail("OpenAI management returned an invalid response")
    return body
  }
  const jsonPost = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  async function metadata(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const data = await json(await request(`${ISSUER}/.well-known/openid-configuration`, {}, signal))
    if (data.issuer !== ISSUER) throw new IdentityError("OpenAI management identity could not be verified")
    return data
  }
  function endpoint(value: unknown): string {
    try { const url = new URL(String(value)); if (url.origin === ISSUER && !url.username && !url.password && !url.hash) return url.href } catch { /* reject */ }
    throw new IdentityError("OpenAI management identity could not be verified")
  }
  async function identity(idToken: string, signal?: AbortSignal): Promise<{ subject: string; workspaceId: string; email?: string }> {
    const meta = await metadata(signal)
    const jwks = await json(await request(endpoint(meta.jwks_uri), {}, signal))
    try {
      const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks as unknown as JSONWebKeySet), { issuer: ISSUER, audience: CLIENT_ID, algorithms: ["RS256", "ES256"], requiredClaims: ["sub", "exp"], currentDate: new Date(now()) })
      const workspaceId = optionalObject(payload["https://api.openai.com/auth"])?.chatgpt_account_id
      if (!text(payload.sub) || !headerCredential(workspaceId) || (payload.azp !== undefined && payload.azp !== CLIENT_ID)) throw new Error()
      return { subject: payload.sub, workspaceId, ...(typeof payload.email === "string" ? { email: payload.email } : {}) }
    } catch { throw new IdentityError("OpenAI management identity could not be verified") }
  }
  function tokenFields(data: Record<string, unknown>): { accessToken: string; expiresAt: number; refreshToken?: string; idToken?: string } {
    if (!headerCredential(data.access_token) || (data.token_type !== undefined && data.token_type !== "Bearer") || (data.expires_in !== undefined && (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0))) throw fail("OpenAI management returned invalid credentials")
    return { accessToken: data.access_token, expiresAt: now() + (typeof data.expires_in === "number" ? data.expires_in : 3600) * 1000, ...(text(data.refresh_token) ? { refreshToken: data.refresh_token } : {}), ...(text(data.id_token) ? { idToken: data.id_token } : {}) }
  }
  async function access(doc: Document, p: Profile, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (p.status !== "connected" || !p.accessToken) throw fail("Sign in to OpenAI management again")
    if (!headerCredential(p.accessToken) || !headerCredential(p.workspaceId)) throw fail("OpenAI management credentials are invalid. Sign in again.")
    if (p.expiresAt && p.expiresAt > now() + 60_000) return
    if (!p.refreshToken) { clearTokens(p); await save(doc); throw fail("Sign in to OpenAI management again") }
    try {
      const response = await json(await request(TOKEN, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: p.refreshToken }) }, signal))
      const next = tokenFields(response)
      // Rotation is durable before secondary JWKS I/O can fail. The new access
      // token is installed only after any returned identity has been validated.
      if (next.refreshToken) { p.refreshToken = next.refreshToken; await save(doc) }
      if (next.idToken) {
        const claims = await identity(next.idToken, signal)
        if (claims.subject !== p.subject || claims.workspaceId !== p.workspaceId) throw new IdentityError("OpenAI management account did not match")
      }
      Object.assign(p, next); await save(doc)
    } catch (e) {
      if (e instanceof HttpError && e.status < 500 && e.oauthCode === "invalid_client") throw fail("OpenAI management client configuration was rejected. Check the registered client configuration.")
      if (e instanceof IdentityError || (e instanceof HttpError && e.status >= 400 && e.status < 500 && (e.status === 401 || TERMINAL_REFRESH_ERRORS.has(e.oauthCode ?? "")))) {
        clearTokens(p); await save(doc); throw fail("Sign in to OpenAI management again")
      }
      throw fail(TEMPORARY)
    }
  }
  function selected(doc: Document): Profile {
    if (!doc.profile) throw fail("Connect an OpenAI management account first")
    return doc.profile
  }
  const authHeaders = (p: Profile) => ({ Authorization: `Bearer ${p.accessToken}`, "ChatGPT-Account-Id": p.workspaceId })
  function matchAccount(data: Record<string, unknown>, p: Profile): void {
    if (data.account_id !== undefined && data.account_id !== p.workspaceId) throw fail("OpenAI management account did not match")
  }
  function windowName(seconds: unknown, fallback: string): string {
    if (typeof seconds !== "number" || seconds <= 0) return fallback
    if (seconds % 86400 === 0) return `${seconds / 86400} days`
    if (seconds % 3600 === 0) return `${seconds / 3600} hours`
    return `${Math.round(seconds / 60)} minutes`
  }
  function windows(data: Record<string, unknown>): NonNullable<View["windows"]> {
    const out: NonNullable<View["windows"]> = []
    const add = (raw: unknown, scopeName?: string) => {
      const limit = optionalObject(raw)
      for (const [key, fallback] of [["primary_window", "Primary window"], ["secondary_window", "Secondary window"]]) {
        const w = optionalObject(limit?.[key!])
        if (!w || typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent) || w.used_percent < 0) continue
        const resetsAt = typeof w.reset_at === "number" && Number.isFinite(w.reset_at) ? w.reset_at * 1000 : typeof w.reset_after_seconds === "number" && Number.isFinite(w.reset_after_seconds) ? now() + w.reset_after_seconds * 1000 : undefined
        const limitSeconds = count(w.limit_window_seconds)
        out.push({ name: (scopeName ? `${scopeName}: ` : "") + windowName(w.limit_window_seconds, fallback!), usedPercent: w.used_percent, ...(scopeName ? { scopeName } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}), ...(limitSeconds !== undefined && limitSeconds > 0 ? { limitSeconds } : {}) })
      }
    }
    add(data.rate_limit)
    if (Array.isArray(data.additional_rate_limits)) for (const raw of data.additional_rate_limits) {
      const extra = optionalObject(raw)
      if (extra) add(extra.rate_limit, typeof extra.limit_name === "string" ? extra.limit_name.trim() : undefined)
    }
    return out
  }
  function creditRows(data: Record<string, unknown>): NonNullable<View["credits"]> {
    if (!Array.isArray(data.credits)) throw fail("OpenAI reset-card details are unavailable")
    return data.credits.map(raw => {
      const c = object(raw)
      if (!text(c.id) || !text(c.status) || !text(c.reset_type)) throw fail("OpenAI reset-card details are unavailable")
      const expiresAt = typeof c.expires_at === "string" ? Date.parse(c.expires_at) : undefined
      return { id: c.id, status: c.status, resetType: c.reset_type, ...(typeof c.title === "string" ? { title: c.title } : {}), ...(expiresAt !== undefined && Number.isFinite(expiresAt) ? { expiresAt } : {}) }
    })
  }
  async function view(doc: Document, p: Profile): Promise<void> {
    await access(doc, p)
    try {
      const usage = await json(await request(`${BACKEND}/usage`, { headers: authHeaders(p) }))
      matchAccount(usage, p)
      const rawCredits = optionalObject(usage.credits)
      const balance = creditBalance({ balance: rawCredits?.balance, hasCredits: rawCredits?.has_credits, unlimited: rawCredits?.unlimited })
      const next: View = { ...(typeof usage.plan_type === "string" ? { plan: usage.plan_type } : {}), windows: windows(usage), usageUpdatedAt: now(), ...(balance ? { creditBalance: balance } : {}), ...(p.view.outcome ? { outcome: p.view.outcome } : {}) }
      const available = count(optionalObject(usage.rate_limit_reset_credits)?.available_count)
      if (available !== undefined) next.availableCount = available
      try {
        const details = await json(await request(`${BACKEND}/rate-limit-reset-credits`, { headers: authHeaders(p) }))
        matchAccount(details, p)
        next.credits = creditRows(details)
        const available = count(details.available_count)
        if (available !== undefined) next.availableCount = available
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) throw e
        if (e instanceof ManagementError && e.message.includes("account did not match")) throw e
        next.message = "Reset-card details are unavailable. The account count may still be shown."
      }
      p.view = next
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) { clearTokens(p); await save(doc); throw fail("Sign in to OpenAI management again") }
      // Unknown data stays unknown; never present old observations as a fresh result.
      p.view = { ...(p.view.outcome ? { outcome: p.view.outcome } : {}), message: e instanceof ManagementError ? e.message : TEMPORARY }
      await save(doc)
      throw e instanceof ManagementError ? e : fail(TEMPORARY)
    }
  }
  async function finishLogin(login: Login): Promise<void> {
    if (login.timer) clearTimeout(login.timer)
    if (pending === login) pending = undefined
    await locked(async doc => { if (doc.attempt?.id === login.id) { delete doc.attempt; await save(doc) } })
  }
  async function poll(login: Login, interval: number): Promise<void> {
    try {
      while (!login.controller.signal.aborted && now() < login.expiresAt) {
        const active = await locked(async doc => doc.attempt?.id === login.id)
        if (!active) return
        const response = await request(`${DEVICE}/token`, jsonPost({ device_auth_id: login.deviceAuthId, user_code: login.userCode }), login.controller.signal)
        if (response.status === 403 || response.status === 404) { await delay(interval, undefined, { signal: login.controller.signal }); continue }
        const code = await json(response)
        if (!text(code.authorization_code) || !text(code.code_verifier)) throw fail("OpenAI device sign-in failed")
        const data = await json(await request(TOKEN, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code: code.authorization_code, code_verifier: code.code_verifier, redirect_uri: `${ISSUER}/deviceauth/callback` }) }, login.controller.signal))
        const tokens = tokenFields(data)
        if (!tokens.idToken || !tokens.refreshToken) throw fail("OpenAI device sign-in returned incomplete credentials")
        const claims = await identity(tokens.idToken, login.controller.signal)
        await locked(async doc => {
          if (login.controller.signal.aborted || closed || doc.attempt?.id !== login.id || now() >= login.expiresAt) throw fail("OpenAI device sign-in was cancelled")
          const accountId = createHash("sha256").update(`${ISSUER}\0${CLIENT_ID}\0${claims.subject}\0${claims.workspaceId}`).digest("hex")
          if (doc.profile && doc.profile.accountId !== accountId) throw fail("OpenAI management account did not match. Sign out before connecting another account.")
          doc.profile = { accountId, ...claims, ...tokens, sessionId: randomUUID(), status: "connected", view: {}, models: [] }
          const transaction = doc.redemptions.find(r => r.accountId === accountId)
          if (transaction) doc.profile.view.outcome = "unknown"
          delete doc.attempt; await save(doc)
        })
        message = undefined
        return
      }
    } catch {
      if (!login.controller.signal.aborted && pending === login) message = "OpenAI management sign-in failed. Please try again."
    } finally { await finishLogin(login).catch(() => { message = "OpenAI management sign-in could not be saved." }) }
  }
  const service: CodexManagement = {
    state: () => locked(async doc => {
      const p = doc.profile
      const active = doc.attempt && doc.attempt.expiresAt > now()
      const transaction = p && doc.redemptions.find(r => r.accountId === p.accountId)
      const login = active && pending && pending.id === doc.attempt?.id && pending.userCode ? { userCode: pending.userCode, verificationUrl: VERIFY } : undefined
      return {
        status: active ? "pending" : p?.status ?? "disconnected",
        ...(p ? { accountId: p.accountId, ...(typeof p.email === "string" ? { email: p.email } : {}), ...publicView(p.view), models: (p.models ?? []).map(m => ({ id: m.id, name: m.name, ...(m.inputModalities ? { inputModalities: m.inputModalities } : {}), ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}) })) } : {}),
        ...(login ? { login } : {}),
        ...(transaction ? { pendingRedemption: { requestId: transaction.requestId, creditId: transaction.creditId } } : {}),
        ...(message ? { message } : {}),
      }
    }),
    async start() {
      if (closed) throw fail("OpenAI management service is closed")
      if (pending) throw fail("OpenAI management sign-in is already pending")
      message = undefined
      const login: Login = { id: randomUUID(), expiresAt: now() + (options.trustedTestDependencies?.attemptTimeoutMs ?? 900_000), controller: new AbortController() }
      pending = login
      try {
        await locked(async doc => {
          if (doc.attempt && doc.attempt.expiresAt > now()) throw fail("OpenAI management sign-in is already pending")
          if (login.controller.signal.aborted) throw fail("OpenAI management sign-in was cancelled")
          doc.attempt = { id: login.id, expiresAt: login.expiresAt }; await save(doc)
        })
        const data = await json(await request(`${DEVICE}/usercode`, jsonPost({ client_id: CLIENT_ID }), login.controller.signal))
        const userCode = data.user_code ?? data.usercode
        if (!text(data.device_auth_id) || !text(userCode)) throw fail("OpenAI device sign-in returned invalid details")
        if (login.controller.signal.aborted || pending !== login || closed) throw fail("OpenAI management sign-in was cancelled")
        login.deviceAuthId = data.device_auth_id; login.userCode = userCode
        if (typeof data.expires_in === "number" && data.expires_in > 0) login.expiresAt = Math.min(login.expiresAt, now() + data.expires_in * 1000)
        const rawInterval = Number(data.interval)
        const interval = options.trustedTestDependencies?.pollIntervalMs ?? (Number.isFinite(rawInterval) && rawInterval > 0 ? Math.max(1000, rawInterval * 1000) : 5000)
        login.timer = setTimeout(() => { if (pending === login) { message = "OpenAI device sign-in expired. Please try again."; login.controller.abort() } }, Math.max(1, login.expiresAt - now()))
        login.timer.unref()
        login.task = poll(login, interval)
      } catch (e) {
        await finishLogin(login)
        throw e instanceof ManagementError ? e : fail("OpenAI management sign-in could not start")
      }
    },
    async cancel() {
      message = undefined
      const login = pending
      if (login) { login.controller.abort(); if (login.timer) clearTimeout(login.timer); pending = undefined }
      await locked(async doc => { if (doc.attempt) { delete doc.attempt; await save(doc) } })
    },
    refresh: () => locked(async doc => {
      const p = selected(doc)
      await view(doc, p); await save(doc); message = undefined
    }),
    token: (accountId, signal) => locked(async doc => {
      const p = selected(doc)
      if (p.accountId !== accountId) throw fail("OpenAI management account did not match")
      await access(doc, p, signal)
      signal?.throwIfAborted()
      return { accessToken: p.accessToken!, accountId: p.workspaceId }
    }),
    models: accountId => locked(async doc => {
      const p = selected(doc)
      if (p.accountId !== accountId) throw fail("OpenAI management account did not match")
      await access(doc, p)
      const data = await json(await request("https://chatgpt.com/backend-api/codex/models?client_version=0.160.0", { headers: authHeaders(p) }))
      matchAccount(data, p)
      if (!Array.isArray(data.models)) throw fail("OpenAI returned an invalid model catalog")
      p.models = data.models.filter(raw => raw && raw.visibility === "list" && text(raw.slug) && text(raw.display_name)).map(row => ({
        id: row.slug, name: row.display_name,
        ...(Array.isArray(row.input_modalities) ? { inputModalities: row.input_modalities.filter((value: unknown): value is "text" | "image" => value === "text" || value === "image") } : {}),
        ...(typeof row.context_window === "number" && Number.isFinite(row.context_window) && row.context_window > 0 ? { contextWindow: row.context_window } : {}),
      }))
      await save(doc)
      return p.models
    }),
    async redeem(input) {
      if (input?.confirmed !== true) throw fail("Explicit confirmation is required to redeem a reset card")
      if (!text(input.accountId) || !text(input.creditId)) throw fail("A management account and reset card are required")
      await locked(async doc => {
        const p = selected(doc)
        if (p.accountId !== input.accountId) throw fail("OpenAI management account did not match")
        const old = doc.redemptions.find(r => r.accountId === p.accountId)
        if (old && old.creditId !== input.creditId) throw fail("Resolve the pending reset-card request before selecting another card")
        await view(doc, p)
        if (!old) {
          const card = p.view.credits?.find(c => c.id === input.creditId)
          if (!card || card.status !== "available" || card.resetType !== "codex_rate_limits" || (card.expiresAt !== undefined && card.expiresAt <= now())) { await save(doc); throw fail("The selected reset card is not available") }
        }
        const transaction = old ?? { accountId: p.accountId, requestId: randomUUID(), creditId: input.creditId }
        if (!old) doc.redemptions.push(transaction)
        p.view.outcome = "unknown"
        await save(doc)
        // No automatic retry. Every POST requires this explicit confirmed action.
        let outcome: Exclude<OpenAiManagementState["outcome"], "unknown" | undefined>
        try {
          const result = await json(await request(`${BACKEND}/rate-limit-reset-credits/consume`, { ...jsonPost({ redeem_request_id: transaction.requestId, credit_id: transaction.creditId }), headers: { ...authHeaders(p), "Content-Type": "application/json" } }))
          const outcomes = ["reset", "nothing_to_reset", "no_credit", "already_redeemed"] as const
          if (!(outcomes as readonly unknown[]).includes(result.code)) throw fail("Unknown reset-card result")
          outcome = result.code as typeof outcomes[number]
        } catch (e) {
          if (e instanceof HttpError && e.status === 401) clearTokens(p)
          p.view.outcome = "unknown"
          p.view.message = "The reset-card result is unknown. Retry this pending request to check the same redemption."
          await save(doc)
          return
        }
        p.view.outcome = outcome
        doc.redemptions = doc.redemptions.filter(r => r.requestId !== transaction.requestId)
        delete p.view.message
        await save(doc)
        try { await view(doc, p) } catch { p.view.message = "Reset-card result was received, but refreshed account details are unavailable." }
        p.view.outcome = outcome
        await save(doc)
      })
    },
    async signOut(expectedAccountId) {
      await locked(async doc => {
        const p = doc.profile
        if (expectedAccountId !== undefined && p?.accountId !== expectedAccountId) throw fail("Codex account changed")
        const login = pending
        if (login) { login.controller.abort(); if (login.timer) clearTimeout(login.timer); pending = undefined }
        let revoked = !p?.refreshToken
        try {
          if (p?.refreshToken) {
            const meta = await metadata()
            const response = await request(endpoint(meta.revocation_endpoint), { method: "POST", body: new URLSearchParams({ token: p.refreshToken, token_type_hint: "refresh_token", client_id: CLIENT_ID }) })
            revoked = response.status === 200
          }
        } catch { /* local sign-out always completes */ }
        finally { delete doc.profile; delete doc.attempt; await save(doc) }
        message = revoked ? undefined : "Signed out locally. Remote revocation was not confirmed."
      })
    },
    async close() {
      closed = true
      try { if (pending) {
        const login = pending; login.controller.abort(); if (login.timer) clearTimeout(login.timer); pending = undefined
        await locked(async doc => { if (doc.attempt?.id === login.id) { delete doc.attempt; await save(doc) } })
        await login.task
      } } finally { await transport?.close() }
    },
  }
  return service
}
