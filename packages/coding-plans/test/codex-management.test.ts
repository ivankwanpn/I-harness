import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { generateKeyPair, exportJWK, SignJWT } from "jose"
import { createCodexManagement } from "../src/codex-management.ts"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const waitFor = async (condition: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await condition()) return; await new Promise(r => setTimeout(r, 10)) }
  throw new Error("Fixture condition did not complete")
}
async function fixture(options: { additionalRateLimits?: unknown[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ih-management-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const keys = await generateKeyPair("RS256")
  const jwk = { ...await exportJWK(keys.publicKey), kid: "fixture", alg: "RS256" }
  let now = Date.now(), polls = 0, refreshes = 0, authorized = false
  let detailsFail = false, consumeFail = false, refreshFail = "", workspace = "workspace-one"
  let usageWorkspace = "workspace-one", claimOverrides: Record<string, unknown> = {}
  let usagePause: Promise<void> | undefined
  let outcome = "reset"
  let unauthorizedAfterConsume = false
  let jwksFail = false
  let tokenPause: Promise<void> | undefined
  let usageCredits: unknown
  let usageFails = false
  const consumes: { redeem_request_id: string; credit_id: string }[] = []
  const requests: { url: string; body?: unknown; headers: Headers }[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input), headers = new Headers(init?.headers)
    const body = headers.get("content-type") === "application/json" ? JSON.parse(String(init?.body)) : init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : undefined
    requests.push({ url, body, headers })
    if (url.endsWith("openid-configuration")) return Response.json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/revoke" })
    if (url.endsWith("/jwks")) return jwksFail ? new Response(null, { status: 503 }) : Response.json({ keys: [jwk] })
    if (url.endsWith("/revoke")) return new Response(null, { status: 200 })
    if (url.endsWith("/usercode")) return Response.json({ device_auth_id: "secret-device", user_code: "ABCD-EFGH", interval: "5", expires_in: 900 })
    if (url.endsWith("/deviceauth/token")) { polls++; return authorized ? Response.json({ authorization_code: "secret-code", code_verifier: "secret-verifier", code_challenge: "unused" }) : new Response(null, { status: 403 }) }
    if (url.endsWith("/oauth/token")) {
      await tokenPause
      if (body?.grant_type === "refresh_token") { refreshes++; if (refreshFail === "network") throw new Error("secret body"); if (refreshFail) return Response.json({ error: { code: refreshFail, message: "secret" } }, { status: 400 }) }
      const id = await new SignJWT({ sub: "subject-one", iss: "https://auth.openai.com", aud: "app_EMoamEEZ73f0CkXaXp7hrann", exp: Math.floor(now / 1000) + 3600, email: "person@example.com", "https://api.openai.com/auth": { chatgpt_account_id: workspace }, ...claimOverrides }).setProtectedHeader({ alg: "RS256", kid: "fixture" }).sign(keys.privateKey)
      return Response.json({ access_token: `secret-access-${refreshes}`, refresh_token: `secret-refresh-${refreshes}`, id_token: id, expires_in: 3600, token_type: "Bearer" })
    }
    if (url === "https://chatgpt.com/backend-api/codex/models?client_version=0.160.0") return Response.json({ models: [{ slug: "model-hidden", display_name: "Hidden", visibility: "hide" }, { slug: "model-codex", display_name: "Codex Model", visibility: "list", input_modalities: ["text", "image", "audio"], context_window: 128000 }] })
    if (url.endsWith("/usage")) { await usagePause; if (usageFails) return new Response(null, { status: 503 }); if (unauthorizedAfterConsume && consumes.length) return new Response(null, { status: 401 }); return Response.json({ account_id: usageWorkspace, plan_type: "plus", credits: usageCredits, additional_rate_limits: options.additionalRateLimits, rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: 2_000_000_000 }, secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 2_000_100_000 } }, rate_limit_reset_credits: { available_count: 2 } }) }
    if (url.endsWith("/consume")) {
      consumes.push(body)
      // The operation identity must already be durable before the request leaves.
      const disk = JSON.parse(await readFile(join(directory, "management.json"), "utf8"))
      expect(JSON.stringify(disk)).toContain(body.redeem_request_id)
      if (consumeFail) throw new Error("secret consume timeout")
      return Response.json({ code: outcome, windows_reset: 2 })
    }
    if (url.endsWith("/rate-limit-reset-credits")) {
      if (detailsFail) return new Response("secret unavailable", { status: 404 })
      return Response.json({ available_count: 2, credits: [{ id: "card-one", status: "available", reset_type: "codex_rate_limits", title: "Full reset", expires_at: "2035-01-01T00:00:00Z" }, { id: "card-unknown", status: "future_status", reset_type: "future_type" }] })
    }
    throw new Error(`Unexpected fixture endpoint ${url}`)
  }
  const create = () => {
    const service = createCodexManagement({ directory, trustedTestDependencies: { fetch: fetcher, now: () => now, pollIntervalMs: 10, attemptTimeoutMs: 10_000 } })
    cleanup.push(() => service.close()); return service
  }
  const service = create()
  const login = async () => {
    authorized = true; await service.start()
    await waitFor(async () => (await service.state()).status !== "pending")
    expect((await service.state()).status).toBe("connected")
    return (await service.state()).accountId!
  }
  return { directory, service, create, login, requests, consumes, authorize: () => { authorized = true }, polls: () => polls, refreshes: () => refreshes, advance: () => { now += 3_700_000 }, failDetails: () => { detailsFail = true }, failConsume: (value: boolean) => { consumeFail = value }, failRefresh: (value: string) => { refreshFail = value }, workspace: (value: string) => { workspace = value }, usageWorkspace: (value: string) => { usageWorkspace = value }, claims: (value: Record<string, unknown>) => { claimOverrides = value }, pauseUsage: (value: Promise<void>) => { usagePause = value }, outcome: (value: string) => { outcome = value }, unauthorizedAfterConsume: () => { unauthorizedAfterConsume = true }, failJwks: (value: boolean) => { jwksFail = value }, pauseToken: (value: Promise<void>) => { tokenPause = value }, usageCredits: (value: unknown) => { usageCredits = value }, failUsage: () => { usageFails = true }, now: () => now }
}

