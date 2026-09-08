# M52 research — MCP OAuth live token refresh (I-harness)

Date: 2026-09-08 · HEAD: `d7c1631` · Scope: read-only investigation of the M49 far-future queue item
「MCP OAuth 實線刷新」 (`packages/mcp-client`). Evidence: source read + 8 local probes against an
in-process fake AS/MCP fixture (no network; scripts in the OS temp dir, not committed).

**Verdict in one line: the refresh grant is already live and automatic — the SDK performs it
reactively on 401, both at connect and mid-session. The real gaps are (a) no single-flight, so
concurrent 401s race and can wipe the fresh token, and (b) no recovery/visibility path when a
refresh fails: the session stays "ready" while every call fails `Error: Unauthorized`, and the
printed authorize URL is a dead end (callback server answers HTTP 400).**

---

## 1. Current behavior

### 1.1 Token shape, persistence, and where expiry lives (it doesn't)

- Store keys: `tokens | client | verifier | state | pending-url`, namespaced
  `oauth:<serverName>:<key>` — `packages/mcp-client/src/oauth.ts:20`, `oauth.ts:60-62`.
- Production persistence: coordinator document API `mcp-oauth:<k>` —
  `packages/session-executor/src/assembly.ts:359-370` (`coordinatorTokenStore`, injected by
  `prepareMcpConfig` when `auth.store` is absent). The coordinator contract "reports, never
  rejects" (`assembly.ts:358`), so a failed write degrades to re-auth, never a crash.
- Tokens are stored verbatim as the SDK's `OAuthTokens`: `access_token`, `token_type`, optional
  `refresh_token`, optional **relative** `expires_in`. `saveTokens` is a plain put and `tokens()`
  a plain get — `oauth.ts:100-101`. There is **no `expiresAt`, no clock, no expiry predicate**
  anywhere in the repo: the only `expiresAt` hit is an unrelated credential kind
  (`packages/credentials/src/index.ts:58`). The SDK likewise keeps `expires_in` only in its schema
  (`@modelcontextprotocol/sdk/dist/esm/shared/auth.js:125`); nothing reads it.
- So expiry is handled **reactively only**: the server's 401 is the expiry signal.

### 1.2 The authProvider contract and the SDK's refresh path

The transport reads the provider on every request — `_commonHeaders()` calls
`provider.tokens()` and sets `Authorization: Bearer <access_token>`
(`.../client/streamableHttp.js:62-70`) — and attaches the provider via
`packages/mcp-client/src/transport.ts:23-26` (the comment at `transport.ts:22` already states
"SDK 負擔 discovery/refresh").

On a 401 the SDK transport (`streamableHttp.js:315-336`) calls `auth(provider)`; `authInternal`
finds `tokens.refresh_token` and issues a **refresh_token grant**:

- `.../client/auth.js:273-286` — `refreshAuthorization(...)` → `grant_type=refresh_token`
  (`auth.js:815-829`, preserving the old refresh token if the AS omits a new one) →
  `provider.saveTokens(newTokens)` → `'AUTHORIZED'`.
- Transport then sets `_hasCompletedAuthFlow = true` and **retries the same message once**
  (`streamableHttp.js:333-335`); the breaker resets on the next successful response
  (`streamableHttp.js:368`), so sequential refresh cycles keep working.
- If the immediate retry 401s again → `StreamableHTTPError(401, 'Server returned 401 after
  successful authentication')` (`streamableHttp.js:317-318`).
- The same `auth()` call also covers the SSE GET (`streamableHttp.js:97-98` → `_authThenStart`
  `:38-56`, which requires `'AUTHORIZED'` else throws `UnauthorizedError`).

**So `refresh_token` is used today, transparently, live, and the result is persisted through the
injected store.** IH adds nothing to the refresh path; the provider is the storage + client
metadata seam only (`oauth.ts:78-117`).

### 1.3 What happens when the refresh cannot happen / fails

`auth()` wraps `authInternal` (`auth.js:146-161`): an `InvalidGrantError` (e.g. the AS rejects the
refresh token) triggers `provider.invalidateCredentials('tokens')` (`auth.js:156-157`) and retries
`authInternal` — which now sees no tokens and starts a **fresh interactive authorization**:
`state()` → `saveCodeVerifier` → `redirectToAuthorization` → `'REDIRECT'` → the transport throws
`UnauthorizedError` (`streamableHttp.js:326-329`). Non-`OAuthError`/network failures fall through
to the same interactive path (`auth.js:288-295`).

IH's side of that interactive path is **connect-only**:

- `connectWithAuth` (`packages/mcp-client/src/client.ts:81-105`) is the only caller of
  `server.waitForCallback` (`client.ts:99-100`) and `transport.finishAuth` (`client.ts:101`),
  bounded by `MAX_AUTH_ATTEMPTS = 3` / `AUTH_RETRY_DELAY_MS = 1_000` (`client.ts:69-70`).
- `redirectToAuthorization` writes `pending-url`, logs `console.info`, and calls the optional
  `auth.onRedirect` (`oauth.ts:102-108`). Neither `pending-url` nor `onRedirect` has any production
  consumer: `grep` over `apps/ packages` shows `pending-url` written only in `oauth.ts:105` and read
  only by `test/oauth.test.ts:57`; `onRedirect` is referenced only by its own type
  (`types.ts:24`) and the provider.
- The callback server accepts a code only while a `waitForCallback` is pending
  (`oauth-callback.ts:34-50`); mid-session there is none, so it answers
  `400 OAuth callback rejected: missing/invalid state parameter` (`oauth-callback.ts:43-44`).

### 1.4 Supervisor: an auth failure is invisible

The supervisor learns of death only from `gen.onDisconnect` (`supervisor.ts:246-251`), fed by the
SDK client's `onclose` (`client.ts:138-141`). A 401 **does not close the transport**, so there is no
`generationDown`/`failCycle`, no `mcp/server-status` event, tools stay registered, and `state()`
stays `"ready"` (`supervisor.ts:216-222`, `:312-314`).

The recovery machinery already exists but is unreachable on an auth failure: if a generation died,
`deps.connect` → `createConnectedClient` (`scheduler.ts:74`) → `connectWithAuth` → full interactive
re-auth with the callback wait. Nothing routes a failed refresh there.

### 1.5 Provider hooks IH does not implement

`saveDiscoveryState` / `discoveryState` (`.../client/auth.d.ts:153,165`) are unimplemented, so every
auth/refresh re-runs full RFC 9728 + RFC 8414 discovery (two extra round trips) and a transient
discovery failure aborts the refresh. `validateResourceURL`, `addClientAuthentication`,
`prepareTokenRequest` are likewise absent.

---

## 2. Probe evidence

Fixture (temp dir, mirrors `packages/mcp-client/test/oauth-real-as.test.ts`): in-process node:http
fake AS (RFC 8414 metadata, `/register`, `/authorize`, `/token` counting grants) + MCP endpoint that
401s with `WWW-Authenticate: Bearer resource_metadata=…` unless the bearer matches a mutable
"accepted" token. Seeded store entries: `oauth:probe:tokens`, `oauth:probe:client`.

### A. Connect with a stale persisted access token + refresh token → refresh happens

```json
{ "tokenCalls": [ { "grant_type": "refresh_token", "refresh_token": "rt-stale" } ],
  "storePuts": [ "oauth:probe:tokens=obj" ], "redirects": 0,
  "tools": [ "probe_echo" ] }
```

One refresh grant, tokens re-persisted, no browser. The "restart with an expired token" case works.

### B. Live session, access token revoked server-side → transparent refresh + retry

```json
{ "tokenCallsAfter": [ { "grant_type": "refresh_token", "refresh_token": "rt-live-1" } ],
  "storePuts": [ "oauth:probe:tokens=obj" ], "redirects": 0,
  "callResult": { "content": [ { "type": "text", "text": "echo-ok" } ] } }
```

The tool call succeeded; the caller never saw the 401.

### G. Three successive revocations in one live session → 3 refreshes, all calls OK

```json
{ "outcomes": [ "call0:ok", "call1:ok", "call2:ok" ], "refreshGrants": 3,
  "finalStored": { "access_token": "at-r-3", "refresh_token": "rt-r-3", "token_type": "Bearer", "expires_in": 3600 } }
```

Rotation is persisted; the `_hasCompletedAuthFlow` breaker does not wedge sequential refresh.

### E. Two concurrent calls, token revoked, strict refresh rotation → race (smoking gun)

```json
{ "refreshGrants": [ { "grant_type": "refresh_token", "refresh_token": "rt-live-E" },
                     { "grant_type": "refresh_token", "refresh_token": "rt-live-E" } ],
  "results": [ "fulfilled", "rejected: Unauthorized" ],
  "storePuts": [ "oauth:probe:tokens=obj", "oauth:probe:tokens=null",
                 "oauth:probe:state=obj", "oauth:probe:verifier=obj", "oauth:probe:pending-url=obj" ],
  "redirects": 1, "storedAccessToken": null }
```

