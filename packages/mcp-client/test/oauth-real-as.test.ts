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
import { createConnectedClient, type McpTokenStore } from "../src/index.ts"

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
      if (params.get("grant_type") !== "authorization_code") {
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
        expires_in: 3600,
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

async function startRealMcpServer(asBase: string): Promise<{ url: string; close(): Promise<void> }> {
  const mcp = new McpServer({ name: "real-as-mcp", version: "1.0.0" })
  mcp.registerTool(
    "real_echo",
    { description: "echoes the text back", inputSchema: { text: z.string().describe("text to echo") } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  )
  const transports = new Map<string, StreamableHTTPServerTransport>()
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
    if (auth === undefined || !auth.startsWith("Bearer tok-")) {
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/resource-metadata"` })
      res.end()
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
    await mcp.connect(transport)
    await transport.handleRequest(req, res)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const addr = server.address() as import("node:net").AddressInfo
  base = `http://127.0.0.1:${addr.port}`
  return {
    url: `${base}/mcp`,
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
