import { expect, it } from "vitest"
import { createOAuthClientProvider, generateCodeVerifier, challengeFor } from "../src/oauth.ts"
import type { McpTokenStore } from "../src/types.ts"

// RFC 7636 Appendix B 測試向量（S256）。
it("PKCE: challenge matches RFC 7636 Appendix B vector", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  expect(await challengeFor(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
})

it("PKCE: generated verifier is 43 chars of base64url (32 random bytes)", () => {
  const v = generateCodeVerifier()
  expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/)
})

it("provider: persists dynamic registration + tokens through the injected store", async () => {
  const store = new Map<string, unknown>()
  const mem: McpTokenStore = { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v) } }
  const provider = createOAuthClientProvider({ serverName: "files", auth: { store: mem } as never, redirectUrl: "http://127.0.0.1:1/callback" })
  // clientMetadata: 固定 client_name + redirect_uris 一致 + code/S256 授權法（SDK 1.30 RFC 7591 蛇形鍵）
  expect(provider.clientMetadata.client_name).toBe("i-harness")
  expect(provider.clientMetadata.redirect_uris.map(String)).toContain("http://127.0.0.1:1/callback")
  expect(provider.clientMetadata.grant_types ?? []).toContain("authorization_code")
  await provider.saveClientInformation!({ client_id: "reg-1", token_endpoint_auth_method: "none" } as never)
  expect(await provider.clientInformation()).toMatchObject({ client_id: "reg-1" })
  await provider.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "r" } as never)
  const tokens = await provider.tokens()
  expect(tokens).toMatchObject({ access_token: "a" })
  await provider.invalidateCredentials?.("tokens")
  expect(await provider.tokens()).toBeUndefined()
})

it("provider: state() is single-flight per flow (SDK calls it during oauthFlow — the URL's state must match what waitForCallback waits on)", async () => {
  const store = new Map<string, unknown>()
  const mem: McpTokenStore = { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v) } }
  const provider = createOAuthClientProvider({ serverName: "files", auth: { store: mem } as never, redirectUrl: "http://127.0.0.1:1/callback" })
  const s1 = await provider.state!()
  expect(s1).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(await provider.state!()).toBe(s1)
  await provider.saveCodeVerifier("verifier-abc")
  await expect(provider.codeVerifier()).resolves.toBe("verifier-abc")
})

it("provider: statically configured clientId short-circuits dynamic registration (hidden via clientInformation)", async () => {
  const store = new Map<string, unknown>()
  const mem: McpTokenStore = { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v) } }
  const provider = createOAuthClientProvider({ serverName: "files", auth: { clientId: "pre-registered", store: mem } as never, redirectUrl: "http://127.0.0.1:1/callback" })
  // 未 saveClientInformation 過 → 靜態 clientId 直接回來（SDK 據此省略 DCR）
  expect(await provider.clientInformation()).toMatchObject({ client_id: "pre-registered" })
})

it("provider: redirectToAuthorization remembers the URL (headless console flow)", async () => {
  const store = new Map<string, unknown>()
  const mem: McpTokenStore = { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v) } }
  const provider = createOAuthClientProvider({ serverName: "files", auth: { store: mem } as never, redirectUrl: "http://127.0.0.1:1/callback" })
  await provider.redirectToAuthorization(new URL("http://auth.example/authorize?x=1"))
  expect(store.get("oauth:files:pending-url")).toBe("http://auth.example/authorize?x=1")
})

// M56 T1.1: `expires_in` becomes an absolute expiry, persisted OUT-OF-BAND so the
// value the SDK reads back through tokens() stays exactly an OAuthTokens object.
it("provider: saveTokens records an absolute expiry under a separate store key", async () => {
  const store = new Map<string, unknown>()
  const mem: McpTokenStore = { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v) } }
  const provider = createOAuthClientProvider({ serverName: "files", auth: { store: mem } as never, redirectUrl: "http://127.0.0.1:1/callback" })
  const before = Date.now()
  await provider.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "r", expires_in: 60 } as never)
  const expiry = store.get("oauth:files:tokens-expiry")
  expect(typeof expiry).toBe("number")
  expect(expiry as number).toBeGreaterThanOrEqual(before + 60_000)
  expect(expiry as number).toBeLessThanOrEqual(Date.now() + 60_000)
  // SDK-facing shape untouched: no expiresAt smuggled into the tokens object.
  expect(await provider.tokens()).toEqual({ access_token: "a", token_type: "Bearer", refresh_token: "r", expires_in: 60 })
  // a token set WITHOUT expires_in clears any previously recorded expiry
  await provider.saveTokens({ access_token: "b", token_type: "Bearer" } as never)
  expect(store.get("oauth:files:tokens-expiry")).toBeNull()
})

// M56 T1.2 (research G5): the SDK's saveDiscoveryState/discoveryState hooks are
// implemented so a refresh can reuse the AS metadata instead of re-running
// RFC 9728 + RFC 8414 discovery (and so a discovery hiccup cannot abort it).
it("provider: discovery state round-trips through the injected store", async () => {
  const store = new Map<string, unknown>()
  const mem: McpTokenStore = { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v) } }
  const provider = createOAuthClientProvider({ serverName: "files", auth: { store: mem } as never, redirectUrl: "http://127.0.0.1:1/callback" })
  const state = {
    authorizationServerUrl: "http://as.example",
    resourceMetadataUrl: "http://mcp.example/.well-known/oauth-protected-resource",
    authorizationServerMetadata: { issuer: "http://as.example", token_endpoint: "http://as.example/token" },
  }
  await provider.saveDiscoveryState!(state as never)
  expect(await provider.discoveryState!()).toEqual(state)
  // invalidateCredentials("all") drops it again (the SDK's documented re-discovery path)
  await provider.invalidateCredentials?.("all")
  expect(await provider.discoveryState!()).toBeUndefined()
})

// M57 T3: the second (TOCTOU re-read) store read is fail-soft — a store hiccup
// there must fall back to the token already in hand, not reject (pre-M56 shape).
it("provider: tokens() keeps the first read when the re-read throws (fail-soft)", async () => {
  const held = { access_token: "a", token_type: "Bearer" } // no refresh_token → no proactive refresh
  let reads = 0
  const flaky: McpTokenStore = {
    get: async (k) => {
      if (k !== "oauth:files:tokens") return undefined
      reads += 1
      if (reads === 1) return held
      throw new Error("store offline")
    },
    put: async () => {},
  }
  const provider = createOAuthClientProvider({ serverName: "files", auth: { store: flaky } as never, redirectUrl: "http://127.0.0.1:1/callback" })
  await expect(provider.tokens!()).resolves.toEqual(held)
  expect(reads).toBe(2)
})