describe("Codex-compatible management connection", () => {
  it("preserves named additional quota identity independently of its window duration", async () => {
    const f = await fixture({ additionalRateLimits: [{ limit_name: "Special model", rate_limit: { primary_window: { used_percent: 60, limit_window_seconds: 604800 } } }] })
    await f.login(); await f.service.refresh()
    expect((await f.service.state()).windows?.at(-1)).toMatchObject({ scopeName: "Special model", limitSeconds: 604800, usedPercent: 60 })
  })
  it("uses source-defined device flow and exposes no private tokens", async () => {
    const f = await fixture(); await f.service.start()
    expect(await f.service.state()).toMatchObject({ status: "pending", login: { userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/codex/device" } })
    expect(f.requests[0]?.body).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" })
    f.authorize(); await waitFor(async () => (await f.service.state()).status === "connected")
    const state = await f.service.state()
    expect(state.email).toBe("person@example.com")
    expect(state.accountId).not.toBe("workspace-one")
    expect(JSON.stringify(state)).not.toMatch(/secret|subject-one|workspace-one|id_token|refresh_token/)
    expect(f.requests.find(r => r.url.endsWith("/oauth/token"))?.body).toEqual({ grant_type: "authorization_code", client_id: "app_EMoamEEZ73f0CkXaXp7hrann", code: "secret-code", code_verifier: "secret-verifier", redirect_uri: "https://auth.openai.com/deviceauth/callback" })
  })

  it("projects authoritative count, windows in milliseconds, and unknown card statuses without guessing", async () => {
    const f = await fixture(); await f.login(); await f.service.refresh()
    expect(await f.service.state()).toMatchObject({ availableCount: 2, plan: "plus", windows: [{ name: "5 hours", usedPercent: 40, resetsAt: 2_000_000_000_000 }, { name: "7 days", usedPercent: 12, resetsAt: 2_000_100_000_000 }], credits: [{ id: "card-one", status: "available", resetType: "codex_rate_limits", title: "Full reset", expiresAt: 2051222400000 }, { id: "card-unknown", status: "future_status", resetType: "future_type" }] })
    const usage = f.requests.find(r => r.url.endsWith("/usage"))!
    expect(usage.headers.get("Authorization")).toBe("Bearer secret-access-0")
    expect(usage.headers.get("ChatGPT-Account-Id")).toBe("workspace-one")
    f.failDetails(); await f.service.refresh()
    expect((await f.service.state()).availableCount).toBe(2)
    expect((await f.service.state()).credits).toBeUndefined()
  })

  it("projects usage credit balance separately from reset cards and dates only successful usage snapshots", async () => {
    const f = await fixture(); await f.login()
    expect((await f.service.state()).usageUpdatedAt).toBeUndefined()
    f.usageCredits({ balance: "125.50", has_credits: true, unlimited: false, private_note: "secret-credit-metadata" })
    f.failDetails(); await f.service.refresh()
    const state = await f.service.state()
    expect(state.creditBalance).toEqual({ balance: "125.50", hasCredits: true, unlimited: false })
    expect(state.credits).toBeUndefined()
    expect(state.availableCount).toBe(2)
    expect(state.usageUpdatedAt).toBe(f.now())
    expect(state.windows?.map(w => w.limitSeconds)).toEqual([18000, 604800])
    expect(JSON.stringify(state)).not.toMatch(/secret-credit-metadata|has_credits/)
    expect((await f.create().state()).creditBalance).toEqual(state.creditBalance)
    f.advance(); f.failUsage()
    await expect(f.service.refresh()).rejects.toThrow("temporarily")
    expect((await f.service.state()).usageUpdatedAt).toBeUndefined()
    expect((await f.service.state()).creditBalance).toBeUndefined()
    expect(f.consumes).toEqual([])
  })

  it("validates usage credit values without inventing a zero balance or boolean entitlement", async () => {
    const f = await fixture(); await f.login()
    const cases: [unknown, unknown][] = [
      [{ balance: 12.5, has_credits: true, unlimited: false }, { balance: "12.5", hasCredits: true, unlimited: false }],
      [{ balance: 0, has_credits: false, unlimited: true }, { balance: "0", hasCredits: false, unlimited: true }],
      [{ balance: null, unlimited: true }, { unlimited: true }],
      [{ balance: "-1", unlimited: false }, { unlimited: false }],
      [{ balance: "Infinity", has_credits: "true" }, undefined],
      [{ balance: "NaN", unlimited: 1 }, undefined],
      [{ balance: "0x10" }, undefined],
      [{ balance: "" }, undefined],
      [{ balance: true }, undefined],
      [{ balance: -5 }, undefined],
      [[], undefined], [null, undefined], [undefined, undefined],
    ]
    for (const [credits, expected] of cases) {
      f.usageCredits(credits); await f.service.refresh()
      expect((await f.service.state()).creditBalance).toEqual(expected)
    }
    expect(f.consumes).toEqual([])
  })

  it("validates the public usage projection after loading persisted fixture metadata", async () => {
    const f = await fixture(); await f.login(); await f.service.refresh()
    const file = join(f.directory, "management.json")
    const doc = JSON.parse(await readFile(file, "utf8"))
    doc.profile.view.creditBalance = { balance: "secret-invalid-balance", hasCredits: "secret-invalid-flag", unlimited: false, private: "secret-extra" }
    doc.profile.view.usageUpdatedAt = -100
    doc.profile.view.windows[0].limitSeconds = -1
    await writeFile(file, JSON.stringify(doc))
    const state = await f.create().state()
    expect(state.creditBalance).toEqual({ unlimited: false })
    expect(state.usageUpdatedAt).toBeUndefined()
    expect(state.windows?.[0]?.limitSeconds).toBeUndefined()
    expect(JSON.stringify(state)).not.toMatch(/secret-invalid|secret-extra/)
  })

  it("resolves model credentials and catalog from the same validated Codex workspace", async () => {
    const f = await fixture(); const accountId = await f.login()
    expect(await f.service.token(accountId)).toEqual({ accessToken: "secret-access-0", accountId: "workspace-one", authEpoch: expect.any(String) })
    expect(await f.service.models(accountId)).toEqual([{ id: "model-codex", name: "Codex Model", inputModalities: ["text", "image"], contextWindow: 128000 }])
    expect((await f.create().state()).models).toEqual([{ id: "model-codex", name: "Codex Model", inputModalities: ["text", "image"], contextWindow: 128000 }])
    const req = f.requests.find(r => r.url.includes("/codex/models"))!
    expect(req.headers.get("ChatGPT-Account-Id")).toBe("workspace-one")
    await expect(f.service.token("other-account")).rejects.toThrow("account")
    const controller = new AbortController(); controller.abort()
    await expect(f.service.token(accountId, controller.signal)).rejects.toThrow()
  })

  it("invalidates another instance's pending device login when signing out", async () => {
    const f = await fixture(); await f.service.start()
    await f.create().signOut(); f.authorize()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect((await f.service.state()).status).toBe("disconnected")
    expect(await readFile(join(f.directory, "management.json"), "utf8")).not.toMatch(/secret-access|secret-refresh|eyJ/)
  })

  it("rejects a device exchange that completes after logout from another instance", async () => {
    const f = await fixture(); let release!: () => void
    f.pauseToken(new Promise<void>(resolve => { release = resolve }))
    f.authorize(); await f.service.start()
    await waitFor(async () => f.requests.some(r => r.url.endsWith("/oauth/token")))
    await f.create().signOut(); release()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect((await f.service.state()).status).toBe("disconnected")
  })

  it("durably preserves rotation when secondary JWKS fetch fails and validates the same workspace on renewal", async () => {
    const f = await fixture(); const id = await f.login(); f.advance(); f.failJwks(true)
    await expect(f.service.token(id)).rejects.toThrow("temporarily")
    f.failJwks(false)
    expect(await f.service.token(id)).toEqual({ accessToken: "secret-access-2", accountId: "workspace-one", authEpoch: expect.any(String) })
    const grants = f.requests.filter(r => r.url.endsWith("/oauth/token")).map(r => r.body as Record<string, unknown>)
    expect(grants.at(-1)?.refresh_token).toBe("secret-refresh-1")
    f.advance(); f.workspace("different-workspace")
    await expect(f.service.token(id)).rejects.toThrow("Sign in")
    expect((await f.service.state()).status).toBe("reauth-required")
  })

  it("requires explicit confirmation, current account, and a freshly available known card", async () => {
    const f = await fixture(); const accountId = await f.login()
    await expect(f.service.redeem({ accountId, creditId: "card-one", confirmed: false as true })).rejects.toThrow("confirmation")
    await expect(f.service.redeem({ accountId: "different", creditId: "card-one", confirmed: true })).rejects.toThrow("account")
    await expect(f.service.redeem({ accountId, creditId: "card-unknown", confirmed: true })).rejects.toThrow("available")
    expect(f.consumes).toEqual([])
    await f.service.redeem({ accountId, creditId: "card-one", confirmed: true })
    expect(f.consumes).toHaveLength(1)
    expect((await f.service.state()).outcome).toBe("reset")
    expect((await f.service.state()).pendingRedemption).toBeUndefined()
  })

  it("persists unknown redemption and reuses its request ID only on explicit retry after restart", async () => {
    const f = await fixture(); const accountId = await f.login(); f.failConsume(true)
    await f.service.redeem({ accountId, creditId: "card-one", confirmed: true })
    const pending = (await f.service.state()).pendingRedemption!
    expect(pending.creditId).toBe("card-one")
    expect((await f.service.state()).outcome).toBe("unknown")
    const other = f.create(); await other.refresh(); expect(f.consumes).toHaveLength(1)
    f.failConsume(false); f.outcome("already_redeemed")
    await other.redeem({ accountId, creditId: "card-one", confirmed: true })
    expect(f.consumes.map(r => r.redeem_request_id)).toEqual([pending.requestId, pending.requestId])
    expect((await other.state()).outcome).toBe("already_redeemed")
  })

  it("preserves a confirmed redemption outcome when the subsequent usage refresh requires sign-in", async () => {
    const f = await fixture(); const accountId = await f.login(); f.unauthorizedAfterConsume()
    await f.service.redeem({ accountId, creditId: "card-one", confirmed: true })
    expect(await f.service.state()).toMatchObject({ status: "reauth-required", outcome: "reset" })
    expect((await f.service.state()).pendingRedemption).toBeUndefined()
  })

  it.each([{ aud: "wrong-client" }, { iss: "https://wrong.invalid" }, { exp: 1 }, { "https://api.openai.com/auth": {} }])("rejects invalid signed identity claims %j", async claims => {
    const f = await fixture(); f.claims(claims); f.authorize(); await f.service.start()
    await waitFor(async () => (await f.service.state()).status !== "pending")
    expect((await f.service.state()).status).toBe("disconnected")
    expect(JSON.stringify(await f.service.state())).not.toContain("secret")
  })

  it("rejects a usage response for a different workspace before allowing consumption", async () => {
    const f = await fixture(); const accountId = await f.login(); f.usageWorkspace("other-workspace")
    await expect(f.service.redeem({ accountId, creditId: "card-one", confirmed: true })).rejects.toThrow("account")
    expect(f.consumes).toEqual([])
  })

  it("cancels device polling without late registration and preserves tokens on transient refresh failure", async () => {
    const f = await fixture(); await f.service.start(); await f.service.cancel()
    const polls = f.polls(); f.authorize(); await new Promise(r => setTimeout(r, 35))
    expect(f.polls()).toBe(polls); expect((await f.service.state()).status).toBe("disconnected")
    await f.login(); f.advance(); f.failRefresh("network")
    await expect(f.service.refresh()).rejects.toThrow("temporarily")
    expect((await f.service.state()).status).toBe("connected")
    f.failRefresh(""); await Promise.all([f.service.refresh(), f.create().refresh()])
    expect(f.refreshes()).toBe(2)
    f.advance(); f.failRefresh("refresh_token_reused")
    await expect(f.service.refresh()).rejects.toThrow("Sign in")
    expect((await f.service.state()).status).toBe("reauth-required")
  })

  it("does not restore a profile from an in-flight refresh after sign-out", async () => {
    const f = await fixture(); await f.login()
    let release!: () => void; f.pauseUsage(new Promise<void>(resolve => { release = resolve }))
    const refreshing = f.service.refresh().catch(() => undefined)
    await new Promise(r => setTimeout(r, 25))
    const signout = f.service.signOut(); release()
    await Promise.all([refreshing, signout])
    expect((await f.service.state()).status).toBe("disconnected")
    expect(await readFile(join(f.directory, "management.json"), "utf8")).not.toMatch(/secret-access|secret-refresh|eyJ/)
  })

  it.each(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"])("marks terminal refresh code %s as requiring sign-in", async code => {
    const f = await fixture(); const accountId = await f.login(); f.advance(); f.failRefresh(code)
    await expect(f.service.token(accountId)).rejects.toThrow("Sign in")
    expect((await f.service.state()).status).toBe("reauth-required")
    expect(await readFile(join(f.directory, "management.json"), "utf8")).not.toMatch(/secret-access|secret-refresh|eyJ/)
    await expect(f.service.token(accountId)).rejects.toThrow("Sign in")
    expect(f.refreshes()).toBe(1)
  })

  it("preserves the renewable credential when the registered client configuration is rejected", async () => {
    const f = await fixture(); const accountId = await f.login(); f.advance(); f.failRefresh("invalid_client")
    const before = await readFile(join(f.directory, "management.json"), "utf8")
    await expect(f.service.token(accountId)).rejects.toThrow(/client configuration/i)
    expect(await readFile(join(f.directory, "management.json"), "utf8")).toBe(before)
    f.failRefresh("")
    expect(await f.service.token(accountId)).toMatchObject({ accessToken: "secret-access-2" })
  })

  it("rejects a stale sign-out for a previous account without cancelling the current login", async () => {
    const f = await fixture(); const oldAccount = await f.login(); const other = f.create()
    await other.signOut(); f.workspace("workspace-two")
    const newAccount = await f.login()
    expect(newAccount).not.toBe(oldAccount)
    let release!: () => void
    f.pauseToken(new Promise<void>(resolve => { release = resolve }))
    await f.service.start()
    try {
      await expect(other.signOut(oldAccount)).rejects.toThrow(/account.*changed/i)
      expect((await f.service.state()).status).toBe("pending")
      expect((await f.service.state()).accountId).toBe(newAccount)
    } finally { release() }
    await waitFor(async () => (await f.service.state()).status !== "pending")
    expect((await f.service.state()).status).toBe("connected")
    await other.signOut(newAccount)
    expect((await f.service.state()).status).toBe("disconnected")
  })

  it("never returns or prints malformed stored bearer values through model discovery or inference auth", async () => {
    const f = await fixture(); const accountId = await f.login()
    const file = join(f.directory, "management.json")
    const doc = JSON.parse(await readFile(file, "utf8"))
    doc.profile.accessToken = "fixture-private-bearer\ninjected"
    await writeFile(file, JSON.stringify(doc))
    const discoveryError = await f.service.models(accountId).catch(error => error)
    expect(discoveryError).toBeInstanceOf(Error)
    expect(discoveryError.message).not.toContain("fixture-private-bearer")
    await expect(f.service.token(accountId)).rejects.toThrow(/credentials|Sign in/)
  })

  it("keeps an uncertain redemption identity through sign-out and same-account reconnection", async () => {
    const f = await fixture(); const accountId = await f.login(); f.failConsume(true)
    await f.service.redeem({ accountId, creditId: "card-one", confirmed: true })
    const pending = (await f.service.state()).pendingRedemption!
    await f.service.signOut(accountId)
    expect(await f.login()).toBe(accountId)
    expect((await f.service.state()).pendingRedemption).toEqual(pending)
    f.failConsume(false); f.outcome("already_redeemed")
    await f.service.redeem({ accountId, creditId: "card-one", confirmed: true })
    expect(f.consumes.map(row => row.redeem_request_id)).toEqual([pending.requestId, pending.requestId])
  })
})

it("observes a private live epoch at the locked token boundary and retains it across refresh", async () => {
  const f = await fixture(), account = await f.login()
  const first = await f.service.token(account)
  expect((first as any).authEpoch).toEqual(expect.any(String))
  f.advance()
  const refreshed = await f.service.token(account)
  expect((refreshed as any).authEpoch).toBe((first as any).authEpoch)
  await f.service.signOut(account)
  const nextAccount = await f.login(), next = await f.service.token(nextAccount)
  expect((next as any).authEpoch).not.toBe((first as any).authEpoch)
  expect((next as any).authEpoch).not.toMatch(/secret|subject|workspace|person/)
})
