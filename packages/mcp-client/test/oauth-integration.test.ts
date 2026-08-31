// M26-B1 完整 OAuth 2.1 流對官方 SDK(1.30.0) 的端到端驗證。fake server（temp .mjs + node:http 手寫
// JSON-RPC）實作 OAuth 2.1 全端點 + MCP streamable 端點：
//   GET  /.well-known/oauth-authorization-server      （issuer discovery）
//   GET  /resource-metadata                            （Protected Resource Metadata）
//   POST /register                                     （RFC 7591 dynamic registration）
//   GET  /authorize …?code&state → 302 → redirect_uri  （模擬使用者授權）
//   POST /token                                        （authorization_code 交換）
//   POST /mcp                                          （無 token → 401 + resource_metadata；
//                                                       有 token → initialize/tools/list）
import { describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createConnectedClient } from "../src/index.ts"

const FAKE = `import { createServer } from "node:http"
const PORT = process.env.PORT
const BASE = "http://127.0.0.1:" + PORT
const json = (res, code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)) }
const readBody = async (req) => { let raw = ""; for await (const c of req) raw += c; return raw }
let token = ""
let registerCalls = 0
const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE)
  if (url.pathname === "/.well-known/oauth-authorization-server") return json(res, 200, {
    issuer: BASE, authorization_endpoint: BASE + "/authorize", token_endpoint: BASE + "/token",
    registration_endpoint: BASE + "/register",
    response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"],
  })
  if (url.pathname === "/resource-metadata") return json(res, 200, {
    resource: BASE + "/mcp", authorization_servers: [BASE],
  })
  if (url.pathname === "/authorize") {  // 模擬使用者在瀏覽器按授權
    const redirect = url.searchParams.get("redirect_uri")
    res.writeHead(302, { location: redirect + "?code=CODE42&state=" + url.searchParams.get("state") })
    return res.end()
  }
  if (url.pathname === "/register") {
    registerCalls++
    const reg = JSON.parse((await readBody(req)) || "{}")   // RFC 7591 body
    return json(res, 201, {
      client_id: "reg-1", token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: Array.isArray(reg.redirect_uris) ? reg.redirect_uris : [],
    })
  }
  if (url.pathname === "/token") {
    const params = new URLSearchParams(await readBody(req))
    if (params.get("grant_type") === "refresh_token") token = "tok-refresh"
    else if (params.get("code") === "CODE42") token = "tok-code"
    else return json(res, 400, { error: "invalid_grant" })
    return json(res, 200, { access_token: token, token_type: "Bearer", refresh_token: "rt-1", expires_in: 3600 })
  }
  if (url.pathname === "/mcp") {
    if (req.headers.authorization !== "Bearer tok-code" && req.headers.authorization !== "Bearer tok-refresh") {
      return json(res, 401, {}, { "www-authenticate": 'Bearer resource_metadata="' + BASE + '/resource-metadata"' })
    }
    const msg = JSON.parse(await readBody(req))
    const sid = req.headers["mcp-session-id"]
    const rep = (id, result) => json(res, 200, { jsonrpc: "2.0", id, result }, sid ? { "mcp-session-id": sid } : undefined)
    if (sid) {
      if (msg.method === "tools/list") return rep(msg.id, { tools: [{ name: "remote_echo", inputSchema: { type: "object" } }] })
      return rep(msg.id, {})
    }
    // 無 session → initialize：MCP streamable 規範要求 initialize 回應帶 Mcp-Session-Id
    const newSid = "sess-" + Math.random().toString(36).slice(2)
    return json(res, 200, {
      jsonrpc: "2.0", id: msg.id,
      result: { protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-oauth", version: "0.1.0" } },
    }, { "mcp-session-id": newSid })
  }
  return json(res, 404, {})
})
server.listen(PORT, "127.0.0.1")
process.on("message", (m) => { if (m === "report") process.send?.({ registerCalls, token }) })
`

const waitFor = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (cond()) return; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error("waitFor timed out")
}

const freePort = async (): Promise<number> => {
  const tmp = createServer()
  await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", r))
  const port = (tmp.address() as import("node:net").AddressInfo).port
  await new Promise<void>((r) => tmp.close(() => r()))
  return port
}

const childReady = async (port: number): Promise<void> => {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/resource-metadata`)
      if (res.ok) return
    } catch { /* 子進程尚未 bind——重試 */ }
    if (Date.now() > deadline) throw new Error("fake OAuth MCP server did not bind in time")
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe("OAuth integration", () => {
  it(
    "end-to-end: discovery → dynamic registration → redirect → code exchange → authed tools/list",
    async () => {
      // 挑兩個閒置端口：fake MCP 伺服器一枚、回調伺服器一枚（兩進程——同端口不同進程也會
      // EADDRINUSE，且回調必須由測試進程的 createOAuthCallbackServer 接）。
      const serverPort = await freePort()
      const callbackPort = await freePort()
      // 把 fake 檔案寫在 temp（client.test.ts 的 fake-stdio-server 模式——單核子進程）
      const dir = mkdtempSync(join(tmpdir(), "m26-oauth-"))
      const script = join(dir, "fake-oauth-mcp.mjs")
      writeFileSync(script, FAKE)
      const child = (await import("node:child_process")).fork(script, [], {
        env: { ...process.env, PORT: String(serverPort) },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      })
      await childReady(serverPort)
      const report = () => new Promise<any>((resolve) => child.once("message", resolve))
      try {
        let authUrl: string | undefined
        // createConnectedClient 在連線後因 401 → SDK 呼叫 redirectToAuthorization → 我們的
        // onRedirect 捕獲授權 URL；同時 connectWithAuth 在 waitForCallback 等使用者完成。
        // （SDK 1.30：provider.state() 是單次 flow 值——回調必須帶 URL 上那枚 state。）
        const pending = createConnectedClient({
          transport: "streamable-http",
          serverName: "oauth",
          url: `http://127.0.0.1:${serverPort}/mcp`,
          auth: {
            callbackPort: callbackPort,
            redirectUrl: `http://127.0.0.1:${callbackPort}/oauth/callback`,
            authTimeoutMs: 30_000,
            onRedirect: (u) => { authUrl = u },
          },
        })
        await waitFor(() => authUrl !== undefined)
        await fetch(authUrl!) // 走 <authorize> → 302 → 我們自己的 callback server
        const client = await pending                 // auth 循環完成：finishAuth → 重連成功
        const { tools } = await client.listTools()
        expect(tools.map((t) => t.name)).toContain("remote_echo")   // 認證後的 tools/list 直達
        child.send("report")
        const rep = await report()
        expect(rep.registerCalls).toBe(1)            // dynamic registration 恰好一次
        expect(rep.token).toBe("tok-code")           // authorization_code 交換成功
        await client.close()
      } finally {
        child.kill()
      }
    },
    60_000,
  )
})
