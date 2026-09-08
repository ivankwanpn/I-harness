// M28 H-3: MCP OAuth against a REAL (self-hosted) authorization server — porting
// the M26-B1 mock-chain fixture (oauth-integration.test.ts) up to a true-AS unit:
//   RFC 8414 discovery + RFC 7591 dynamic registration + PKCE S256 enforcement +
//   state/code single-flight, all implemented in node:http (zero new deps);
//   real MCP server = official @modelcontextprotocol/sdk McpServer over
//   streamable HTTP (in-process). Previously unverified points (M27-B note):
//   registration_endpoint support, redirect_uri fidelity, PKCE state single-use.
import { describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomUUID, webcrypto } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type ToolExec } from "@i-harness/core-tools"
import {
  createConnectedClient,
  mountMcpClient,
  type McpServerConfig,
  type McpServerStatusEvent,
  type McpTokenStore,
} from "../src/index.ts"

const b64url = (buf: Buffer): string => buf.toString("base64url")
const sha256b64url = async (s: string): Promise<string> =>
  b64url(Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(s))))

const json = (
  res: ServerResponse,
  code: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  res.writeHead(code, { "content-type": "application/json", ...headers })
  res.end(JSON.stringify(body))
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  let raw = ""
  for await (const chunk of req) raw += String(chunk)
  return raw
}

const freePort = async (): Promise<number> => {
  const tmp = createServer()
  await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", r))
  const port = (tmp.address() as import("node:net").AddressInfo).port
  await new Promise<void>((r) => tmp.close(() => r()))
  return port
}

const waitFor = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("waitFor timed out")
}

/** M55: poll the callback URL until the server has ARMED its waitForCallback
 * (the arm happens right after the authorize URL is printed — a fixed sleep
 * was both slow and racy). An unarmed handler answers 400 and consumes
 * nothing; the armed one accepts the code and answers 200. */
const fetchCallbackAccepted = async (url: string, ms = 5000): Promise<Response> => {
  const deadline = Date.now() + ms
  for (;;) {
    const res = await fetch(url)
    if (res.status === 200) return res
    await res.text().catch(() => {}) // drain: free the keep-alive socket
    if (Date.now() > deadline) {
      throw new Error(`callback server never accepted the code (last status ${res.status})`)
    }
    await new Promise((r) => setTimeout(r, 20))
  }
}

// ---------------------------------------------------------------------------
// Real authorization server — node:http, zero deps. Enforces at every step
// (400 + OAuth error JSON on violation; nothing is accepted "as given").
// ---------------------------------------------------------------------------

interface DcrRecord {
  client_id: string
  redirect_uris: string[]
  client_name?: string
  grant_types?: string[]
  response_types?: string[]
  token_endpoint_auth_method?: string
}

interface RealAs {
  base: string
  registerCalls: number
  registrations: DcrRecord[]
  authorizeStates: string[]
  authorizeRedirectUris: string[]
  challengeByState: Map<string, string>
  usedStates: Set<string> // PKCE state single-flight: consumed at /authorize
  codeRecord: Map<string, { code: string; state: string; challenge: string; redirectUri: string }>
  usedCodes: Set<string> // authorization code single-flight: consumed at /token
  issuedTokens: string[]
  tokenCalls: number
  /** M53 T3: refresh-grant behaviour — "unsupported" (pre-M53 default),
   * "reject" (the AS refuses the refresh token → invalid_grant) or "rotate"
   * (issue a fresh access+refresh pair). M55 adds "server-error": a 500 that
   * the SDK maps to ServerError — swallowed by its auth loop (falls through to
   * an interactive redirect) WITHOUT invalidating the stored credentials.
   * M56 adds "rotate-strict": rotation that single-uses the presented refresh
   * token (a concurrent duplicate grant → invalid_grant) — the probe-E race. */
  refreshMode: "unsupported" | "reject" | "rotate" | "rotate-strict" | "server-error"
  /** M56: refresh tokens already presented in "rotate-strict" mode. */
  usedRefreshTokens: Set<string>
  /** M56: expires_in carried by every issued token (default 3600). Tests that
   * need an immediately-expiring access token set it to 1. */
  tokenExpiresIn: number
  /** grant_type of every /token call, in order (asserted by the M53 tests). */
  tokenGrants: string[]
  close(): Promise<void>
}