Both requests 401 before either refresh completes → **two grants with the same refresh token**.
With rotation the loser gets `invalid_grant` → `invalidateCredentials('tokens')` → the winner's
fresh token is **wiped**, tokens are null, and an interactive redirect is emitted. One call
succeeds, the session is left dead.

### D/F/H. Refresh rejected (revoked refresh token) mid-session → silent dead session

```json
// D (client-level)
{ "tokenCalls": [ { "grant_type": "refresh_token", "refresh_token": "rt-live-1" } ],
  "storePuts": [ "oauth:probe:tokens=null", "oauth:probe:state=obj", "oauth:probe:verifier=obj", "oauth:probe:pending-url=obj" ],
  "redirects": 2, "callError": "Error: Unauthorized", "secondCallError": "Error: Unauthorized" }

// F (supervisor-level, reconnect enabled)
{ "supervisorState": "ready",
  "statusEvents": [ { "server": "probe", "state": "connecting" }, { "server": "probe", "state": "ready" } ],
  "registeredTools": [ "mcp__probe__probe_echo", "list_mcp_resources__probe",
                       "read_mcp_resource__probe", "list_mcp_resource_templates__probe" ],
  "toolError": "Error: Unauthorized", "redirects": 1 }

// H: the user opens the printed authorize URL
{ "err": "Error: Unauthorized", "redirects": 1,
  "callbackStatus": 400, "callbackBody": "OAuth callback rejected: missing/invalid state parameter" }
```

Every subsequent call re-enters the interactive flow (D shows two redirects for two calls; the
second authorize URL reuses the same `state` — `oauth.ts:85-91`), so the console spams URLs, the
supervisor never reacts, and the URL itself cannot be completed.

### C. Refresh rejected at connect

```json
{ "errorName": "McpOAuthError",
  "errorMessage": "mcp-client OAuth: OAuth authorization not completed within 1500ms",
  "tokenCalls": [ { "grant_type": "refresh_token", "refresh_token": "rt-stale" } ],
  "storePuts": [ "oauth:probe:tokens=null", "oauth:probe:state=obj", "oauth:probe:verifier=obj", "oauth:probe:pending-url=obj" ],
  "redirects": 1 }
```

At connect the behavior is correct-by-design: invalidate → fresh interactive flow → wait → timeout
→ fail-closed `McpOAuthError` (`client.ts:96-97`, `errors.ts:12-17`).

---

## 3. Gap analysis

| # | Gap | Evidence | Severity |
|---|-----|----------|----------|
| G1 | **No single-flight refresh.** Concurrent 401s each run their own refresh grant; with rotation the loser's `invalidateCredentials('tokens')` destroys the winner's token set. | Probe E; `auth.js:156-157`; `oauth.ts:111-116` | **High** — silently kills a working session |
| G2 | **No recovery path for a failed refresh.** The transport stays open, so the supervisor never reconnects through `connectWithAuth`; the session is stuck failing. | Probe D/F; `supervisor.ts:216-222`, `scheduler.ts:74` | **High** |
| G3 | **User-visible state is wrong/absent.** Supervisor reports `ready` with tools registered; the only signal is a `console.info` authorize URL that the callback server rejects (HTTP 400). No `mcp/server-status`, no re-auth prompt. | Probe F/H; `oauth-callback.ts:43-44`; `oauth.ts:105-107` | **High** |
| G4 | **No expiry awareness.** `expires_in` is never turned into `expiresAt`; refresh can only be reactive. Not a correctness bug on its own, but it removes the only choke point where single-flight can be implemented cleanly, and it cannot pre-empt a 401. | `oauth.ts:100-101`; SDK schema only | Medium |
| G5 | **Discovery state not cached.** Every refresh re-runs PRM + AS discovery; a discovery hiccup turns into a failed refresh (then G2/G3). | `auth.d.ts:153,165` unimplemented | Low/Medium |
| G6 | **No refresh_token at all** (AS omits it on code exchange) behaves like a revoked token: mid-session interactive redirect that cannot be completed. | Probe H path; `auth.js:273` guard | Medium |
| G7 | Persistence of a *successful* refresh already works (probe A/B/G write `oauth:<server>:tokens`); the store is only unsafe under G1. | Probe A/B/G; `oauth.ts:101` | — |

Not gaps (verified): the refresh grant itself, the retry-after-refresh, and rotation persistence are
all supplied by the SDK and work live.

---

## 4. Fix options + recommendation

### Option 1 (recommended smallest slice) — route auth failures into the existing reconnect/re-auth loop

When a request fails with an auth error (`UnauthorizedError` from the SDK, or `McpOAuthError`),
tear the generation down so the supervisor reconnects:

- `packages/mcp-client/src/client.ts:138-141` already owns the disconnect fan-out; add an
  `isAuthError(err)` helper (alongside `isUnauthorized`, `client.ts:72-73`) and, in the five
  request methods (`client.ts:166-212`) or in a thin wrapper, on auth error: notify the
  `disconnectCallbacks` and `await client.close()`.
- The supervisor then does `generationDown` → `failCycle` → `deps.connect` (`supervisor.ts:216-222`,
  `:253-262`) → `createConnectedClient` (`scheduler.ts:74`) → `connectWithAuth`
  (`client.ts:81-105`), which prints the URL and **waits for the callback** — the machinery that
  already works at startup.
- Effect: G2 + G3 close (the user gets a real re-auth window and `reconnecting`/`lost` status
  events, `supervisor.ts:198`, `:181`); G1 becomes recoverable instead of silent. ~15-25 lines.

Risks: tearing down on a spurious/transient 401 (gate strictly on the SDK error classes; never on
generic 5xx); double-death notification is already guarded (`supervisor.ts:216-222`, `:283-286`);
with `reconnect.enabled` absent the supervisor will not re-adopt — the mount must either enable
reconnect or the client must surface the error (document this).

Test strategy: extend `packages/mcp-client/test/oauth-real-as.test.ts`'s AS with a
`refreshMode: "reject" | "rotate-strict"` switch (its `/token` currently rejects every non-code
grant with `unsupported_grant_type`, `oauth-real-as.test.ts:168` — the refresh path has never been
exercised by any test; `oauth-integration.test.ts:51` implements it but never triggers a 401), then
assert: mid-session rejection → one `reconnecting` event → authorize URL captured by `onRedirect` →
fetching it completes the callback → tools re-synced. Add a supervisor-level test mirroring
`reconnect.test.ts`.

### Option 2 (the literal M49 item) — expiry-aware, single-flight refresh in the provider

- Compute `expiresAt = Date.now() + expires_in*1000` in `saveTokens` (`oauth.ts:101`); in
  `tokens()` (`oauth.ts:100`), if `expiresAt - now < skew` and a refresh token exists, run a
  **provider-level shared promise** that refreshes via the SDK's exported `refreshAuthorization`
  (`.../client/auth.d.ts:396`) using metadata persisted through the `saveDiscoveryState` hook
  (`auth.d.ts:153,165`) and `clientInformation()` (`oauth.ts:93-98`); `saveTokens` the result and
  return it. Fail soft: on any error return the stale token and let the existing 401 path run.
- Because `_commonHeaders()` awaits `tokens()` before every request (`streamableHttp.js:62-70`),
  N concurrent callers coalesce onto one grant — closing the expiry-driven half of G1 and
  delivering proactive refresh (G4). ~60-100 lines + tests.
- Residual: a server-side revocation of a *still-fresh* token still yields concurrent 401s
  (probe E) — this option does not fix that; pair with Option 1, or serialize requests per server
  at the `ConnectedMcpClient` boundary (`client.ts:166-212`) as a heavier alternative.

Risks: concurrent store writes (mem write-through already serialises per provider, but the
coordinator doc write is fire-and-forget — `assembly.ts:362-365`); clock skew (use a 30-60s skew
margin); ASes that do not return `expires_in` (fall back to reactive); discovery failure (fail
soft); do not add a per-server refresh timer (leaks/unref discipline, races with unmount).

### Do / Don't

- **Do** keep the SDK as the auth orchestrator; implement single-flight at the provider's
  `tokens()` choke point; keep every new failure mode fail-soft to the existing 401 path; make the
  mid-session state visible through `mcp/server-status` (the supervisor event sink already exists,
  `assembly.ts:371-373`).
- **Don't** reimplement discovery/PKCE/refresh; don't call `finishAuth` from the callback handler
  without a `waitForCallback` waiter (state single-flight, `oauth-callback.ts:34-50`,
  `oauth.ts:85-91`); don't wipe tokens on the first `invalid_grant` without single-flight (that is
  exactly the probe-E failure); don't add background refresh timers.

### Recommendation

Ship **Option 1** first: it is the smallest change, it makes the failure mode the probe exposed
(dead session reported as `ready`) impossible, and it reuses the tested startup re-auth loop.
Follow with **Option 2** to close the concurrency race and to refresh at expiry instead of waiting
for a 401. The M49 queue item as stated ("expired access token is refreshed automatically") is
already satisfied by the SDK; the deliverable of an M52 slice should be re-scoped to
"refresh failure recovery + single-flight".