async function startRealAs(): Promise<RealAs> {
  const as: RealAs = {
    base: "",
    registerCalls: 0,
    registrations: [],
    authorizeStates: [],
    authorizeRedirectUris: [],
    challengeByState: new Map(),
    usedStates: new Set(),
    codeRecord: new Map(),
    usedCodes: new Set(),
    issuedTokens: [],
    tokenCalls: 0,
    refreshMode: "unsupported",
    usedRefreshTokens: new Set(),
    tokenExpiresIn: 3600,
    tokenGrants: [],
    close: async () => {},
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1:0")
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      // RFC 8414: registration_endpoint present → DCR-capable AS.
      return json(res, 200, {
        issuer: as.base,
        authorization_endpoint: `${as.base}/authorize`,
        token_endpoint: `${as.base}/token`,
        registration_endpoint: `${as.base}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      })
    }
    if (url.pathname === "/register") {
      // RFC 7591 (DCR): the SDK posts OAuthClientMetadata; respond OAuthClientInformationFull.
      as.registerCalls += 1
      const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>
      const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : []
      as.registrations.push({
        client_id: "ih-real-as-1",
        redirect_uris,
        client_name: typeof body.client_name === "string" ? body.client_name : undefined,
        grant_types: Array.isArray(body.grant_types) ? body.grant_types.map(String) : undefined,
        response_types: Array.isArray(body.response_types) ? body.response_types.map(String) : undefined,
        token_endpoint_auth_method: "none",
      })
      return json(
        res,
        201,
        {
          client_id: "ih-real-as-1",
          ...(typeof body.client_name === "string" ? { client_name: body.client_name } : {}),
          redirect_uris,
          ...(Array.isArray(body.grant_types) ? { grant_types: body.grant_types } : {}),
          ...(Array.isArray(body.response_types) ? { response_types: body.response_types } : {}),
          token_endpoint_auth_method: "none",
        },
        { "cache-control": "no-store" },
      )
    }
    if (url.pathname === "/authorize") {
      const state = url.searchParams.get("state") ?? ""
      const redirectUri = url.searchParams.get("redirect_uri") ?? ""
      const codeChallenge = url.searchParams.get("code_challenge") ?? ""
      const method = url.searchParams.get("code_challenge_method") ?? ""
      // PKCE state single-flight: once consumed, replaying the same state is rejected.
      if (as.usedStates.has(state)) {
        return json(res, 400, { error: "invalid_request", error_description: "state already used" })
      }
      if (state === "" || method !== "S256" || codeChallenge === "") {
        return json(res, 400, { error: "invalid_request", error_description: "PKCE S256 + state required" })
      }
      // redirect_uri fidelity: the redirected URI must be one this client registered.
      if (!as.registrations.some((r) => r.redirect_uris.includes(redirectUri))) {
        return json(res, 400, { error: "invalid_request", error_description: "redirect_uri was not registered" })
      }
      as.usedStates.add(state)
      as.authorizeStates.push(state)
      as.authorizeRedirectUris.push(redirectUri)
      as.challengeByState.set(state, codeChallenge)
      const code = `code-${as.authorizeStates.length}`
      as.codeRecord.set(code, { code, state, challenge: codeChallenge, redirectUri })
      res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${state}` })
      res.end()
      return
    }
    if (url.pathname === "/token") {
      as.tokenCalls += 1
      const params = new URLSearchParams(await readBody(req))
      const grantType = params.get("grant_type") ?? ""
      as.tokenGrants.push(grantType)
      // M53 T3: the refresh grant is now exercisable (pre-M53 every non-code
      // grant was refused, so the live refresh path had no test).
      if (grantType === "refresh_token") {
        if (as.refreshMode === "reject") {
          return json(res, 400, { error: "invalid_grant", error_description: "refresh token revoked" })
        }
        if (as.refreshMode === "server-error") {
          return json(res, 500, { error: "server_error", error_description: "injected refresh failure" })
        }
        if (as.refreshMode === "rotate" || as.refreshMode === "rotate-strict") {
          const presented = params.get("refresh_token") ?? ""
          // M56 strict rotation: a refresh token is single-use — a concurrent
          // duplicate grant (the probe-E race) is refused instead of silently
          // minting two live token sets.
          if (as.refreshMode === "rotate-strict" && as.usedRefreshTokens.has(presented)) {
            return json(res, 400, { error: "invalid_grant", error_description: "refresh token already rotated" })
          }
          as.usedRefreshTokens.add(presented)
          const access_token = `tok-real-as-${as.issuedTokens.length + 1}`
          as.issuedTokens.push(access_token)
          return json(res, 200, {
            access_token,
            token_type: "Bearer",
            refresh_token: `rt-${access_token}`,
            expires_in: as.tokenExpiresIn,
          }, { "cache-control": "no-store" })
        }
        return json(res, 400, { error: "unsupported_grant_type" })
      }
      if (grantType !== "authorization_code") {
        return json(res, 400, { error: "unsupported_grant_type" })
      }
      const code = params.get("code") ?? ""
      const record = as.codeRecord.get(code)
      if (record === undefined) {
        return json(res, 400, { error: "invalid_grant", error_description: "unknown code" })
      }
      if (as.usedCodes.has(code)) {
        return json(res, 400, { error: "invalid_grant", error_description: "code already exchanged" })
      }
      // PKCE verification: sha256(code_verifier) must match the S256 challenge from /authorize.
      const derived = await sha256b64url(params.get("code_verifier") ?? "")
      if (derived !== record.challenge) {
        return json(res, 400, { error: "invalid_grant", error_description: "PKCE code_verifier mismatch" })
      }
      if (params.get("redirect_uri") !== record.redirectUri) {
        return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" })
      }
      as.usedCodes.add(code)
      const access_token = `tok-real-as-${as.issuedTokens.length + 1}`
      as.issuedTokens.push(access_token)
      return json(res, 200, {
        access_token,
        token_type: "Bearer",
        refresh_token: `rt-${access_token}`,
        expires_in: as.tokenExpiresIn,
      }, { "cache-control": "no-store" })
    }
    return json(res, 404, { error: "not_found" })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const addr = server.address() as import("node:net").AddressInfo
  as.base = `http://127.0.0.1:${addr.port}`
  as.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections()
      server.close(() => r())
    })
  return as
}

// ---------------------------------------------------------------------------
// REAL MCP server: official SDK McpServer over streamable HTTP (in-process).
// Protected resource: GET /resource-metadata (RFC 9728) + 401 Bearer challenge.
// ---------------------------------------------------------------------------

/** M53 T3 controls: `revoked` = bearer tokens the resource rejects (mid-session
 * revocation), `failStatus` = inject a raw HTTP status (generic non-auth
 * failure). Both default to the pre-M53 behaviour (accept every tok-*, no
 * injected failure). */
interface McpFixtureControls {
  revoked?: Set<string>
  failStatus?: () => number | undefined
}

async function startRealMcpServer(
  asBase: string,
  controls: McpFixtureControls = {},
): Promise<{ url: string; close(): Promise<void>; challenges(): number }> {
  // One McpServer instance PER session: a Protocol can only be connected to one
  // transport at a time, and the M53 recovery test legitimately opens a second
  // session (the reconnect generation) after the first one is torn down.
  const newEchoServer = (): McpServer => {
    const mcp = new McpServer({ name: "real-as-mcp", version: "1.0.0" })
    mcp.registerTool(
      "real_echo",
      { description: "echoes the text back", inputSchema: { text: z.string().describe("text to echo") } },
      async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
    )
    return mcp
  }
  const transports = new Map<string, StreamableHTTPServerTransport>()
  let challenges = 0
  let base = ""
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1:0")
    if (url.pathname === "/resource-metadata") {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [asBase] })
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      res.end("not found")
      return
    }
    const auth = req.headers.authorization
    const bearer = auth !== undefined && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined
    if (bearer === undefined || !bearer.startsWith("tok-") || controls.revoked?.has(bearer) === true) {
      challenges += 1 // M56: 401 challenges — proves a refresh happened BEFORE any reactive auth
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/resource-metadata"` })
      res.end()
      return
    }
    const injected = controls.failStatus?.()
    if (injected !== undefined) {
      res.writeHead(injected, { "content-type": "text/plain; charset=utf-8" })
      res.end("injected failure")
      return
    }
    const sidHeader = req.headers["mcp-session-id"]
    const sid = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader
    if (sid !== undefined && transports.has(sid)) {
      await transports.get(sid)!.handleRequest(req, res)
      return
    }
    // Stateful session: one transport per Mcp-Session-Id (registered at initialize
    // via onsessioninitialized; deleted at session close).
    let transport: StreamableHTTPServerTransport
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSid) => {
        transports.set(newSid, transport)
      },
      onsessionclosed: (newSid) => {
        transports.delete(newSid)
      },
    })
    await newEchoServer().connect(transport)
    await transport.handleRequest(req, res)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const addr = server.address() as import("node:net").AddressInfo
  base = `http://127.0.0.1:${addr.port}`
  return {
    url: `${base}/mcp`,
    challenges: () => challenges,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

describe("MCP OAuth real-AS integration (H-3)", () => {
  it(
    "DCR → authorize (S256) → PKCE exchange → token store → tools/list; state/code single-flight",
    async () => {
      const as = await startRealAs()
      const mcp = await startRealMcpServer(as.base)
      const callbackPort = await freePort()
      const expectedRedirectUrl = `http://127.0.0.1:${callbackPort}/oauth/callback`
      // Seam store recorder: "token into store" is asserted off these entries.
      const entries = new Map<string, unknown>()
      const store: McpTokenStore = {
        get: async (k) => entries.get(k),
        put: async (k, v) => { entries.set(k, v) },
      }
      let authUrl: string | undefined
      try {
        const pending = createConnectedClient({
          transport: "streamable-http",
          serverName: "oauth-real-as",
          url: mcp.url,
          auth: {
            callbackPort,
            redirectUrl: expectedRedirectUrl,
            store,
            authTimeoutMs: 30_000,
            onRedirect: (u) => { authUrl = u },
          },
        })
        // Keep a handle on the (possibly early) rejection so vitest doesn't
        // classify a mid-flow failure as an unhandled rejection; the promise is
        // still awaited below, so failures re-throw there.
        void pending.catch(() => {})
        await waitFor(() => authUrl !== undefined)
        const authorize = new URL(authUrl!)
        // The SDK-built authorize request: PKCE S256 challenge + state + client_id + exact redirect_uri.
        expect(authorize.searchParams.get("response_type")).toBe("code")
        expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
        expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(authorize.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(authorize.searchParams.get("client_id")).toBe("ih-real-as-1") // DCR worked
        expect(authorize.searchParams.get("redirect_uri")).toBe(expectedRedirectUrl) // fidelity #1
        await fetch(authUrl!) // simulate the user clicking "authorize": 302 → our callback server
        const client = await pending // auth loop completed: finishAuth → reconnected with token
        const { tools } = await client.listTools()
        expect(tools.map((t) => t.name)).toContain("real_echo")

        // DCR via registration_endpoint: exactly one registration.
        expect(as.registerCalls).toBe(1)
        expect(as.registrations).toHaveLength(1)
        const reg = as.registrations[0]!
        expect(reg.client_id).toBe("ih-real-as-1")
        expect(reg.redirect_uris).toEqual([expectedRedirectUrl]) // fidelity #2
        expect(reg.client_name).toBe("i-harness")
        expect(reg.grant_types).toEqual(["authorization_code", "refresh_token"])
        expect(reg.token_endpoint_auth_method).toBe("none")

        // redirect_uri fidelity #3: the authorize request carried the exact registered URI;
        // PKCE state single-flight: exactly ONE authorize, AS-issued state == SDK-built state.
        expect(as.authorizeRedirectUris).toEqual([expectedRedirectUrl])
        expect(as.authorizeStates).toEqual([authorize.searchParams.get("state")])
        // token landed in the provider store seam (access_token from the AS).
        const tokens = entries.get("oauth:oauth-real-as:tokens") as { access_token?: string } | undefined
        expect(tokens?.access_token).toBe(as.issuedTokens[0])
        const clientInfo = entries.get("oauth:oauth-real-as:client") as { client_id?: string } | undefined
        expect(clientInfo?.client_id).toBe("ih-real-as-1")
        expect(as.tokenCalls).toBe(1)

        // --- AS contract probes: proves the AS enforces rather than records ---
        // 1. PKCE state single-flight: replaying the SAME authorize URL is rejected.
        const replay = await fetch(authUrl!)
        expect(replay.status).toBe(400)
        expect(await replay.json()).toMatchObject({ error: "invalid_request" })
        // 2. PKCE is really verified: fresh code + WRONG verifier → invalid_grant,
        //    correct verifier → token; and the code is single-flight (no double exchange).
        const verifier2 = "probe-verifier-456"
        const challenge2 = await sha256b64url(verifier2)
        const probeUrl = new URL(`${as.base}/authorize`)
        probeUrl.searchParams.set("response_type", "code")
        probeUrl.searchParams.set("client_id", "ih-real-as-1")
        probeUrl.searchParams.set("code_challenge", challenge2)
        probeUrl.searchParams.set("code_challenge_method", "S256")
        probeUrl.searchParams.set("redirect_uri", expectedRedirectUrl)
        probeUrl.searchParams.set("state", "probe-state-1")
        const probeRes = await fetch(probeUrl, { redirect: "manual" })
        expect(probeRes.status).toBe(302)
        const probeLocation = new URL(probeRes.headers.get("location")!)
        expect(probeLocation.searchParams.get("state")).toBe("probe-state-1") // state echo fidelity
        const probeCode = probeLocation.searchParams.get("code")!
        const postToken = (code: string, verifier: string): Promise<Response> =>
          fetch(`${as.base}/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              code_verifier: verifier,
              redirect_uri: expectedRedirectUrl,
            }),
          })
        const wrong = await postToken(probeCode, "WRONG-VERIFIER")
        expect(wrong.status).toBe(400)
        expect(await wrong.json()).toMatchObject({ error: "invalid_grant" })
        const right = await postToken(probeCode, verifier2)
        expect(right.status).toBe(200)
        expect(await right.json()).toMatchObject({ token_type: "Bearer" })
        const again = await postToken(probeCode, verifier2)
        expect(again.status).toBe(400)
        expect(await again.json()).toMatchObject({ error: "invalid_grant" })
        await client.close()
      } finally {
        await as.close()
        await mcp.close()
      }
    },
    60_000,
  )
})

// ---------------------------------------------------------------------------
// M53 T3 (research Option 1): refresh-failure recovery. The SDK's reactive
// refresh_token grant is live (probe B/G) but a REJECTED refresh used to leave a
// dead-but-"ready" transport: every call failed `Error: Unauthorized`, the
// supervisor never reacted, and the printed authorize URL could not be
// completed (no waitForCallback was pending). The fix routes auth-class request
// failures into the existing disconnect fan-out + close, so the supervisor
// reconnects through connectWithAuth (fresh URL + callback wait).
// ---------------------------------------------------------------------------

describe("MCP OAuth refresh-failure recovery (M53 T3)", () => {
  it(
    "a mid-session auth failure tears the generation down → one reconnecting event → fresh authorize URL → callback → tools re-synced",
    async () => {
      const as = await startRealAs()
      const revoked = new Set<string>() // nothing revoked at mount time
      const mcp = await startRealMcpServer(as.base, { revoked })
      const callbackPort = await freePort()
      const expectedRedirectUrl = `http://127.0.0.1:${callbackPort}/oauth/callback`
      // the AS enforces redirect_uri registration; pre-seeded client info skips DCR
      as.registrations.push({ client_id: "ih-real-as-1", redirect_uris: [expectedRedirectUrl], token_endpoint_auth_method: "none" })
      const entries = new Map<string, unknown>([
        ["oauth:oauth-recover:client", { client_id: "ih-real-as-1" }],
        ["oauth:oauth-recover:tokens", { access_token: "tok-seeded-1", refresh_token: "rt-seeded-1", token_type: "Bearer", expires_in: 3600 }],
      ])
      const store: McpTokenStore = {
        get: async (k) => entries.get(k),
        put: async (k, v) => { entries.set(k, v) },
      }
      const ctx = createContext()
      const tools = createToolRegistry(ctx)
      const events: McpServerStatusEvent[] = []
      const redirects: string[] = []
      const config: McpServerConfig = {
        transport: "streamable-http",
        serverName: "oauth-recover",
        url: mcp.url,
        auth: {
          callbackPort,
          redirectUrl: expectedRedirectUrl,
          store,
          authTimeoutMs: 30_000,
          onRedirect: (u) => redirects.push(u),
        },
        reconnect: { enabled: true, initialDelayMs: 20, maxDelayMs: 200, maxRetries: 4 },
      }
      const handle = await mountMcpClient(ctx, tools, config, { onStatus: (ev) => events.push(ev) })
      const exec: ToolExec = {}
      try {
        expect(tools.get("mcp__oauth-recover__real_echo")).toBeDefined()

        // mid-session: the live access token is revoked AND the refresh grant
        // is rejected → the SDK cannot recover reactively.
        revoked.add("tok-seeded-1")
        as.refreshMode = "reject"
        await expect(
          tools.get("mcp__oauth-recover__real_echo")!.execute({ text: "hi" }, exec),
        ).rejects.toThrow(/Unauthorized/)

        // exactly ONE reconnect cycle (the double-death guard holds: the
        // deliberate close fires onclose, but the client notifies once).
        await waitFor(() => events.some((ev) => ev.state === "reconnecting"))
        expect(events.filter((ev) => ev.state === "reconnecting")).toHaveLength(1)

        // the supervisor re-entered connectWithAuth: a fresh authorize URL was
        // printed (redirect #1 came from the failed call) and the callback
        // server now WAITS for the code (pre-fix the printed URL was dead).
        await waitFor(() => redirects.length >= 2)
        const recovered = await fetchCallbackAccepted(redirects.at(-1)!)
        expect(recovered.status).toBe(200) // AS 302 → callback server accepted the code
        expect(await recovered.text()).toContain("授權完成")

        // the SECOND ready = the recovered generation (the first was the mount)
        await waitFor(() => events.filter((ev) => ev.state === "ready").length >= 2)
        const echo = tools.get("mcp__oauth-recover__real_echo")
        expect(echo).toBeDefined()
        await expect(echo!.execute({ text: "again" }, exec)).resolves.toEqual([{ type: "text", text: "echo: again" }])

        // the rejected refresh grant really ran, then the code exchange recovered
        expect(as.tokenGrants).toContain("refresh_token")
        expect(as.tokenGrants).toContain("authorization_code")
        expect(entries.get("oauth:oauth-recover:tokens")).toMatchObject({ access_token: "tok-real-as-1" })
      } finally {
        await handle.unmount()
        await as.close()
        await mcp.close()
      }
    },
    60_000,
  )

  it(
    "a generic 5xx response does NOT tear the generation down (no disconnect, transport stays usable)",
    async () => {
      const as = await startRealAs()
      const failStatus: { value: number | undefined } = { value: undefined }
      const mcp = await startRealMcpServer(as.base, { failStatus: () => failStatus.value })
      const callbackPort = await freePort()
      const expectedRedirectUrl = `http://127.0.0.1:${callbackPort}/oauth/callback`
      as.registrations.push({ client_id: "ih-real-as-1", redirect_uris: [expectedRedirectUrl], token_endpoint_auth_method: "none" })
      const entries = new Map<string, unknown>([
        ["oauth:oauth-5xx:client", { client_id: "ih-real-as-1" }],
        ["oauth:oauth-5xx:tokens", { access_token: "tok-seeded-5xx", refresh_token: "rt-seeded-5xx", token_type: "Bearer", expires_in: 3600 }],
      ])
      const store: McpTokenStore = {
        get: async (k) => entries.get(k),
        put: async (k, v) => { entries.set(k, v) },
      }
      let disconnects = 0
      let redirects = 0
      const client = await createConnectedClient({
        transport: "streamable-http",
        serverName: "oauth-5xx",
        url: mcp.url,
        auth: {
          callbackPort,
          redirectUrl: expectedRedirectUrl,
          store,
          authTimeoutMs: 5_000,
          onRedirect: () => { redirects += 1 },
        },
      })
      client.onDisconnect?.(() => { disconnects += 1 })
      try {
        failStatus.value = 500
        await expect(client.callTool("real_echo", { text: "boom" })).rejects.toThrow(/Streamable HTTP error/)
        // NOT an auth error → no teardown, no interactive re-auth
        expect(disconnects).toBe(0)
        expect(redirects).toBe(0)
        failStatus.value = undefined
        const ok = await client.callTool("real_echo", { text: "still alive" })
        expect(ok.content).toEqual([{ type: "text", text: "echo: still alive" }])
      } finally {
        await client.close()
        await as.close()
        await mcp.close()
      }
    },
    60_000,
  )
})

// ---------------------------------------------------------------------------
// M55: the M53 T3 teardown must be gated on an OBSERVER. With reconnect off
// (and no onDisconnect registered) nobody can rebuild the generation, so
// closeGeneration() used to close the SDK client permanently — the auth error
// surfaced once and every later call died on a dead client. One-shot mounts
// keep the pre-M53 behavior: surface the error, leave the client alone.
// ---------------------------------------------------------------------------

describe("M55 — auth teardown is gated on a disconnect observer", () => {
  it(
    "no-reconnect mount: an auth failure surfaces the error but does NOT permanently close the client",
    async () => {
      const as = await startRealAs()
      const revoked = new Set<string>()
      const mcp = await startRealMcpServer(as.base, { revoked })
      const callbackPort = await freePort()
      const expectedRedirectUrl = `http://127.0.0.1:${callbackPort}/oauth/callback`
      as.registrations.push({ client_id: "ih-real-as-1", redirect_uris: [expectedRedirectUrl], token_endpoint_auth_method: "none" })
      const entries = new Map<string, unknown>([
        ["oauth:oauth-norc:client", { client_id: "ih-real-as-1" }],
        ["oauth:oauth-norc:tokens", { access_token: "tok-norc-1", refresh_token: "rt-norc-1", token_type: "Bearer", expires_in: 3600 }],
      ])
      const store: McpTokenStore = {
        get: async (k) => entries.get(k),
        put: async (k, v) => { entries.set(k, v) },
      }
      const client = await createConnectedClient({
        transport: "streamable-http",
        serverName: "oauth-norc",
        url: mcp.url,
        auth: {
          callbackPort,
          redirectUrl: expectedRedirectUrl,
          store,
          authTimeoutMs: 5_000,
        },
        // NO reconnect config AND no onDisconnect registration: the one-shot
        // mount shape (nobody can rebuild a dead generation).
      })
      try {
        const before = await client.callTool("real_echo", { text: "before" })
        expect(before.content).toEqual([{ type: "text", text: "echo: before" }])

        // Mid-session: the live token is revoked AND the refresh grant fails
        // with a 500 (ServerError — the SDK swallows it, prints an interactive
        // authorize URL and throws UnauthorizedError without invalidating the
        // stored credentials).
        revoked.add("tok-norc-1")
        as.refreshMode = "server-error"
        await expect(client.callTool("real_echo", { text: "boom" })).rejects.toThrow(/Unauthorized/)

        // M55: the error SURFACED and the client was NOT closed — un-revoking
        // the same token keeps the SAME transport usable. Pre-fix guardAuth
        // closed the SDK client here and this call died on it ("Not connected").
        revoked.clear()
        const after = await client.callTool("real_echo", { text: "after" })
        expect(after.content).toEqual([{ type: "text", text: "echo: after" }])
      } finally {
        await client.close()
        await as.close()
        await mcp.close()
      }
    },
    60_000,
  )
})

// ---------------------------------------------------------------------------
// M56 (research Option 2): expiry-aware, single-flight refresh in the provider.
//   G4: `expires_in` was never turned into an absolute expiry, so the only
//       refresh signal was a server 401.
//   G1: every concurrent 401 ran its own refresh grant; with rotation the loser
//       wiped the winner's token set (research probe E).
// The fix: saveTokens records an absolute expiry OUT-OF-BAND (store key
// `tokens-expiry` — the SDK-facing OAuthTokens shape is untouched) and the
// provider's tokens() choke point (awaited by the SDK before EVERY request)
// coalesces concurrent callers onto one shared refresh promise, using the
// SDK's exported refreshAuthorization + the discovery state persisted through
// the saveDiscoveryState/discoveryState hooks. Every failure fails soft to the
// stored token so the existing 401 / M53-reconnect path still owns recovery.
// ---------------------------------------------------------------------------

describe("M56 — expiry-aware single-flight refresh", () => {
  /** Discovery state as the SDK persists it via saveDiscoveryState: RFC 9728
   * resource metadata + RFC 8414 AS metadata. Seeding it models a provider that
   * already ran one auth flow in a previous session (the G5 persistence the
   * proactive refresh needs). */
  const discoveryStateFor = (asBase: string, mcpUrl: string): unknown => ({
    authorizationServerUrl: asBase,
    authorizationServerMetadata: {
      issuer: asBase,
      authorization_endpoint: `${asBase}/authorize`,
      token_endpoint: `${asBase}/token`,
      registration_endpoint: `${asBase}/register`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
    },
    resourceMetadata: { resource: mcpUrl, authorization_servers: [asBase] },
  })

  interface M56Fixture {
    as: RealAs
    mcp: Awaited<ReturnType<typeof startRealMcpServer>>
    revoked: Set<string>
    entries: Map<string, unknown>
    store: McpTokenStore
    callbackPort: number
    redirectUrl: string
  }

  const startM56Fixture = async (
    name: string,
    seed: {
      tokens: Record<string, unknown>
      /** Seed the out-of-band absolute expiry in the past (already inside the skew). */
      expiresInPast?: boolean
      /** Seed the persisted discovery state (needed for a proactive refresh). */
      discovery?: boolean
      refreshMode?: RealAs["refreshMode"]
      /** expires_in on every issued token — 1 makes the next request expiring. */
      tokenExpiresIn?: number
    },
  ): Promise<M56Fixture> => {
    const as = await startRealAs()
    as.refreshMode = seed.refreshMode ?? "rotate"
    as.tokenExpiresIn = seed.tokenExpiresIn ?? 3600
    const revoked = new Set<string>()
    const mcp = await startRealMcpServer(as.base, { revoked })
    const callbackPort = await freePort()
    const redirectUrl = `http://127.0.0.1:${callbackPort}/oauth/callback`
    as.registrations.push({ client_id: "ih-real-as-1", redirect_uris: [redirectUrl], token_endpoint_auth_method: "none" })
    const entries = new Map<string, unknown>([
      [`oauth:${name}:client`, { client_id: "ih-real-as-1" }],
      [`oauth:${name}:tokens`, seed.tokens],
      ...(seed.expiresInPast === true ? [[`oauth:${name}:tokens-expiry`, Date.now() - 1_000] as const] : []),
      ...(seed.discovery === true ? [[`oauth:${name}:discovery`, discoveryStateFor(as.base, mcp.url)] as const] : []),
    ])
    const store: McpTokenStore = {
      get: async (k) => entries.get(k),
      put: async (k, v) => { entries.set(k, v) },
    }
    return { as, mcp, revoked, entries, store, callbackPort, redirectUrl }
  }

  const connectFixture = (
    name: string,
    f: M56Fixture,
    hooks: { onRedirect?: (u: string) => void; onAuthRefreshFailed?: (m: string) => void } = {},
  ): Promise<Awaited<ReturnType<typeof createConnectedClient>>> =>
    createConnectedClient({
      transport: "streamable-http",
      serverName: name,
      url: f.mcp.url,
      auth: {
        callbackPort: f.callbackPort,
        redirectUrl: f.redirectUrl,
        store: f.store,
        authTimeoutMs: 30_000,
        ...hooks,
      },
    })

  /** Wait until the AS token endpoint has been quiet for 30ms — the SDK sends
   * the initialized notification fire-and-forget, so the mount's last proactive
   * refresh can land just after connect() resolves. */
  const quiesce = async (as: RealAs): Promise<void> => {
    let last = -1
    while (last !== as.tokenCalls) {
      last = as.tokenCalls
      await new Promise((r) => setTimeout(r, 30))
    }
  }

  const storedTokens = (f: M56Fixture, name: string): Record<string, unknown> =>
    f.entries.get(`oauth:${name}:tokens`) as Record<string, unknown>

  it(
    "(a) an expiring token is refreshed proactively — the request never sees a 401",
    async () => {
      const name = "oauth-proactive"
      const f = await startM56Fixture(name, {
        tokens: { access_token: "tok-proactive-1", refresh_token: "rt-proactive-1", token_type: "Bearer", expires_in: 3600 },
        expiresInPast: true,
        discovery: true,
        tokenExpiresIn: 1, // every issued token is immediately inside the skew window
      })
      const client = await connectFixture(name, f)
      try {
        await quiesce(f.as) // mount-side refreshes done; measure only the next request
        f.as.tokenGrants.length = 0
        const before = storedTokens(f, name).access_token
        const res = await client.callTool("real_echo", { text: "hi" })
        expect(res.content).toEqual([{ type: "text", text: "echo: hi" }])
        // exactly ONE refresh grant, issued before the request: no 401 was ever
        // served, so this cannot be the SDK's reactive path.
        expect(f.as.tokenGrants).toEqual(["refresh_token"])
        expect(f.mcp.challenges()).toBe(0)
        const after = storedTokens(f, name)
        expect(after.access_token).not.toBe(before)
        expect(after.access_token).toBe(f.as.issuedTokens.at(-1))
        // the value the SDK reads back is still exactly an OAuthTokens object
        expect(after).not.toHaveProperty("expiresAt")
        // ...while the absolute expiry lives in its own additive store key
        const expiry = f.entries.get(`oauth:${name}:tokens-expiry`)
        expect(typeof expiry).toBe("number")
        expect(expiry as number).toBeGreaterThan(Date.now())
      } finally {
        await client.close()
        await f.as.close()
        await f.mcp.close()
      }
    },
    60_000,
  )

  it(
    "(b) N concurrent requests coalesce onto ONE refresh grant (single-flight)",
    async () => {
      const name = "oauth-singleflight"
      const f = await startM56Fixture(name, {
        tokens: { access_token: "tok-sf-1", refresh_token: "rt-sf-1", token_type: "Bearer", expires_in: 3600 },
        expiresInPast: true,
        discovery: true,
        refreshMode: "rotate-strict", // a duplicate concurrent grant would be rejected
        tokenExpiresIn: 1,
      })
      const client = await connectFixture(name, f)
      try {
        await quiesce(f.as)
        f.as.tokenGrants.length = 0
        // Harden the timing: the refresh during the burst now issues a LONG-lived
        // token, so a caller that arrives after the shared promise settled reads
        // a fresh token and cannot start a second grant. The burst itself still
        // starts from the expiring token issued at mount.
        f.as.tokenExpiresIn = 3600
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, i) => client.callTool("real_echo", { text: `c${i}` })),
        )
        expect(results.map((r) => r.content)).toEqual(
          Array.from({ length: 8 }, (_, i) => [{ type: "text", text: `echo: c${i}` }]),
        )
        // eight concurrent callers, ONE refresh_token grant (probe-E race closed).
        // Under strict rotation a second grant would also have failed a caller.
        expect(f.as.tokenGrants).toEqual(["refresh_token"])
        expect(f.mcp.challenges()).toBe(0)
      } finally {
        await client.close()
        await f.as.close()
        await f.mcp.close()
      }
    },
    60_000,
  )

  it(
    "(c) a rejected refresh fails soft to the stored token — the 401 path still owns recovery",
    async () => {
      const name = "oauth-failsoft"
      const f = await startM56Fixture(name, {
        tokens: { access_token: "tok-fs-1", refresh_token: "rt-fs-1", token_type: "Bearer", expires_in: 3600 },
        expiresInPast: true,
        discovery: true,
        tokenExpiresIn: 1,
      })
      const redirects: string[] = []
      const refreshFailures: string[] = []
      const client = await connectFixture(name, f, {
        onRedirect: (u) => redirects.push(u),
        onAuthRefreshFailed: (m) => refreshFailures.push(m),
      })
      try {
        await quiesce(f.as)
        f.as.tokenGrants.length = 0
        // mid-session: the live token is revoked AND the AS now refuses refreshes
        f.revoked.add(storedTokens(f, name).access_token as string)
        f.as.refreshMode = "reject"
        await expect(client.callTool("real_echo", { text: "boom" })).rejects.toThrow(/Unauthorized/)
        // the proactive attempt failed SOFT (no throw, no wipe) and the stale
        // token still walked the SDK's reactive path — pre-M56 there was exactly
        // one grant here; the proactive one is strictly additive.
        expect(f.as.tokenGrants.filter((g) => g === "refresh_token").length).toBeGreaterThanOrEqual(2)
        expect(redirects.length).toBeGreaterThanOrEqual(1) // interactive fallback reached, as before
        // M56 T1.5: the host notification fires with the AS's message (the
        // assembly binds it to the mcp/server-status sink).
        expect(refreshFailures.length).toBeGreaterThanOrEqual(1)
        expect(refreshFailures[0]).toMatch(/refresh token revoked/)
      } finally {
        await client.close()
        await f.as.close()
        await f.mcp.close()
      }
    },
    60_000,
  )

  it(
    "(d) a token without a refresh_token is never refreshed proactively",
    async () => {
      const name = "oauth-nort"
      const f = await startM56Fixture(name, {
        tokens: { access_token: "tok-nort-1", token_type: "Bearer", expires_in: 1 },
        expiresInPast: true,
        discovery: true,
      })
      const client = await connectFixture(name, f)
      try {
        const res = await client.callTool("real_echo", { text: "hi" })
        expect(res.content).toEqual([{ type: "text", text: "echo: hi" }])
        expect(f.as.tokenCalls).toBe(0) // no grant attempted, mount or call
        expect(storedTokens(f, name)).toMatchObject({ access_token: "tok-nort-1" })
      } finally {
        await client.close()
        await f.as.close()
        await f.mcp.close()
      }
    },
    60_000,
  )

  it(
    "(f) a non-protocol refresh failure drops the cached discovery state (fail-soft, session keeps working)",
    async () => {
      const name = "oauth-stale-discovery"
      const deadPort = await freePort() // closed again immediately → fetch ECONNREFUSED
      const f = await startM56Fixture(name, {
        tokens: { access_token: "tok-sd-1", refresh_token: "rt-sd-1", token_type: "Bearer", expires_in: 3600 },
        expiresInPast: true,
        discovery: true,
      })
      // Point the cached AS metadata at a dead token endpoint: the refresh fails
      // with a network error (NOT an OAuthError) — the "cached discovery may be
      // stale" signal — so the provider must drop it (fail-soft) and keep going.
      const discovery = f.entries.get(`oauth:${name}:discovery`) as { authorizationServerMetadata: Record<string, unknown> }
      discovery.authorizationServerMetadata.token_endpoint = `http://127.0.0.1:${deadPort}/token`
      const failures: string[] = []
      const client = await connectFixture(name, f, { onAuthRefreshFailed: (m) => failures.push(m) })
      try {
        await quiesce(f.as)
        f.as.tokenGrants.length = 0
        const res = await client.callTool("real_echo", { text: "still here" })
        expect(res.content).toEqual([{ type: "text", text: "echo: still here" }])
        expect(failures.length).toBeGreaterThanOrEqual(1)
        // the stale discovery was dropped so the SDK re-discovers on its next auth()
        expect(f.entries.get(`oauth:${name}:discovery`) ?? null).toBeNull()
        expect(storedTokens(f, name)).toMatchObject({ access_token: "tok-sd-1" }) // no wipe
        expect(f.as.tokenGrants).toEqual([]) // the real AS was never reached
        // discovery is gone → the next request stays passive and still works
        await client.callTool("real_echo", { text: "again" })
        expect(f.as.tokenGrants).toEqual([])
      } finally {
        await client.close()
        await f.as.close()
        await f.mcp.close()
      }
    },
    60_000,
  )

  it(
    "(e) a token without expires_in keeps the passive (reactive) behaviour",
    async () => {
      const name = "oauth-noexp"
      const f = await startM56Fixture(name, {
        tokens: { access_token: "tok-noexp-1", refresh_token: "rt-noexp-1", token_type: "Bearer" },
        discovery: true,
      })
      const client = await connectFixture(name, f)
      try {
        const res = await client.callTool("real_echo", { text: "hi" })
        expect(res.content).toEqual([{ type: "text", text: "echo: hi" }])
        expect(f.as.tokenCalls).toBe(0) // no expiry recorded → no proactive refresh
        expect(storedTokens(f, name)).toMatchObject({ access_token: "tok-noexp-1" })
      } finally {
        await client.close()
        await f.as.close()
        await f.mcp.close()
      }
    },
    60_000,
  )
})
