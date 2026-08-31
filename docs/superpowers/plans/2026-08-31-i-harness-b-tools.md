# M26-B Tools (Execution & Tools) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** M26 執行與工具面九項落地：MCP OAuth 2.1 + roots + 資源模板工具 + blocked/direct（R-B1），PTY terminal 家族 + 進程控制面（R-B2/R-B8），web 存取（R-B3），LSP 擴充（R-B5），registry 級統一 output spill（R-B7），ask_user_input（R-B14）。

**Architecture:** 函數式包（shell/tool-search 先例——no class）。OAuth 走官方 SDK（≥1.9 的 `OAuthClientProvider` + `StreamableHTTPClientTransport.authProvider` + `finishAuth`），IH 只實作 provider/callback-server/token-store 三件：零依賴（node:crypto PKCE + node:http 回調）。PTY 進新包 `@i-harness/terminal`（node-pty——唯一新外部依賴，koffi 同例）；進程工具在同包薄包。websearch 是 provider 包的可插拔 seam（fail-closed NO_PROVIDER），webfetch 內建負載抽取。LSP 單一 `lsp` 工具作業枚舉擴充。spill 走 core-tools 既有 `ctx.onCascade("tools/execute")` 縫（guard 先例）——core-tools 零改動。ask_user_input 掛 interaction 既有 `questions/provider` seam。

**Tech Stack:** TypeScript strict ESM, pnpm workspace, vitest, Node ≥22.18（webcrypto/fetch/AbortSignal.timeout），`@modelcontextprotocol/sdk` ^1.12（已裝 1.30.0），node-pty ^1.1.0（唯一新外部依賴）, `yaml`/zod 既有。

**Spec:** `docs/roadmap/2026-08-31-roadmap-B-tools.md`（§6 取捨紀錄：M26 立即 = R-B1/R-B2/R-B3/R-B5/R-B7/R-B8/R-B14；R-B4/R-B6/R-B9/R-B12/R-B13 後補、R-B10 遠期、R-B11 不做——本計畫不含此六項任何任務）。執行者兩者都讀。

## Global Constraints

- **ESM + strict TS**（tsconfig.base.json：strict/noUnusedLocals/noUnusedParameters/allowImportingTsExtensions——import 一律帶 `.ts`）
- **pnpm workspace**；每包 package.json：`"name": "@i-harness/<pkg>"`、`"private": true`、`"type": "module"`、`"exports": { ".": "./src/index.ts" }`、`"scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" }`、`"dependencies"` 用 `workspace:*`；pnpm-lock 隨任務提交
- **工具名 snake_case** 且 `[A-Za-z0-9_-]{1,64}`（naming.ts 相容）：`terminal_*`、`process_*`、`webfetch`/`websearch`、`ask_user_input`、MCP 既有 `mcp__<server>__<raw>`
- **Windows 第一**（win32 測試主戰場）：terminal 回讀 CRLF→LF 歸一化；kill 走 `taskkill /T /F` 先例在節點內不需要（pty.kill）；OAuth callback 綁 127.0.0.1
- **fail-closed**：OAuth 未授權 → 掛載錯誤（絕不自動省略後照跑）；websearch/ask_user_input 無 provider → 明確錯誤，不是空結果；blocked 工具根本不安裝；LSP server 不支援該操作 → LSP_UNSUPPORTED_OPERATION（既有）
- **零新外部依賴，唯一例外 node-pty**：`packages/terminal` 加 `"node-pty": "^1.1.0"`（dependencies），`pnpm-workspace.yaml` 的 `allowBuilds` 加 `node-pty: true`（koffi 先例——fs-lock/sandbox-windows-acl 已有 `allowBuilds: koffi: true`，node-pty 是原生綁定（Windows ConPTY 無 stdlib 替代），MIT，dsh 同源同理）；THIRD_PARTY_NOTICES 加 node-pty 歸屬
- **不改既有 shape**：某包「零破壞」——既有測試全綠（`pnpm -r test` + `pnpm -r typecheck`）；`ConnectedMcpClient` 只能加 optional 成員（onDisconnect 先例）
- **M-series 風格**：註釋標 M26 milestone 號、雙語（中文註釋中英混合如既有）、吸收來源 註 `吸收<source>`、spec § 引用
- **範圍一刀切**（spec §6）：R-B4（git undo，後補）/R-B6（skills 增強，隨 R-E4）/R-B9（fs watch，後補）/R-B12（workflow：後補）/R-B13（apply_patch AST：後補）/R-B10（執行策略深化：遠期）/R-B11（PTC：不做）。一行說明即可，無任務。

---

## File Structure

```
packages/mcp-client/
  src/types.ts           修改：auth/blockedTools/directTools/roots 設定 + 驗證
  src/oauth.ts           新增：OAuthClientProvider 實作（PKCE、dynamic registration、tokens）
  src/oauth-callback.ts  新增：node:http 回調伺服器（127.0.0.1 端口 0 可綁）
  src/client.ts          修改：auth 重連迴圈、roots 能力、listResourceTemplates
  src/transport.ts       修改：authProvider 接線
  src/resources.ts       修改：resource templates 工具
  src/bridge.ts          修改：blocked/direct 過濾 + exposure
  src/errors.ts          修改：McpOAuthError
  src/index.ts           修改：exports
  test/oauth.test.ts     新增：PKCE/provider/store 單元
  test/oauth-callback.test.ts  新增：回調伺服器
  test/oauth-integration.test.ts  新增：mock OAuth+MCP HTTP 伺服器端到端
  test/roots.test.ts     新增：roots/list（SDK inMemory 對接）
  test/resources.test.ts 修改：模板工具
  test/sync.test.ts      修改：blocked/direct
packages/terminal/       （新包）node-pty
  package.json / tsconfig.json
  src/service.ts         新增：TerminalService（TerminalRunSpec/TerminalReadResult/TerminalView）
  src/tool.ts            新增：六 terminal 工具 + 三 process 工具
  src/index.ts           新增：exports + registerTerminal
  test/terminal.test.ts  新增：service 與工具（crlf/owner/kill/resize/dispose）
  test/process-tools.test.ts  新增：process_spawn/kill/resize_pty
packages/provider/
  package.json           修改：加 @i-harness/core-plugin
  src/index.ts           修改：WebSearchProvider seam（register/get，fail-closed）
  test/websearch-seam.test.ts  新增
packages/web/            （新包）
  package.json / tsconfig.json
  src/index.ts           新增：createWebTools/registerWeb + exports
  src/extract.ts         新增：extractText/title 抽取 + readBodyLimited
  test/web.test.ts       新增：本地 node:http fixture 伺服器端到端
packages/lsp/
  src/instance.ts        修改：LspOperation/LspQuery 聯合擴充 + isPos export + doQuery 分派
  src/tools.ts           修改：lsp 工具 operation enum + 參數放寬（documentSymbol/workspaceSymbol/callHierarchy/incomingCalls/outgoingCalls）
  src/render.ts          修改：formatSymbols/formatCallHierarchyItem/formatCallHierarchyCalls
  src/translate.ts       修改：normalizeSymbols/normalizeCallHierarchyItems/normalizeCallHierarchyCalls
  src/index.ts           修改：export 新型別 + normalizers + isPos
  test/instance.test.ts  修改：新 op 測試（scripted createFakeLspServer 既有慣例，fake-server.ts 零改動）
  test/tools.test.ts     修改：工具面測試
  test/render.test.ts    修改：渲染測試
packages/output-retention/
  package.json           修改：加 @i-harness/core-plugin
  src/spill-guard.ts     新增：createOutputSpillGuard + gcSpillStore + createUnifiedSpillStore
  src/index.ts           修改：exports
  test/spill-guard.test.ts    新增
packages/interaction/
  src/index.ts           修改：createAskUserInputTool/registerAskUserInput
  test/ask-user-input.test.ts 新增
apps/cli/src/run.ts      修改：各任務接線（token store 反向適配、registerTerminal、registerWeb、outputSpill mount、registerAskUserInput）
pnpm-workspace.yaml      修改：allowBuilds 加 node-pty
THIRD_PARTY_NOTICES      修改：node-pty + dsh terminal 歸屬
```

---

### Task 1: B1-1 OAuth 2.1 核心（PKCE + dynamic registration + 回調伺服器 + token store）

**Files:**
- Create: `packages/mcp-client/src/oauth.ts`、`packages/mcp-client/src/oauth-callback.ts`
- Create: `packages/mcp-client/test/oauth.test.ts`、`packages/mcp-client/test/oauth-callback.test.ts`、`packages/mcp-client/test/oauth-integration.test.ts`
- Modify: `packages/mcp-client/src/{types.ts,client.ts,transport.ts,errors.ts,index.ts}`
- Modify: `apps/cli/src/run.ts`（token store 反向適配 + mcp 掛載傳 auth.store）

**Interfaces:**
- Consumes: SDK 1.30.0 `OAuthClientProvider`（`@modelcontextprotocol/sdk/client/auth.js`）、`UnauthorizedError`、`StreamableHTTPClientTransportOptions.authProvider`；`@i-harness/session-persistence` 的 `SessionCoordinator.putDocument/getDocument(key)` + fs-lock（run.ts 反向適配，mcp-client 不新增依賴）；`McpServerConfig`（types.ts）
- Produces:
  - `McpOAuthConfig { clientId?: string; redirectUrl?: string; callbackPort?: number; scopes?: string[]; store?: McpTokenStore; authTimeoutMs?: number }`（streamable-http 變體專屬）
  - `McpTokenStore { get(key: string): Promise<unknown | undefined>; put(key: string, data: unknown): Promise<void> }`
  - `createOAuthClientProvider(config: { serverName: string; auth: McpOAuthConfig; redirectUrl: string }): OAuthClientProvider`
  - `createOAuthCallbackServer(opts?: { port?: number; host?: string }): OAuthCallbackServer`（`port()`/`redirectUrl()`/`waitForCallback(state, { timeoutMs })`/`stop()`）
  - `McpOAuthError`（errors.ts）
  - `createTransport(config, auth?: { provider: OAuthClientProvider })`（第二參數 optional，既有呼叫零改動）

- [ ] **Step 1: 先伸展介面——types.ts 加 `McpOAuthConfig`/`McpTokenStore` + 驗證 + errors.ts 加 `McpOAuthError`（測試要 import 的契約先行）**

```ts
// packages/mcp-client/src/types.ts（原樣擴充——只貼新增/變更部份）
export interface McpOAuthConfig {
  /** RFC 7591 client_id；缺省 "i-harness"（dynamic registration 會覆蓋）。 */
  clientId?: string
  /** 回調 URL；缺省 http://127.0.0.1:<callbackPort>/oauth/callback（callbackPort 缺省 0=系統分配）。 */
  redirectUrl?: string
  /** 本地回調端口；缺省 0（系統分配，redirectUrl 缺省值在 client.ts 組裝）。 */
  callbackPort?: number
  scopes?: string[]
  /** 持久化 seam（CLI 用 coordinator 文件 + fs-lock 適配；缺省記憶體）。 */
  store?: McpTokenStore
  /** 等待使用者完成授權的總預算；缺省 300_000。 */
  authTimeoutMs?: number
  /** 授權 URL 就緒回調（宿主可自動開瀏覽器；headless 預設只 console.info）。 */
  onRedirect?: (url: string) => void
}
export interface McpTokenStore {
  get(key: string): Promise<unknown | undefined>
  put(key: string, data: unknown): Promise<void>
}
```

```ts
// packages/mcp-client/src/types.ts（streamable-http 變體加 auth?: McpOAuthConfig；validateMcpConfig 加）
if (config.transport === "streamable-http" && config.auth !== undefined) {
  const a = config.auth
  if (a.callbackPort !== undefined && (!Number.isInteger(a.callbackPort) || a.callbackPort < 0 || a.callbackPort > 65535)) {
    throw new Error(`mcp-client: auth.callbackPort must be an integer in [0, 65535] (got ${String(a.callbackPort)})`)
  }
  if (a.authTimeoutMs !== undefined && (!Number.isInteger(a.authTimeoutMs) || a.authTimeoutMs <= 0)) {
    throw new Error(`mcp-client: auth.authTimeoutMs must be a positive integer (got ${String(a.authTimeoutMs)})`)
  }
  if (a.scopes !== undefined && (!Array.isArray(a.scopes) || a.scopes.some((s) => typeof s !== "string"))) {
    throw new Error("mcp-client: auth.scopes must be a string array")
  }
}
```

```ts
// packages/mcp-client/src/errors.ts（末尾加）
export class McpOAuthError extends Error {
  constructor(message: string) {
    super(`mcp-client OAuth: ${message}`)
    this.name = "McpOAuthError"
  }
}
```

（此 step 同時把 `McpOAuthError`（oauth-callback **Step 3** 才用到）先放好——介面先行、行為後驗。）

- [ ] **Step 2: 寫失敗測試——PKCE 與 provider 單元（oauth.test.ts）**

```ts
// packages/mcp-client/test/oauth.test.ts
import { describe, expect, it } from "vitest"
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
  // clientMetadata: 固定 client_id + redirectUrls 一致 + code/S256 授權法
  expect(provider.clientMetadata.clientId).toBe("i-harness")
  expect(provider.clientMetadata.redirectUrls).toContain("http://127.0.0.1:1/callback")
  await provider.saveClientInformation({ client_id: "reg-1", token_endpoint_auth_method: "none" } as never)
  expect(await provider.clientInformation()).toMatchObject({ client_id: "reg-1" })
  await provider.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "r" } as never)
  const tokens = await provider.tokens()
  expect(tokens).toMatchObject({ access_token: "a" })
  await provider.invalidateCredentials?.("tokens")
  expect(await provider.tokens()).toBeUndefined()
})

it("provider: state() returns distinct 32-byte base64url values; codeVerifier round-trips", async () => {
  const store = new Map<string, unknown>()
  const mem: McpTokenStore = { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v) } }
  const provider = createOAuthClientProvider({ serverName: "files", auth: { store: mem } as never, redirectUrl: "http://127.0.0.1:1/callback" })
  const s1 = await provider.state!()
  const s2 = await provider.state!()
  expect(s1).not.toBe(s2)
  expect(s1).toMatch(/^[A-Za-z0-9_-]{43}$/)
  await provider.saveCodeVerifier("verifier-abc")
  expect(provider.codeVerifier()).resolves.toBe("verifier-abc")
})

it("provider: redirectToAuthorization remembers the URL (headless console flow)", async () => {
  const store = new Map<string, unknown>()
  const mem: McpTokenStore = { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v) } }
  const provider = createOAuthClientProvider({ serverName: "files", auth: { store: mem } as never, redirectUrl: "http://127.0.0.1:1/callback" })
  await provider.redirectToAuthorization(new URL("http://auth.example/authorize?x=1"))
  expect(store.get("pending-url")).toBe("http://auth.example/authorize?x=1")
})
```

（測試檔用 `as never` 補齊 auth 其他欄位，因為 `McpOAuthConfig` 是 streamable-http 變體的附加欄位。）

- [ ] **Step 3: 跑確認失敗**

Run: `pnpm --filter @i-harness/mcp-client test test/oauth.test.ts`
Expected: FAIL——`../src/oauth.ts` 不存在（types.ts 的欄位已就位，失敗點唯一）。

- [ ] **Step 4: 實作 oauth.ts（PKCE + OAuthClientProvider）**

```ts
// packages/mcp-client/src/oauth.ts
import { createHash, randomBytes, webcrypto } from "node:crypto"
import type { OAuthClientProvider, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/client/auth.js"
import type { McpOAuthConfig, McpTokenStore } from "./types.ts"

const b64url = (buf: Buffer): string => buf.toString("base64url")

/** RFC 7636 §4.1：32 隨機位元組→43 字元 base64url verifier。 */
export function generateCodeVerifier(): string {
  return b64url(randomBytes(32))
}

/** RFC 7636 §4.2：S256 = base64url(sha256(utf8(verifier)))。分流給測試向量。 */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return b64url(Buffer.from(digest))
}

/** Store keys：provider 內部的持久化 key（run.ts 反向適配器把它們映射到 coordinator 文件）。 */
export type OAuthStoreKey = "tokens" | "client" | "verifier" | "state" | "pending-url"

export interface OAuthProviderConfig {
  serverName: string
  auth: McpOAuthConfig
  /** 確定端口後（伺服器已 listen）才算得出——由 createConnectedClient 組進。 */
  redirectUrl: string
}

/**
 * 官方 SDK OAuthClientProvider 的 IH 實作（吸收 opencode core/src/mcp/oauth-provider.ts 形狀）。
 * 狀態（state/verifier/tokens/client）全部走注入的 McpTokenStore——記憶體預設、coordinator
 * 文件持久化由 CLI 適配（fs-lock doc:<key> 紀律在 coordinator 層，見 run.ts）。
 * fail-closed：授權未完成前 redirectUrl/code 不存在 → 回調超時 → McpOAuthError。
 */
export function createOAuthClientProvider(config: OAuthProviderConfig): OAuthClientProvider {
  const { auth, serverName } = config
  const store: McpTokenStore =
    auth.store ?? { get: async () => undefined, put: async () => undefined } // 記憶體預設 = 不持久化
  // null 視同 absent：invalidateCredentials 以 put(key, null) 表達刪除（coordinator 文件 API 只有
  // put/get 兩員——putDocument(key, null) 對 jsonl 安全（寫 null 台），讀回 null 同樣視為空）。
  const get = <T>(key: OAuthStoreKey): Promise<T | undefined> =>
    store.get(`oauth:${serverName}:${key}`).then((v) => (v === undefined || v === null ? undefined : (v as T)))
  const put = (key: OAuthStoreKey, data: unknown): Promise<void> => store.put(`oauth:${serverName}:${key}`, data)

  const scopes = auth.scopes ?? []
  const clientMetadata: OAuthClientMetadata = {
    clientId: auth.clientId ?? "i-harness",
    clientName: "i-harness",
    clientUri: "https://github.com/i-harness/i-harness",
    redirectUrls: [config.redirectUrl],
    grantTypes: ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethod: "none",
    ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
  }
  let savedVerifier = "" // runtime 記憶體（跨 waitForCallback 的 finishAuth 提取）

  return {
    get redirectUrl() { return config.redirectUrl },
    get clientMetadata() { return clientMetadata },
    async state() { const s = generateCodeVerifier(); await put("state", s); return s },
    async clientInformation() { return get("client") },
    async saveClientInformation(info) { await put("client", info) },
    async tokens() { return get<OAuthTokens>("tokens") },
    async saveTokens(t) { await put("tokens", t) },
    async redirectToAuthorization(authorizationUrl) {
      // headless：不自動開瀏覽器；URL 三路出去——console（人讀）、store（poll）與
      // auth.onRedirect（宿主自動開瀏覽器）。
      await put("pending-url", authorizationUrl.href)
      console.info(`[i-harness] mcp-server(${serverName}) OAuth: authorize at ${authorizationUrl.href}`)
      try { auth.onRedirect?.(authorizationUrl.href) } catch { /* 宿主回調拋錯不影響授權 */ }
    },
    async saveCodeVerifier(v) { savedVerifier = v; await put("verifier", v) },
    async codeVerifier() { return savedVerifier || ((await get("verifier")) as string) },
    async invalidateCredentials(scope) {
      if (scope === "all") await put("state", null)
      if (scope === "client") await put("client", null)
      if (scope === "tokens" || scope === "all") await put("tokens", null)
      if (scope === "verifier" || scope === "all") await put("verifier", null)
    },
  }
}
```

- [ ] **Step 5: 寫回調伺服器測試（oauth-callback.test.ts）**

```ts
// packages/mcp-client/test/oauth-callback.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createOAuthCallbackServer, type OAuthCallbackServer } from "../src/oauth-callback.ts"

let server: OAuthCallbackServer | undefined
afterEach(async () => { await server?.stop(); server = undefined })

it("serves /oauth/callback and resolves waitForCallback with code+state", async () => {
  server = createOAuthCallbackServer({ port: 0 })
  const { port } = await server.listen()
  expect(server.redirectUrl()).toBe(`http://127.0.0.1:${port}/oauth/callback`)
  const promise = server.waitForCallback("state-abc", { timeoutMs: 5000 })
  const res = await fetch(server.redirectUrl() + "?code=CODE123&state=state-abc", {})
  expect(res.status).toBe(200)
  await expect(promise).resolves.toEqual({ code: "CODE123", state: "state-abc" })
})

it("rejects when the state does not match", async () => {
  server = createOAuthCallbackServer({ port: 0 })
  await server.listen()
  const promise = server.waitForCallback("expected-state", { timeoutMs: 5000 })
  await fetch(server.redirectUrl() + "?code=X&state=evil", {})
  await expect(promise).rejects.toThrow(/state mismatch/)
})

it("times out with McpOAuthError when nobody authorizes", async () => {
  server = createOAuthCallbackServer({ port: 0 })
  await server.listen()
  await expect(server.waitForCallback("s", { timeoutMs: 150 })).rejects.toThrow(/not completed within/)
})

it("second listen on the same port fails closed", async () => {
  server = createOAuthCallbackServer({ port: 0 })
  const { port } = await server.listen()
  const other = createOAuthCallbackServer({ port })
  await expect(other.listen()).rejects.toThrow()
  await other.stop()
})

it("stop() rejects pending waiters and releases the port", async () => {
  server = createOAuthCallbackServer({ port: 0 })
  await server.listen()
  const promise = server.waitForCallback("s", { timeoutMs: 60_000 })
  await server.stop()
  await expect(promise).rejects.toThrow(/stopped/)
})
```

- [ ] **Step 6: 跑確認失敗**

Run: `pnpm --filter @i-harness/mcp-client test test/oauth-callback.test.ts`
Expected: FAIL——`../src/oauth-callback.ts` 不存在（`McpOAuthError` 已於 Step 1 就位）。

- [ ] **Step 7: 實作 oauth-callback.ts（node:http）**

```ts
// packages/mcp-client/src/oauth-callback.ts
import { createServer, type Server } from "node:http"
import { McpOAuthError } from "./errors.ts"

export interface OAuthCallbackServer {
  listen(): Promise<{ port: number }>
  port(): number
  redirectUrl(): string
  /** 等待用户在瀏覽器完成授權後被 redirect 回來。state 不符 → 拒絕（防 CSRF）。 */
  waitForCallback(state: string, opts: { timeoutMs: number }): Promise<{ code: string; state: string }>
  stop(): Promise<void>
}

const PATH = "/oauth/callback"
const PAGE = "<!doctype html><meta charset=utf-8><title>i-harness OAuth</title><body style='font-family:sans-serif;max-width:32rem;margin:4rem auto'><h1>i-harness</h1><p>授權完成——你可以關閉此頁面並返回終端。</p></body>"

// 127.0.0.1 限定（OAuth 2.1 回調網絡安全要求；永不綁 0.0.0.0）。port 0 = 系統分配。
export function createOAuthCallbackServer(opts?: { port?: number; host?: string }): OAuthCallbackServer {
  const host = opts?.host ?? "127.0.0.1"
  let port = opts?.port ?? 0
  let server: Server | undefined
  // 單 flight：waitForCallback 每次授權流程產生一次 pending promise；stop 全部拒絕。
  let pending: { resolve: (v: { code: string; state: string }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined

  const handle = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`)
    if (url.pathname !== PATH) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" })
      res.end("not found")
      return
    }
    const code = url.searchParams.get("code") ?? ""
    const state = url.searchParams.get("state") ?? ""
    if (pending && code !== "" && state !== "" && state === expectedState) {
      clearTimeout(pending.timer)
      const p = pending
      pending = undefined
      p.resolve({ code, state })
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(PAGE)
      return
    }
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" })
    res.end("OAuth callback rejected: missing/invalid state parameter")
    if (pending) {
      clearTimeout(pending.timer)
      const p = pending
      pending = undefined
      p.reject(new McpOAuthError("OAuth callback state mismatch"))
    }
  }
  let expectedState = ""

  return {
    async listen() {
      if (server) throw new McpOAuthError("OAuth callback server already listening")
      // EADDRINUSE（端口被佔）→ 原有錯誤直接傳播（fail-closed，不換端口重試）。
      server = createServer(handle)
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject)
        server!.listen(port, host, resolve)
      })
      port = (server.address() as import("node:net").AddressInfo).port
      return { port }
    },
    port: () => port,
    redirectUrl: () => `http://${host}:${port}${PATH}`,
    async waitForCallback(state, { timeoutMs }) {
      // single-flight：無兩次 concurrency（connect 迴圈順序調用）；重入即 throw（fail-closed）。
      if (pending) throw new McpOAuthError("callback wait already in flight")
      expectedState = state
      const timer = setTimeout(() => {
        const p = pending
        pending = undefined
        p?.reject(new McpOAuthError(`OAuth authorization not completed within ${timeoutMs}ms`))
      }, timeoutMs)
      return new Promise<{ code: string; state: string }>((resolve, reject) => {
        pending = { resolve, reject, timer }
      })
    },
    async stop() {
      const p = pending
      pending = undefined
      if (p) { clearTimeout(p.timer); p.reject(new McpOAuthError("OAuth callback server stopped")) }
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()))
        server = undefined
      }
    },
  }
}
```

（「stop rejects pending」測試對應 stop 處置；回調成功分支 `clearTimeout` + resolve、state 不符分支 `clearTimeout` + reject——都已在上方 `handle` 內。）

- [ ] **Step 8: transport.ts 接 authProvider + client.ts 授權迴圈**

```ts
// packages/mcp-client/src/transport.ts（修改）
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"

export interface McpAuthAttachment { provider: OAuthClientProvider }

export async function createTransport(
  config: McpServerConfig,
  auth?: McpAuthAttachment,
): Promise<StdioClientTransport | StreamableHTTPClientTransport> {
  if (config.transport === "stdio") { /* 原樣 */ }
  // streamable-http：authProvider 存在時 SDK 負擔 discovery/refresh；401 → redirect → UnauthorizedError。
  return new StreamableHTTPClientTransport(new URL(config.url), {
    ...(config.headers !== undefined ? { requestInit: { headers: config.headers } } : {}),
    ...(auth !== undefined ? { authProvider: auth.provider } : {}),
  })
}
```

```ts
// packages/mcp-client/src/client.ts（修改——連線段路由）
import { OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { createOAuthCallbackServer, type OAuthCallbackServer } from "./oauth-callback.ts"
import { createOAuthClientProvider } from "./oauth.ts"
import { McpOAuthError } from "./errors.ts"

const MAX_AUTH_ATTEMPTS = 3
const AUTH_RETRY_DELAY_MS = 1_000

// OAuth 連線迴圈：connect → UnauthorizedError（SDK 已叫過 provider.redirectToAuthorization，
// 瀏覽器流啟動中）→ 等回調碼 → transport.finishAuth(code) → 重試 connect。超時/3 次仍失敗
// → McpOAuthError（fail-closed：不省略、不帶傷掛載）。
async function connectWithAuth(
  client: Client,
  transport: StreamableHTTPClientTransport,
  server: OAuthCallbackServer,
  provider: OAuthClientProvider,
  config: McpServerConfig & { transport: "streamable-http" },
): Promise<void> {
  const timeoutMs = config.auth!.authTimeoutMs ?? 300_000
  for (let attempt = 0; ; attempt++) {
    try {
      await client.connect(transport)
      return
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err
      if (attempt >= MAX_AUTH_ATTEMPTS) {
        throw new McpOAuthError(`authorization repeated UnauthorizedError ${MAX_AUTH_ATTEMPTS} times`)
      }
      const state = await provider.state!()
      const { code } = await server.waitForCallback(state, { timeoutMs: timeoutMs })
      await transport.finishAuth(code)
      await new Promise((r) => setTimeout(r, AUTH_RETRY_DELAY_MS))
    }
  }
}

export async function createConnectedClient(config: McpServerConfig): Promise<ConnectedMcpClient> {
  // OAuth 組裝：先綁回調端口才能得出 redirectUrl（端口 0 = 系統分配；EADDRINUSE fail-closed）。
  let oauthServer: OAuthCallbackServer | undefined
  let oauthProvider: OAuthClientProvider | undefined
  if (config.transport === "streamable-http" && config.auth !== undefined) {
    // 端口解析：auth.callbackPort → 用之；否則若 redirectUrl 顯式給了，用其中端口
    // （註冊的 redirect 必須與實際綁定一致）；否則端口 0（系統分配，redirectUrl 由 server 組裝）。
    const explicitPort =
      config.auth.callbackPort ??
      (config.auth.redirectUrl !== undefined && new URL(config.auth.redirectUrl).port !== ""
        ? Number(new URL(config.auth.redirectUrl).port)
        : undefined)
    oauthServer = createOAuthCallbackServer(explicitPort !== undefined ? { port: explicitPort } : { port: 0 })
    await oauthServer.listen()
    const redirectUrl = config.auth.redirectUrl ?? oauthServer.redirectUrl()
    oauthProvider = createOAuthClientProvider({
      serverName: config.serverName,
      auth: config.auth,
      redirectUrl: redirectUrl,
    })
  }
  try {
    const transport = await createTransport(config, oauthProvider ? { provider: oauthProvider } : undefined)
    const client = new Client({ name: "i-harness-mcp-client", version: "0.1.0" })
    // （onclose 接線與既有相同）
    if (oauthServer && oauthProvider) {
      await connectWithAuth(
        client,
        transport as StreamableHTTPClientTransport,
        oauthServer,
        oauthProvider,
        config as McpServerConfig & { transport: "streamable-http" },
      )
    } else {
      await client.connect(transport)
    }
    // 其餘回傳物件照舊
  } catch (err) {
    await oauthServer?.stop().catch(() => {})
    throw err
  }
  // return 物件的 close()（既有閉包內改為——回調伺服器與 SDK 客戶端一併關）：
  async close() {
    await oauthServer?.stop().catch(() => {})
    await client.close()
  },
}
```

（若 `UnauthorizedError` 在連接處不是 prototype 命中（SDK 內部包了一層），改用 `err instanceof UnauthorizedError || (err as { code?: unknown }).code === "UnauthorizedError"` 字形判斷——step 9 的整合測試會揭示，兩種都寫上。）

- [ ] **Step 9: 寫端到端整合測試（oauth-integration.test.ts）：mock OAuth+MCP HTTP 伺服器**

```ts
// packages/mcp-client/test/oauth-integration.test.ts
// 完整 OAuth 2.1 流對官方 SDK(1.30.0) 的端到端驗證。fake server（temp .mjs + node:http 手寫
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
import { execPath } from "node:process"
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

describe("OAuth integration", () => {
  it(
    "end-to-end: discovery → dynamic registration → redirect → code exchange → authed tools/list",
    async () => {
      // 挑一個閒置端口（bind 0 → 送出 → 關閉；唯一性足以支撐單一測試）
      const tmp = createServer()
      await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", r))
      const port = (tmp.address() as import("node:net").AddressInfo).port
      await new Promise<void>((r) => tmp.close(() => r()))
      const serverPort = port
      // 把 fake 檔案寫在 temp（client.test.ts 的 fake-stdio-server 模式——單核子進程）
      const dir = mkdtempSync(join(tmpdir(), "m26-oauth-"))
      const script = join(dir, "fake-oauth-mcp.mjs")
      writeFileSync(script, FAKE)
      const child = (await import("node:child_process")).fork(script, [], {
        env: { ...process.env, PORT: String(serverPort) },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      })
      const report = () => new Promise<any>((resolve) => child.once("message", resolve))
      try {
        let authUrl: string | undefined
        // createConnectedClient 在連線後因 401 → SDK 呼叫 redirectToAuthorization → 我們的
        // onRedirect 捕獲授權 URL；同時 connectWithAuth 在 waitForCallback 等使用者完成。
        const pending = createConnectedClient({
          transport: "streamable-http",
          serverName: "oauth",
          url: `http://127.0.0.1:${serverPort}/mcp`,
          auth: {
            callbackPort: serverPort,              // 回調伺服器與 MCP 端點同埠（不同 path）
            redirectUrl: `http://127.0.0.1:${serverPort}/oauth/callback`,
            authTimeoutMs: 30_000,
            onRedirect: (u) => { authUrl = u },
          },
        })
        await waitFor(() => authUrl !== undefined)
        await fetch(authUrl!) // 走 <authorize> → 302 → 我們自己的 callback server
        const client = await pending                 // auth 循環完成：finishAuth → 重連成功
        const { tools } = await client.listTools()
        expect(tools.map((t) => t.name)).toContain("remote_echo")   // 認證後的 tools/list 直達
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
```

- [ ] **Step 10: 跑整合測試並依 SDK 實際行為校正 fake（預期來回 1 次）**

Run: `pnpm --filter @i-harness/mcp-client test test/oauth-integration.test.ts`
Expected: PASS。**校正規則**：fake 是測試資產、SDK 行為是真相——若 discovery 走的是 `/.well-known/oauth-protected-resource-metadata` 或其他端點組合（sdks 各版略有出入），依實際 404/400 日誌改 fake（多半是路徑/參數名），**不改 mcp-client 源碼**。同時把 Step 8 的 `UnauthorizedError` prototype 命中性驗證掉：命中 → 保留 `instanceof` 一條路；不命中 → 補上 `(err as { code?: unknown }).code === "UnauthorizedError"` 字形判斷。

- [ ] **Step 11: run.ts 接線（coordinator 文件 token store + mcp 掛載傳 auth.store）**

```ts
// apps/cli/src/run.ts（import 區加）
import type { McpTokenStore } from "@i-harness/mcp-client"

// M26-B1：OAuth token store 反向適配器——coordinator 的 putDocument/getDocument（M6 文件 API）
// 序列化寫 + fs-lock doc:<key> 租約（lock 啟用時）。provider 傳入的 key 已是全形
// `oauth:<serverName>:<kind>`（本身含 serverName 前綴），adapter 只管加 namespace 前綴。
// 寫失敗只 report（coordinator 契約：report, never reject）→ 最壞後果是下次重授權（fail-closed 方向）。
function coordinatorTokenStore(coordinator: SessionCoordinator): McpTokenStore {
  const key = (k: string) => `mcp-oauth:${k}`
  return {
    get: (k) => coordinator.getDocument(key(k)),
    put: (k, data) => coordinator.putDocument(key(k), data),
  }
}
// runHeadless 的 mcp 掛載迴圈（line ~257）改為：
for (const cfg of opts.mcp ?? []) {
  // auth 未給 store 且 coordinator 在位 → 注入 coordinator 文件 store（fs-lock doc:<key> 紀律
  // 在 coordinator 層）；coordinator 缺席 → 省略 store（mcp-client 記憶體預設：每次掛載重授權，
  // 仍然 fail-closed 不省略）。host 已給 store 則絕對尊重（不覆寫）。
  const mcpCfg =
    cfg.transport === "streamable-http" && cfg.auth !== undefined && cfg.auth.store === undefined && opts.coordinator
      ? { ...cfg, auth: { ...cfg.auth, store: coordinatorTokenStore(opts.coordinator) } }
      : cfg
  mcpHandles.push(await mountMcpClient(ctx, tools, mcpCfg, /* onStatus 原樣 */))
}
```

- [ ] **Step 12: index.ts exports + 全包測試 + 提交**

```ts
// packages/mcp-client/src/index.ts（追加）
export { createOAuthClientProvider, generateCodeVerifier, challengeFor } from "./oauth.ts"
export type { OAuthProviderConfig } from "./oauth.ts"
export { createOAuthCallbackServer } from "./oauth-callback.ts"
export type { OAuthCallbackServer } from "./oauth-callback.ts"
export { McpOAuthError } from "./errors.ts"
export type { McpOAuthConfig, McpTokenStore } from "./types.ts"
```

Run: `pnpm --filter @i-harness/mcp-client test && pnpm --filter @i-harness/mcp-client typecheck`
Expected: 全綠（含既有 client/bridge/supervisor/lifecycle/reconnect——`transport.ts`/`client.ts` 改動是 additive：`createTransport` 第二參數 optional、非 auth 走原路徑）。

```bash
git add packages/mcp-client apps/cli/src/run.ts
git commit -m "M26-B1a: mcp-client OAuth 2.1 (PKCE + dynamic registration + callback server + token store)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: B1-2 roots 能力 + 資源模板工具

**Files:**
- Modify: `packages/mcp-client/src/{types.ts,client.ts,resources.ts,index.ts}`
- Create: `packages/mcp-client/test/roots.test.ts`
- Modify: `packages/mcp-client/test/resources.test.ts`

**Interfaces:**
- Consumes: SDK `ListRootsRequestSchema`/`ListResourceTemplatesResultSchema`（types.js——roots/list 是 server→client 請求，client.request 不行，需 `setRequestHandler`；registerCapabilities 須在 connect 前）、Task 1 的 `ConnectedMcpClient`
- Produces:
  - `McpServerConfig`（兩變體）加 `roots?: string[]`（絕對路徑 → file://，http(s) URL 原樣，相對路徑 → 對 cwd 解析）
  - `resolveRootUris(roots: string[]): string[]`（純函數——可單測）
  - `ConnectedMcpClient.listResourceTemplates?(signal?: AbortSignal)`（optional——既有 fake 測試零改動，onDisconnect 先例）
  - `resources.ts` 新工具 `list_mcp_resource_templates__<server>`

- [ ] **Step 1: 寫失敗測試（roots.test.ts）**

```ts
// packages/mcp-client/test/roots.test.ts
import { describe, expect, it } from "vitest"
import { pathToFileURL } from "node:url"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveRootUris } from "../src/client.ts"

it("absolute paths become file:// URIs; http(s) URLs pass through; Windows drive letters stay paths", () => {
  const ws = mkdtempSync(join(tmpdir(), "m26-roots-"))
  expect(resolveRootUris([ws])).toEqual([pathToFileURL(ws).href])
  expect(resolveRootUris(["https://example.com/r"])).toEqual(["https://example.com/r"])
  // C:\ 是盤符不是 scheme——不能把 "c:" 當 URL protocol 解析
  expect(resolveRootUris(["C:\\project\\src"])).toEqual([pathToFileURL("C:\\project\\src").href])
})

it("relative paths resolve against the process cwd", () => {
  const expected = pathToFileURL(join(process.cwd(), "relative/path")).href
  expect(resolveRootUris(["relative/path"])).toEqual([expected])
})
```

- [ ] **Step 2: 跑確認失敗**

Run: `pnpm --filter @i-harness/mcp-client test test/roots.test.ts`
Expected: FAIL——`resolveRootUris` 不存在。

- [ ] **Step 3: 實作（client.ts + types.ts + resources.ts）**

```ts
// packages/mcp-client/src/client.ts（新增/修改）
import { pathToFileURL } from "node:url"
import { basename, isAbsolute, resolve } from "node:path"
import { ListRootsRequestSchema, ListResourceTemplatesResultSchema } from "@modelcontextprotocol/sdk/types.js"

/** roots 設定 → roots/list 回應的 uri 陣列。絕對路徑 → file://（Windows 盤符安全），
 *  http/https URL 原樣，相對路徑對 cwd resolve（fail-closed：非空字串已在 validateMcpConfig 擋）。 */
export function resolveRootUris(roots: string[]): string[] {
  return roots.map((r) => {
    // Windows 盤符（C:\..）先於 scheme 判斷——"c:" 不是 URL protocol
    if (/^[a-zA-Z]:[\\/]/.test(r) || isAbsolute(r)) return pathToFileURL(r).href
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(r)) {
      try { return new URL(r).href } catch { /* fall through: 看作相對路徑 */ }
    }
    return pathToFileURL(resolve(r)).href
  })
}

// 在 createConnectedClient 內、client.connect 之前（兩者都必須在 connect 前）：
client.registerCapabilities({ roots: { listChanged: false } })
client.setRequestHandler(ListRootsRequestSchema, () => ({
  roots: resolveRootUris(config.roots ?? []).map((uri) => ({
    uri,
    name: basename(new URL(uri).pathname) || uri,
  })),
}))
// ConnectedMcpClient 加（optional，既有 fake 陣列零改動——onDisconnect 先例）：
async listResourceTemplates(signal) {
  const response = await client.request(
    { method: "resources/templates/list", params: {} } as never,
    ListResourceTemplatesResultSchema,
    { timeout, signal },
  )
  return response.resourceTemplates
},
// index.ts 加 in file header：export { resolveRootUris } from "./client.ts"
```

```ts
// packages/mcp-client/src/types.ts（validateMcpConfig 加）
if (config.roots !== undefined) {
  if (!Array.isArray(config.roots) || config.roots.length > 200) throw new Error("mcp-client: roots must be a string array with at most 200 entries")
  for (const r of config.roots) {
    if (typeof r !== "string" || r.length === 0) throw new Error("mcp-client: roots entries must be non-empty strings")
  }
}
```

```ts
// packages/mcp-client/src/resources.ts（加第三個工具）
export function createResourceTools(client, serverName, config): Tool[] {
  const listName = `list_mcp_resources__${serverName}`
  const templatesName = `list_mcp_resource_templates__${serverName}`
  const readName = `read_mcp_resource__${serverName}`
  return [ /* 既有兩枚保持 */, {
    name: templatesName,
    description: `List MCP resource templates from server "${serverName}" (use a template's uriTemplate with read_mcp_resource__${serverName})`,
    inputSchema: { type: "object", properties: { server: { type: "string" } } },
    timeoutMs: config.toolCallTimeoutMs,
    async execute(args: { server?: string }, exec: ToolExec) {
      if (!client.listResourceTemplates) throw new Error(`mcp-server(${serverName}): resources/templates/list unsupported by this build's client`)
      return client.listResourceTemplates(exec.abortSignal)
    },
  }]
}
```

- [ ] **Step 4: 跑測試 + resources.test.ts 補模板斷言**

Run: `pnpm --filter @i-harness/mcp-client test`
Expected: PASS——roots 單元 + resources 模板工具（fake client 補 `listResourceTemplates` spy 斷言 uri 前進）。

- [ ] **Step 5: index.ts export `resolveRootUris` + 提交**

```bash
git add packages/mcp-client
git commit -m "M26-B1b: mcp-client roots capability + resource template tools

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: B1-3 blocked/direct 策略

**Files:**
- Modify: `packages/mcp-client/src/{types.ts,bridge.ts,index.ts}`
- Modify: `packages/mcp-client/test/sync.test.ts`
- Modify: `apps/cli/src/run.ts`（無需——config 由宿主帶；僅在 mcp 掛載處不需動）

**Interfaces:**
- Consumes: Task 2 的 `McpServerConfig`、`syncTools`、`createMcpTool`
- Produces: `McpServerConfig` 加 `blockedTools?: string[]; directTools?: string[]`；`createMcpTool` 加 `exposure?: "direct" | "deferred"` 字段

- [ ] **Step 1: 寫失敗測試（sync.test.ts 追加）**

```ts
// packages/mcp-client/test/sync.test.ts（追加 describe）
describe("blocked/direct policy", () => {
  function clientWith(tools: Array<{ name: string }>) {
    return {
      async listTools() { return { tools } },
      async callTool() { return { content: [] } },
      async listResources() { return [] },
      async readResource() { return [] },
      async close() {},
    } as unknown as ConnectedMcpClient
  }
  function cfg(extra: object) { return { transport: "stdio", serverName: "files", command: "x", args: [], ...extra } as McpServerConfig }

  it("blocked tools are never registered; others still are", async () => {
    const reg = registry()
    const disposers = await syncTools(
      clientWith([{ name: "safe" }, { name: "nuke" }]),
      reg,
      cfg({ blockedTools: ["nuke"] }),
    )
    const names = reg.schemas().map((s) => s.name)
    expect(names).toContain("mcp__files__safe")
    expect(names).not.toContain("mcp__files__nuke")
    // 每個 registered 工具都有對應 disposer
    expect([...disposers.keys()]).toContain("mcp__files__safe")
    expect([...disposers.keys()]).not.toContain("mcp__files__nuke")
  })

  it("blocked wins over direct (a tool in both lists stays unregistered)", async () => {
    const reg = registry()
    await syncTools(clientWith([{ name: "nuke" }]), reg, cfg({ blockedTools: ["nuke"], directTools: ["nuke"] }))
    expect(reg.schemas().map((s) => s.name)).not.toContain("mcp__files__nuke")
  })

  it("directTools narrows exposure: listed tools direct, everything else deferred", async () => {
    const reg = registry()
    const disposers = await syncTools(
      clientWith([{ name: "hot" }, { name: "cold" }]),
      reg,
      cfg({ directTools: ["hot"] }),
    )
    // exposure 直接落在 Tool 物件（createMcpTool 5th 參數）；schemas 表面由真 registry 過濾——
    // 此處用 registry stub 的 get 斷言即可（sync.test 慣例：stub schemas 不複製 exposure 過濾）
    expect(reg.get("mcp__files__hot")).toMatchObject({ exposure: "direct" })
    expect(reg.get("mcp__files__cold")).toMatchObject({ exposure: "deferred" })
    expect([...disposers.keys()]).toEqual(expect.arrayContaining(["mcp__files__hot", "mcp__files__cold"]))
  })

  it("absent directTools keeps today's behavior: everything direct", async () => {
    const reg = registry()
    await syncTools(clientWith([{ name: "any" }]), reg, cfg({}))
    expect(reg.get("mcp__files__any")).toMatchObject({ exposure: "direct" })
  })
})
```

（`registry()` stub 的 `get` 回傳 Tool——斷言 `exposure` 需 Tool 物件。sync.test 既有 stub 滿足。）

- [ ] **Step 2: 跑確認失敗**

Run: `pnpm --filter @i-harness/mcp-client test test/sync.test.ts`
Expected: FAIL——blocked/direct 欄位不存在、exposure 未輸出。

- [ ] **Step 3: 實作（types.ts 驗證 + bridge.ts 過濾）**

```ts
// packages/mcp-client/src/types.ts（兩變體各加；validateMcpConfig 加）
function validateNameList(list: string[] | undefined, label: string): void {
  if (list === undefined) return
  if (!Array.isArray(list) || list.length > 200) throw new Error(`mcp-client: ${label} must be a string array with at most 200 entries`)
  for (const n of list) {
    if (typeof n !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(n)) {
      throw new Error(`mcp-client: ${label} entries must match ^[A-Za-z0-9_-]{1,64}$ (got ${String(n)})`)
    }
  }
  if (new Set(list).size !== list.length) throw new Error(`mcp-client: ${label} must not contain duplicates`)
}
// validateMcpConfig 內：
validateNameList(config.blockedTools, "blockedTools")
validateNameList(config.directTools, "directTools")
```

```ts
// packages/mcp-client/src/bridge.ts（修改）
// createMcpTool 加：exposure?: "direct" | "deferred"
return {
  name: publicName,
  description: tool.description ?? "MCP tool",
  inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
  timeoutMs: config.toolCallTimeoutMs,
  ...(exposure !== undefined ? { exposure } : {}),
  async execute(args, exec) { /* 原樣 */ },
}

// syncTools Phase 1（兩 while 之間、next.set 前）：
const blocked = new Set(config.blockedTools ?? [])
const direct = new Set(config.directTools ?? [])
const listedNames = new Set<string>() // Phase 1 逐一累積——供未知清單比對
// 每迴圈內：
listedNames.add(tool.name)
if (blocked.has(tool.name)) {
  console.warn(`mcp-client(${serverName}): tool "${tool.name}" is blocked by config — not registered`)
  continue
}
// Phase 2 register 處：
const exposure = direct.size > 0 && !direct.has(tool.name) ? "deferred" : "direct"
tools.register(createMcpTool(client, publicName, rawName, tool, config, exposure))
// Phase 1 迴圈結束後（首次 sync 前）來一份未知清單警告（拼寫錯誤 fail-loud 但不 fail-close）：
for (const name of [...blocked, ...direct]) {
  if (!listedNames.has(name)) console.warn(`mcp-client(${serverName}): "${name}" is in blockedTools/directTools but the server never lists it`)
}
```

（`syncTools` 對 re-sync 的衝突語義不變：`exposure` 不影響 rollback 行為。`registry()` stub 用 `get` 斷言即可。）

- [ ] **Step 4: 跑測試 + 提交**

Run: `pnpm --filter @i-harness/mcp-client test && pnpm --filter @i-harness/mcp-client typecheck`
Expected: 全綠。

```bash
git add packages/mcp-client
git commit -m "M26-B1c: mcp-client blockedTools/directTools policy

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: B2 terminal 包（node-pty + TerminalService + 六工具）

**Files:**
- Create: `packages/terminal/{package.json,tsconfig.json}`
- Create: `packages/terminal/src/{service.ts,tool.ts,index.ts}`
- Create: `packages/terminal/test/terminal.test.ts`
- Modify: `pnpm-workspace.yaml`（allowBuilds + node-pty）
- Modify: `THIRD_PARTY_NOTICES`、`apps/cli/src/run.ts`（registerTerminal + finally dispose）

**Interfaces:**
- Consumes: `@i-harness/core-tools` `Tool/ToolExec`（`ToolExec.sessionId`——M19 呼叫者身份）、`@i-harness/core-plugin` `PluginContext.services`
- Produces:
  - `TerminalOpenSpec { command; args?; cwd?; env?; cols?; rows? }`、`TerminalSignalName = "INT" | "TERM" | "KILL"`、`TerminalView`、`TerminalReadResult`、`TerminalService`（open/send/read/signal/close/resize/list/waitExited/dispose）
  - `registerTerminal(ctx, tools, opts?) → { dispose(): void }`
  - 六工具：`terminal_open`/`terminal_send`/`terminal_read`/`terminal_signal`/`terminal_close`/`terminal_list`（Task 5 再加三支 process_*）

- [ ] **Step 0: 裝依賴（先決）**

```bash
cd D:/I-harness-main
mkdir -p packages/terminal/src packages/terminal/test
# 在 packages/terminal/package.json 加：
# { "name": "@i-harness/terminal", "private": true, "type": "module",
#   "exports": { ".": "./src/index.ts" },
#   "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
#   "dependencies": { "@i-harness/core-tools": "workspace:*", "@i-harness/core-plugin": "workspace:*", "node-pty": "^1.1.0" } }
# tsconfig.json 與 mcp-client 相同（extends ../../tsconfig.base.json + include ["src/**/*.ts","test/**/*.ts"]）
pnpm install --filter @i-harness/terminal
pnpm config enable-pre-post-scripts 2>/dev/null || true
```
然後把 `node-pty` 加進 `pnpm-workspace.yaml` 的 `allowBuilds`：

```yaml
allowBuilds:
  esbuild: true
  koffi: true
  node-pty: true   # M26-B2: node-pty 原生綁定（見 Global Constraints 例外依據）
```
再次 `pnpm install`（觸發 node-pty 的 postinstall/prebuild 下載）。

- [ ] **Step 1: 寫失敗測試（terminal.test.ts）**

```ts
// packages/terminal/test/terminal.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createTerminalService, type TerminalService } from "../src/service.ts"

const ECHO_SCRIPT = `process.stdin.on('data', d => { process.stdout.write('ECHO:' + d.toString().trim() + '\\n') })
process.stdout.write('READY\\n')`

let svc: TerminalService
beforeEach(() => { svc = createTerminalService() })
afterEach(() => { svc.dispose() })

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (cond()) return; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error("timed out waiting")
}

it("open + read: spawns a pty and exposes output (CRLF normalized)", async () => {
  const t = svc.open({ command: process.execPath, args: ["-e", ECHO_SCRIPT] })
  await waitFor(() => svc.read(t.id).data.includes("READY"))
  const r = svc.read(t.id)
  expect(r.data).toContain("READY\n")
  expect(r.data).not.toContain("\r")
})

it("send: writes to stdin; terminal echo returns through read with offsets", async () => {
  const t = svc.open({ command: process.execPath, args: ["-e", ECHO_SCRIPT] })
  await waitFor(() => svc.read(t.id).data.includes("READY"))
  const r0 = svc.read(t.id)
  svc.send(t.id, "hi")
  await waitFor(() => svc.read(t.id, { offset: r0.nextOffset }).data.includes("ECHO:hi"))
  const r1 = svc.read(t.id, { offset: r0.nextOffset })
  expect(r1.data).toContain("ECHO:hi")
  expect(r1.nextOffset).toBeGreaterThan(r0.nextOffset)
  // idempotent offsets：重讀同一 offset → 同資料
  expect(svc.read(t.id, { offset: r0.nextOffset }).data).toBe(r1.data)
})

it("read maxBytes truncates and raises nextOffset", async () => {
  const t = svc.open({ command: process.execPath, args: ["-e", `process.stdout.write('abcdefgh')`] })
  await waitFor(() => svc.read(t.id).data.length > 0)
  const full = svc.read(t.id).data
  const part = svc.read(t.id, { maxBytes: 3 })
  expect(part.truncated).toBe(true)
  expect(part.data.length).toBe(3)
  expect(part.nextOffset).toBe(3)
  expect(full).toContain("abcdefgh")
})

it("signal TERM: process exits; waitExited resolves", async () => {
  const t = svc.open({ command: process.execPath, args: ["-e", "setTimeout(()=>{}, 60000)"] })
  const exited = svc.waitExited(t.id)
  svc.signal(t.id, "TERM")
  const res = await exited
  expect(res.exitCode).not.toBe(0)
  expect(svc.list().find((v) => v.id === t.id)?.status).toBe("exited")
})

it("resize: updates cols/rows on the view", () => {
  const t = svc.open({ command: process.execPath, args: ["-e", "0"] })
  svc.resize(t.id, 100, 40)
  expect(svc.list().find((v) => v.id === t.id)).toMatchObject({ cols: 100, rows: 40 })
})

it("close: terminal disappears from list; unknown ids fail closed", async () => {
  const t = svc.open({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] })
  svc.close(t.id)
  expect(svc.list().map((v) => v.id)).not.toContain(t.id)
  expect(() => svc.read(t.id)).toThrow(/TERMINAL_NOT_FOUND/)
  expect(() => svc.close(t.id)).toThrow(/TERMINAL_NOT_FOUND/)
})

it("owner scope: opened with sessionId, other sessions (and anonymous exec) are refused", async () => {
  const t = svc.open({ command: process.execPath, args: ["-e", "0"] }, { sessionId: "sess-a" })
  expect(() => svc.send(t.id, "x", { sessionId: "sess-b" })).toThrow(/OWNER_MISMATCH/)
  expect(() => svc.send(t.id, "x")).toThrow(/OWNER_MISMATCH/)                     // 匿名執行視同非 owner
  expect(() => svc.close(t.id, { sessionId: "sess-b" })).toThrow(/OWNER_MISMATCH/)
  expect(() => svc.close(t.id, { sessionId: "sess-a" })).not.toThrow()
  // 未帶 sessionId 開啟的 terminal 不受限
  const t2 = svc.open({ command: process.execPath, args: ["-e", "0"] })
  expect(() => svc.send(t2.id, "x")).not.toThrow()
  svc.close(t2.id)
})

it("dispose: closes every terminal and pending waitExited reject", async () => {
  const t = svc.open({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] })
  const w = svc.waitExited(t.id)
  svc.dispose()
  await expect(w).rejects.toThrow(/disposed/)
  expect(svc.list()).toEqual([])
})
```

（Windows 下 node-pty 用 ConPTY；`process.execPath -e` 在 pty 中輸出「READY\n」需 `\r\n`——service 層總是歸一 CRLF→LF 再進市場沖。ECHO 的 stdin echo 在 ConPTY 會回送…… ConPTY 回送由 pty.onData 只給應用輸出（不給 echo 前的輸入），故「ECHO:hi」由應用印出——測試成立。）

- [ ] **Step 2: 跑確認失敗（node-pty 載入）**

Run: `pnpm --filter @i-harness/terminal test test/terminal.test.ts`
Expected: FAIL——`../src/service.ts` 不存在（node-pty 未能載入時失敗訊息為 MODULE_NOT_FOUND 也屬此 step 接受——先驗 node-pty 可載入：`node -e "require('node-pty')"` 在該包內跑通）。

- [ ] **Step 3: 實作 service.ts**

```ts
// packages/terminal/src/service.ts
import { spawn, type IPty } from "node-pty"

export interface TerminalOpenSpec {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}
export type TerminalSignalName = "INT" | "TERM" | "KILL"
export interface TerminalView {
  id: string
  command: string
  pid: number
  status: "running" | "exited"
  exitCode?: number
  cols: number
  rows: number
  beganAt: string
  ownerSessionId?: string
}
export interface TerminalRunSpec { id: string; pid: number; cols: number; rows: number }
export interface TerminalReadResult {
  id: string
  data: string
  nextOffset: number
  truncated: boolean
  status: TerminalView["status"]
  exitCode?: number
}
export interface TerminalService {
  open(spec: TerminalOpenSpec, opts?: { sessionId?: string }): TerminalRunSpec
  send(id: string, data: string, opts?: { sessionId?: string }): void
  read(id: string, opts?: { offset?: number; maxBytes?: number; sessionId?: string }): TerminalReadResult
  signal(id: string, signal: TerminalSignalName, opts?: { sessionId?: string }): TerminalView
  close(id: string, opts?: { sessionId?: string }): TerminalView
  resize(id: string, cols: number, rows: number, opts?: { sessionId?: string }): TerminalView
  list(): TerminalView[]
  waitExited(id: string): Promise<{ exitCode?: number }>
  dispose(): void
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const DEFAULT_MAX_READ_BYTES = 64_000

// 場沖模型：每 terminal 一個 chunks 序列（string[]），offset 以 UTF-16 code unit 計
// （與 LSP position 慣例一致，文件化）。read(offset) 回傳 [offset, offset+max)：
// 可重複、可以任意游標重讀——日誌視圖語意，非消耗型。
class PtySession {
  readonly id = `term-${++PtySession.counter}`
  static counter = 0
  private chunks: string[] = []
  // 超過 RING_MAX 就丟最舊——早於 ring 起點的 offset 從 ring 起點開始（文件化缺點）。
  private static readonly RING_MAX = 1_000_000
  status: "running" | "exited" = "running"
  exitCode?: number
  readonly pty: IPty
  readonly beganAt = new Date().toISOString()
  private dataWaiters: Array<() => void> = []
  private exitWaiters: Array<{ resolve: (v: { exitCode?: number }) => void; reject: (e: Error) => void }> = []

  constructor(readonly spec: TerminalOpenSpec, readonly ownerSessionId?: string) {
    this.pty = spawn(spec.command, spec.args ?? [], {
      name: "xterm-256color",
      cols: spec.cols ?? DEFAULT_COLS,
      rows: spec.rows ?? DEFAULT_ROWS,
      cwd: spec.cwd,
      env: { ...process.env, ...(spec.env ?? {}) },
    })
    this.pty.onData((d: string) => {
      const cleaned = d.replace(/\r\n/g, "\n") // Windows pty CRLF/LF 歸一
      this.chunks.push(cleaned)
      const joined = this.chunks.join("")
      if (joined.length > PtySession.RING_MAX) this.chunks = [joined.slice(-PtySession.RING_MAX)]
      for (const w of this.dataWaiters) w()
      this.dataWaiters = []
    })
    this.pty.onExit(({ exitCode }) => {
      this.status = "exited"
      this.exitCode = exitCode
      for (const w of this.exitWaiters) w.resolve({ ...(exitCode !== undefined ? { exitCode } : {}) })
      this.exitWaiters = []
    })
  }

  textSince(offset: number): string {
    const combined = this.chunks.join("")
    if (offset >= combined.length) return ""
    return combined.slice(Math.max(0, offset))
  }

  closePty(): void { try { this.pty.kill() } catch { /* 已死 */ } }
  rejectAllExitWaiters(err: Error): void {
    for (const w of this.exitWaiters) w.reject(err)
    this.exitWaiters = []
  }
}

export function createTerminalService(): TerminalService {
  const sessions = new Map<string, PtySession>()

  function getOwned(sessions: Map<string, PtySession>, id: string, sessionId?: string): PtySession {
    const s = sessions.get(id)
    if (!s) throw new Error(`TERMINAL_NOT_FOUND: no terminal ${id}`)
    if (s.ownerSessionId !== undefined && sessionId !== s.ownerSessionId) {
      throw new Error(`TERMINAL_OWNER_MISMATCH: terminal ${id} is owned by session ${s.ownerSessionId}`)
    }
    return s
  }
  const view = (s: PtySession): TerminalView => ({
    id: s.id,
    command: s.spec.command,
    pid: s.pty.pid,
    status: s.status,
    ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
    cols: s.pty.cols,
    rows: s.pty.rows,
    beganAt: s.beganAt,
    ...(s.ownerSessionId !== undefined ? { ownerSessionId: s.ownerSessionId } : {}),
  })

  return {
    open(spec, opts) {
      const s = new PtySession(spec, opts?.sessionId)
      const pid = s.pty.pid
      sessions.set(s.id, s)
      return { id: s.id, pid, cols: s.pty.cols, rows: s.pty.rows }
    },
    send(id, data, opts) { getOwned(sessions, id, opts?.sessionId).pty.write(data) },
    read(id, opts) {
      const s = getOwned(sessions, id, opts?.sessionId)
      const offset = opts?.offset ?? 0
      const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_READ_BYTES
      const text = s.textSince(offset)
      const data = text.slice(0, maxBytes)
      return {
        id,
        data,
        nextOffset: offset + data.length,
        truncated: text.length > data.length,
        status: s.status,
        ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
      }
    },
    signal(id, signal, opts) {
      const s = getOwned(sessions, id, opts?.sessionId)
      switch (signal) {
        case "INT": s.pty.write("\x03"); break          // 終端 Ctrl+C（ConPTY cooked mode）
        case "TERM": s.pty.kill(); break                 // pty.kill（win: 終止 conpty 主體）
        case "KILL": s.pty.kill(); break
      }
      return view(s)
    },
    close(id, opts) {
      const s = getOwned(sessions, id, opts?.sessionId)
      s.closePty()
      sessions.delete(id)
      return view(s)
    },
    resize(id, cols, rows, opts) {
      const s = getOwned(sessions, id, opts?.sessionId)
      s.pty.resize(cols, rows)
      return view(s)
    },
    list() { return [...sessions.values()].map(view) },
    waitExited(id) {
      return new Promise((resolve, reject) => {
        const s = sessions.get(id)
        if (!s) { reject(new Error(`TERMINAL_NOT_FOUND: no terminal ${id}`)); return }
        if (s.status === "exited") { resolve({ ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}) }); return }
        s.exitWaiters.push({ resolve, reject }) // onExit / dispose 雙向解決
      })
    },
    dispose() {
      const err = new Error("terminal service disposed")
      for (const s of sessions.values()) { s.closePty(); s.rejectAllExitWaiters(err) }
      sessions.clear()
    },
  }
}
```

- [ ] **Step 4: 實作 tool.ts（六工具）+ registerTerminal**

```ts
// packages/terminal/src/tool.ts
import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { PluginContext } from "@i-harness/core-plugin"
import { createTerminalService, type TerminalService, type TerminalSignalName } from "./service.ts"

export interface TerminalToolDeps { service: TerminalService }

export function createTerminalTools(deps: TerminalToolDeps): Tool[] {
  const { service } = deps
  return [
    {
      name: "terminal_open",
      description:
        "Open a long-running interactive terminal (PTY) and return its id. Use terminal_send to write input, terminal_read to pull output, terminal_close when done.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Executable path" },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
          cols: { type: "number" }, rows: { type: "number" },
        },
        required: ["command"],
      },
      execute: async (args: { command: string; args?: string[]; cwd?: string; cols?: number; rows?: number }, exec: ToolExec) => {
        const spec = {
          command: args.command,
          ...(args.args !== undefined ? { args: args.args } : {}),
          ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
          ...(args.cols !== undefined ? { cols: args.cols } : {}),
          ...(args.rows !== undefined ? { rows: args.rows } : {}),
        }
        return service.open(spec, { sessionId: exec.sessionId })
      },
    },
    {
      name: "terminal_send",
      description: "Write text to a terminal's stdin (newlines are sent as '\\n').",
      inputSchema: { type: "object", properties: { id: { type: "string" }, data: { type: "string" } }, required: ["id", "data"] },
      execute: async (args: { id: string; data: string }, exec: ToolExec) => {
        service.send(args.id, args.data, { sessionId: exec.sessionId })
        return { id: args.id, sentChars: args.data.length }
      },
    },
    {
      name: "terminal_read",
      description: "Pull buffered terminal output since offset (in UTF-16 code units). Poll with nextOffset; output is normalized to LF.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, offset: { type: "number" }, maxBytes: { type: "number" } },
        required: ["id"],
      },
      isReadOnly: true,
      execute: async (args: { id: string; offset?: number; maxBytes?: number }, exec: ToolExec) => {
        return service.read(args.id, { offset: args.offset, maxBytes: args.maxBytes, sessionId: exec.sessionId })
      },
    },
    {
      name: "terminal_signal",
      description: "Send a signal to a terminal: INT (Ctrl+C), TERM (terminate), KILL (force).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, signal: { type: "string", enum: ["INT", "TERM", "KILL"] } },
        required: ["id", "signal"],
      },
      execute: async (args: { id: string; signal: TerminalSignalName }, exec: ToolExec) => {
        return service.signal(args.id, args.signal, { sessionId: exec.sessionId })
      },
    },
    {
      name: "terminal_close",
      description: "Close a terminal (terminate its process and forget it).",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: async (args: { id: string }, exec: ToolExec) => service.close(args.id, { sessionId: exec.sessionId }),
    },
    {
      name: "terminal_list",
      description: "List live terminals (the background terminal registry).",
      inputSchema: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async () => ({ terminals: service.list() }),
    },
  ]
}

export interface TerminalMountHandle { dispose(): void }
export function registerTerminal(ctx: PluginContext, tools: { register(t: Tool): void }): TerminalMountHandle {
  const service = createTerminalService()
  ctx.services.register("terminal/service", service)
  for (const tool of createTerminalTools({ service })) tools.register(tool)
  return { dispose: () => service.dispose() }
}
```

- [ ] **Step 5: 工具層測試（同檔追加）+ 全包跑**

```ts
// packages/terminal/test/terminal.test.ts（追加 describe: tool surface）
import { createTerminalTools } from "../src/tool.ts"

it("tools: six terminal tools registered with exact names and forward args to the service", async () => {
  const service = createTerminalService()
  const tools = createTerminalTools({ service })
  expect(tools.map((t) => t.name)).toEqual([
    "terminal_open", "terminal_send", "terminal_read", "terminal_signal", "terminal_close", "terminal_list",
  ])
  const open = tools.find((t) => t.name === "terminal_open")!
  const send = tools.find((t) => t.name === "terminal_send")!
  const readTool = tools.find((t) => t.name === "terminal_read")!
  const run = (await open.execute({ command: process.execPath, args: ["-e", `process.stdout.write("X")`] }, {})) as { id: string }
  expect((await send.execute({ id: run.id, data: "next" }, {})).sentChars).toBe(4)
  let data = ""
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { // offset-0 read 非消耗——可重讀輪詢
    data = String((await readTool.execute({ id: run.id }, {})) as { data: string }).data ?? ""
    if (data.includes("X")) break
    await new Promise((r) => setTimeout(r, 20))
  }
  expect(data).toContain("X")
  await tools.find((t) => t.name === "terminal_close")!.execute({ id: run.id }, {})
  expect(service.list()).toEqual([])
})
```

Run: `pnpm --filter @i-harness/terminal test`
Expected: PASS（Windows ConPTY；若 CI 無 console（pseudo-tty 無法建立）→ 在 CI 上允許 `it.skipIf(process.env.CI_SKIP_PTY)` 標記 fail-closed 但預設環境主戰場 win32 全跑）。

- [ ] **Step 6: run.ts 接線 + THIRD_PARTY_NOTICES + 提交**

```ts
// apps/cli/src/run.ts
import { registerTerminal, type TerminalMountHandle } from "@i-harness/terminal"
// line ~251 的 mounts 區加：
let terminalMount: TerminalMountHandle | undefined
// try 區（registerShell 附近）：
terminalMount = registerTerminal(ctx, tools)
// finally 區（skillsMount/workflowMount 同一迴圈器加）：
terminalMount?.dispose()
```

`THIRD_PARTY_NOTICES` 加：

```md
## node-pty (MIT)
- 來源：https://github.com/microsoft/node-pty
- 吸收：`packages/terminal/src/service.ts` — ConPTY/Winpty 後端選擇、onData/onExit 生命週期與
  CRLF 歸一（dsh packages/tool-terminal 同源機制；M26-B2 唯一新外部依賴，pnpm-workspace.yaml
  allowBuilds 對照 koffi 先例）
```

```bash
git add packages/terminal pnpm-workspace.yaml THIRD_PARTY_NOTICES apps/cli/src/run.ts pnpm-lock.yaml
git commit -m "M26-B2: @i-harness/terminal — node-pty TerminalService + six terminal tools

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: B8 進程控制面（process_spawn/kill/resize_pty）

**Files:**
- Modify: `packages/terminal/src/tool.ts`（三工具）、`packages/terminal/src/index.ts`
- Create: `packages/terminal/test/process-tools.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `TerminalService`（open/signal/close/resize/waitExited——service 不改）
- Produces: `createProcessTools(deps: { service: TerminalService }): Tool[]`；`registerTerminal` 改為同時註冊六 terminal + 三 process 工具

- [ ] **Step 1: 寫失敗測試（process-tools.test.ts）**

```ts
// packages/terminal/test/process-tools.test.ts
import { afterEach, describe, expect, it } from "vitest"
import { createProcessTools } from "../src/tool.ts"
import { createTerminalService, type TerminalService } from "../src/service.ts"

let svc: TerminalService
afterEach(() => { svc?.dispose() })

it("process_spawn returns id+pid and process_kill TERM terminates", async () => {
  svc = createTerminalService()
  const tools = createProcessTools({ service: svc })
  const spawnTool = tools.find((t) => t.name === "process_spawn")!
  const killTool = tools.find((t) => t.name === "process_kill")!
  const spawned = (await spawnTool.execute({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] }, {})) as { id: string; pid: number }
  expect(spawned.pid).toBeGreaterThan(0)
  const view = (await killTool.execute({ id: spawned.id, signal: "TERM" }, {})) as { status: string }
  expect(view.status).toBe("running") // signal 是 async：exit 尚未觀察到 = 仍 running
  const exited = await svc.waitExited(spawned.id)
  expect(exited.exitCode).not.toBe(0)
})

it("process_resize_pty resizes a spawned process's pty", async () => {
  svc = createTerminalService()
  const tools = createProcessTools({ service: svc })
  const resizeTool = tools.find((t) => t.name === "process_resize_pty")!
  const spawnTool = tools.find((t) => t.name === "process_spawn")!
  const { id } = (await spawnTool.execute({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] }, {})) as { id: string }
  const out = await resizeTool.execute({ id, cols: 120, rows: 50 }, {})
  expect(out).toMatchObject({ id, cols: 120, rows: 50 })
})
```

（流程：工具直取 service（非 registerTerminal），`afterEach` 統一 dispose 清理。）

- [ ] **Step 2: 跑確認失敗**

Run: `pnpm --filter @i-harness/terminal test test/process-tools.test.ts`
Expected: FAIL——`createProcessTools` 不存在。

- [ ] **Step 3: 實作三工具**

```ts
// packages/terminal/src/tool.ts（追加）
export function createProcessTools(deps: TerminalToolDeps): Tool[] {
  const { service } = deps
  return [
    {
      name: "process_spawn",
      description:
        "Spawn a pty-backed process handle and return its id (use terminal_read/terminal_send to exchange I/O; process_kill to terminate).",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, env: { type: "object" } },
        required: ["command"],
      },
      execute: async (args: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }, exec: ToolExec) =>
        service.open(
          { command: args.command, ...(args.args !== undefined ? { args: args.args } : {}), ...(args.cwd !== undefined ? { cwd: args.cwd } : {}), ...(args.env !== undefined ? { env: args.env } : {}) },
          { sessionId: exec.sessionId },
        ),
    },
    {
      name: "process_kill",
      description: "Terminate a process handle (signal: TERM terminates, KILL forces; INT sends Ctrl+C).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, signal: { type: "string", enum: ["INT", "TERM", "KILL"] } },
        required: ["id"],
      },
      execute: async (args: { id: string; signal?: TerminalSignalName }, exec: ToolExec) =>
        service.signal(args.id, args.signal ?? "TERM", { sessionId: exec.sessionId }),
    },
    {
      name: "process_resize_pty",
      description: "Resize a process's PTY (cols/rows). No-op for non-interactive output.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, cols: { type: "number" }, rows: { type: "number" } }, required: ["id", "cols", "rows"] },
      execute: async (args: { id: string; cols: number; rows: number }, exec: ToolExec) =>
        service.resize(args.id, args.cols, args.rows, { sessionId: exec.sessionId }),
    },
  ]
}

// registerTerminal 改：
for (const tool of [...createTerminalTools({ service }), ...createProcessTools({ service })]) tools.register(tool)
```

- [ ] **Step 4: 跑測試 + 提交**

Run: `pnpm --filter @i-harness/terminal test && pnpm --filter @i-harness/terminal typecheck`
Expected: 全綠。`index.ts` export `createTerminalTools`/`createProcessTools`/`registerTerminal`/`TerminalService`/`createTerminalService`/`TerminalView`/`TerminalReadResult`/`TerminalSignalName`。

```bash
git add packages/terminal
git commit -m "M26-B8: process control surface — process_spawn/kill/resize_pty

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: B3 web 存取（webfetch + websearch provider seam）

**Files:**
- Modify: `packages/provider/{package.json,src/index.ts}`；Create: `packages/provider/test/websearch-seam.test.ts`
- Create: `packages/web/{package.json,tsconfig.json,src/index.ts,src/extract.ts}`
- Create: `packages/web/test/web.test.ts`
- Modify: `apps/cli/src/run.ts`（registerWeb）

**Interfaces:**
- Consumes: `@i-harness/core-tools` `Tool`、`@i-harness/core-plugin` `PluginContext.services`、`@i-harness/provider`（websearch seam）、`@i-harness/output-retention` `createTextRetainer`
- Produces:
  - `WebSearchResultItem { title; url; snippet? }`、`WebSearchQuery { query; maxResults? }`、`WebSearchProvider { search(q: WebSearchQuery): Promise<WebSearchResultItem[]> }`
  - `registerWebSearchProvider(ctx, provider): void`、`getWebSearchProvider(ctx): WebSearchProvider`（無 → throw `"no websearch provider is registered (NO_PROVIDER)"`）
  - `createWebTools(deps: { ctx: PluginContext; fetchImpl?: typeof fetch }): Tool[]`、`registerWeb(ctx, tools): void`
  - 工具：`webfetch`（http/https 限定、30s timeout、128K 內文抽取下限）、`websearch`

- [ ] **Step 1: 寫 provider seam 失敗測試（provider/test/websearch-seam.test.ts）**

```ts
// packages/provider/test/websearch-seam.test.ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { getWebSearchProvider, registerWebSearchProvider } from "../src/index.ts"

it("register/get roundtrip", () => {
  const ctx = createContext()
  const provider = { search: async () => [{ title: "t", url: "https://x" }] }
  registerWebSearchProvider(ctx, provider)
  expect(getWebSearchProvider(ctx)).toBe(provider)
})

it("fails closed when no provider registered", () => {
  const ctx = createContext()
  expect(() => getWebSearchProvider(ctx)).toThrow(/NO_PROVIDER/)
})
```

- [ ] **Step 2: 跑確認失敗**

Run: `pnpm --filter @i-harness/provider test test/websearch-seam.test.ts`
Expected: FAIL——`registerWebSearchProvider`/`getWebSearchProvider` 不存在。

- [ ] **Step 3: 實作 seam（packages/provider/src/index.ts + package.json 加 core-plugin）**

```ts
// packages/provider/src/index.ts（追加；package.json dependencies 加 "@i-harness/core-plugin": "workspace:*"）
import type { PluginContext } from "@i-harness/core-plugin"

export interface WebSearchResultItem {
  title: string
  url: string
  snippet?: string
}
export interface WebSearchQuery {
  query: string
  maxResults?: number
}
export interface WebSearchProvider {
  search(q: WebSearchQuery): Promise<WebSearchResultItem[]>
}

/** M26-B3：websearch provider seam（同 interaction/questions 模式）。請求有界、實作可插拔。 */
export function registerWebSearchProvider(ctx: PluginContext, provider: WebSearchProvider): void {
  ctx.services.register("websearch/provider", provider)
}

// fail-closed：無 provider → 同步 throw（NO_PROVIDER），呼叫端（web 工具）不需 await 就看到。
export function getWebSearchProvider(ctx: PluginContext): WebSearchProvider {
  try {
    return ctx.services.get<WebSearchProvider>("websearch/provider")
  } catch {
    throw new Error("no websearch provider is registered (NO_PROVIDER)")
  }
}
```

- [ ] **Step 4: 跑 provider 測試 + 建 packages/web 骨架**

Run: `pnpm --filter @i-harness/provider test` → PASS。

```jsonc
// packages/web/package.json
{
  "name": "@i-harness/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-plugin": "workspace:*",
    "@i-harness/core-tools": "workspace:*",
    "@i-harness/provider": "workspace:*",
    "@i-harness/output-retention": "workspace:*"
  }
}
```

- [ ] **Step 5: 寫 webfetch 失敗測試（web.test.ts——本地 node:http fixture）**

```ts
// packages/web/test/web.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createWebTools } from "../src/index.ts"

// 本地 fixture 伺服器：/html 回含 script/style/entity 的頁，/text 回 plain，/big 回 200K，
// /404 回 404，/redirect 302 → /html。
import { createServer } from "node:http"
async function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/html") {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(`<html><head><title>My Page</title><style>body{color:red}</style><script>let x=1;</script></head><body><p>Hello &amp; <b>world</b></p></body></html>`)
    } else if (url.pathname === "/text") {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("plain text body")
    } else if (url.pathname === "/big") {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(`<html><body>${"a".repeat(200_000)}</body></html>`)
    } else if (url.pathname === "/redirect") { res.writeHead(302, { location: "/html" }); res.end() }
    else { res.writeHead(404); res.end("no") }
  })
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as import("node:net").AddressInfo).port)))
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) }
}

let srv: { port: number; close: () => Promise<void> }
beforeEach(async () => { srv = await startServer() })
afterEach(async () => { await srv.close() })

it("webfetch extracts text: title + stripped markup + entities decoded", async () => {
  const tools = createWebTools({ ctx: createContext() })
  const t = tools.find((x) => x.name === "webfetch")!
  const out = (await t.execute({ url: `http://127.0.0.1:${srv.port}/html` }, {})) as { url: string; title: string; text: string }
  expect(out.title).toBe("My Page")
  expect(out.text).toContain("Hello & world")
  expect(out.text).not.toContain("<b>")
  expect(out.text).not.toContain("style")
})

it("webfetch: plain text passthrough; truncates oversized bodies with a marker", async () => {
  const tools = createWebTools({ ctx: createContext() })
  const t = tools.find((x) => x.name === "webfetch")!
  const plain = (await t.execute({ url: `http://127.0.0.1:${srv.port}/text` }, {})) as { text: string }
  expect(plain.text.trim()).toBe("plain text body")
  const big = (await t.execute({ url: `http://127.0.0.1:${srv.port}/big`, maxChars: 1000 }, {})) as { text: string; truncated: boolean }
  expect(big.truncated).toBe(true)
  expect(big.text.length).toBeLessThan(2000)
})

it("webfetch follows redirects and fails closed on non-http(s) protocol and HTTP errors", async () => {
  const tools = createWebTools({ ctx: createContext() })
  const t = tools.find((x) => x.name === "webfetch")!
  const redir = (await t.execute({ url: `http://127.0.0.1:${srv.port}/redirect` }, {})) as { title: string }
  expect(redir.title).toBe("My Page")
  await expect(t.execute({ url: "file:///etc/passwd" }, {})).rejects.toThrow(/WEB_UNSUPPORTED_PROTOCOL/)
  await expect(t.execute({ url: `http://127.0.0.1:${srv.port}/404` }, {})).rejects.toThrow(/WEB_FETCH_FAILED.*404/)
})

it("websearch fails closed without a provider", async () => {
  const tools = createWebTools({ ctx: createContext() })
  const t = tools.find((x) => x.name === "websearch")!
  await expect(t.execute({ query: "x" }, {})).rejects.toThrow(/NO_PROVIDER/)
})
```

- [ ] **Step 6: 跑確認失敗**

Run: `pnpm --filter @i-harness/web test test/web.test.ts`
Expected: FAIL——`createWebTools` 不存在。

- [ ] **Step 7: 實作 extract.ts + index.ts**

```ts
// packages/web/src/extract.ts
import { createTextRetainer } from "@i-harness/output-retention"

export const DEFAULT_MAX_CHARS = 128_000
export const DEFAULT_FETCH_MAX_BYTES = 512_000

// 只做 html/plain；不支援 text/html 以外大類的 file 型態（text 原樣）。
export function extractText(body: string, contentType: string | null): string {
  const isHtml = (contentType ?? "").toLowerCase().startsWith("text/html")
  if (!isHtml) return body
  return body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => { try { return String.fromCodePoint(parseInt(hex, 16)) } catch { return " " } })
    .replace(/&#(\d+);/g, (_, dec: string) => { try { return String.fromCodePoint(parseInt(dec, 10)) } catch { return " " } })
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function extractTitle(html: string): string | undefined {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)
  return m ? m[1]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : undefined
}

/** 串流讀 body，超過 maxBytes 就 destroy 連線（有界記憶體）。 */
export async function readBodyLimited(res: Response, maxBytes: number): Promise<{ text: string; truncatedAt: number | null }> {
  if (!res.body) return { text: await res.text(), truncatedAt: null }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      const joined = Buffer.concat(chunks).toString("utf-8")
      // 加上明確截斷標記：回傳已收部分（等於找到位置前內容）
      return { text: joined, truncatedAt: total }
    }
  }
  return { text: Buffer.concat(chunks).toString("utf-8"), truncatedAt: null }
}

export function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const r = createTextRetainer({ maxBytes: maxChars, mode: "headTail" })
  r.push(text)
  return { text: r.finish().text, truncated: r.finish().truncated }
}
```

```ts
// packages/web/src/index.ts
import type { PluginContext } from "@i-harness/core-plugin"
import type { Tool } from "@i-harness/core-tools"
import { getWebSearchProvider } from "@i-harness/provider"
import { capText, DEFAULT_MAX_CHARS, DEFAULT_FETCH_MAX_BYTES, extractText, extractTitle, readBodyLimited } from "./extract.ts"

export interface WebToolDeps { ctx: PluginContext; fetchImpl?: typeof fetch }

export function createWebTools(deps: WebToolDeps): Tool[] {
  const fetchImpl = deps.fetchImpl ?? fetch
  return [
    {
      name: "webfetch",
      description:
        "Fetch a web page and return its extracted text (HTML tags stripped, title detected). http/https only; bounded to maxChars (default 128000, head-tail) — huge pages are truncated with a marker.",
      inputSchema: { type: "object", properties: { url: { type: "string" }, maxChars: { type: "number" } }, required: ["url"] },
      timeoutMs: 30_000,
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async (args: { url: string; maxChars?: number }, exec) => {
        let u: URL
        try { u = new URL(args.url) } catch { throw new Error(`WEB_UNSUPPORTED_PROTOCOL: "${args.url}" cannot be parsed as an absolute URL`) }
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          throw new Error(`WEB_UNSUPPORTED_PROTOCOL: only http/https are allowed (got "${u.protocol}")`)
        }
        let res: Response
        try {
          res = await fetchImpl(u, { redirect: "follow", signal: exec.abortSignal, headers: { "user-agent": "i-harness/0.1" } })
        } catch (err) {
          throw new Error(`WEB_FETCH_FAILED: ${err instanceof Error ? err.message : String(err)}`)
        }
        if (!res.ok) throw new Error(`WEB_FETCH_FAILED: HTTP ${res.status} ${res.statusText}`)
        const { text: body, truncatedAt } = await readBodyLimited(res, DEFAULT_FETCH_MAX_BYTES)
        const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS
        const title = extractTitle(body)
        const cap = capText(extractText(body, res.headers.get("content-type")), maxChars)
        return {
          url: u.href,
          ...(title !== undefined ? { title } : {}),
          text: cap.text,
          ...(cap.truncated ? { truncated: true, note: "output truncated (head-tail); see the original URL or search for more" } : {}),
          ...(truncatedAt !== null ? { bodyTruncated: true } : {}),
        }
      },
    },
    {
      name: "websearch",
      description:
        "Search the web through the configured search provider (results are title/url/snippet items). Fails closed when no provider is registered.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "number", maximum: 20 } }, required: ["query"] },
      timeoutMs: 30_000,
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async (args: { query: string; maxResults?: number }) => {
        const provider = getWebSearchProvider(deps.ctx) // 無 provider → NO_PROVIDER throw
        const results = await provider.search({ query: args.query, ...(args.maxResults !== undefined ? { maxResults: args.maxResults } : {}) })
        return { query: args.query, results }
      },
    },
  ]
}

export function registerWeb(ctx: PluginContext, tools: { register(t: Tool): void }): void {
  for (const tool of createWebTools({ ctx })) tools.register(tool)
}
```

- [ ] **Step 8: 跑測試 + run.ts 接線 + index exports + 提交**

Run: `pnpm --filter @i-harness/web test && pnpm --filter @i-harness/web typecheck`
Expected: 全綠。

```ts
// apps/cli/src/run.ts
import { registerWeb } from "@i-harness/web"
// registerShell 之後一行：
registerWeb(ctx, tools)
// （websearch 無 provider 時 fail-closed——headless CLI 預設 NO_PROVIDER，宿主可 registerWebSearchProvider 注入。）
```

```bash
git add packages/provider packages/web apps/cli/src/run.ts pnpm-lock.yaml
git commit -m "M26-B3: web access — webfetch (extraction + bounds) + pluggable websearch provider

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: B5 LSP 擴充（documentSymbol/workspaceSymbol/callHierarchy/incoming+outgoingCalls）

**Files:**
- Modify: `packages/lsp/src/{instance.ts,tools.ts,render.ts,translate.ts,index.ts}`
- Modify: `packages/lsp/test/{fake-server.ts,instance.test.ts,tools.test.ts,render.test.ts}`

**Interfaces:**
- Consumes: `LspInstance` 既有 queue/abilities、`LspToolConfig`、render 既有 `formatLocations` 慣例（workspace-relative、1-based）
- Produces:
  - `LspOperation` 擴充：`"goToDefinition" | "findReferences" | "hover" | "documentSymbol" | "workspaceSymbol" | "callHierarchy" | "incomingCalls" | "outgoingCalls"`
  - `LspQuery` 變為 union（position 類 op 三欄、documentSymbol 只要 filePath、workspaceSymbol 只要 query、callHierarchy 要 position、incoming/outgoing 只要 item）
  - `LspSymbol { name; kind; detail?; uri; range }`（flattened）、`LspCallHierarchyItem`、`LspCallHierarchyCall { item; fromRanges }`
  - `normalizeSymbols`/`normalizeCallHierarchy`（translate.ts）、`formatSymbols`/`formatCallHierarchy`（render.ts）

- [ ] **Step 1: 寫失敗測試（instance.test.ts 追加——沿用既有 scripted createFakeLspServer 慣例，fake-server.ts 零改動）**

```ts
// packages/lsp/test/instance.test.ts（追加——既有 CAPS/spec/paramsOf/waitFor 助手直接重用）
// 既有實作 pushMessage 一次一只 request——scripted entry 是靜態 response 或 fn(params)。
const DOC_SYMBOLS = [
  { name: "main", kind: 12, // Function
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
    selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
    children: [{ name: "inner", kind: 13,
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
      selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } } }] },
]
const CALL_ITEM = { name: "callee", kind: 12, uri: FILE_A_TS,
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
  selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } }
const CALLS = {
  items: [{ item: { name: "caller", kind: 12, uri: FILE_A_TS,
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
    selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } } },
    fromRanges: [{ start: { line: 1, character: 2 }, end: { line: 1, character: 7 } }] }],
}

it("documentSymbol: sends textDocument/documentSymbol and flattens children depth-first", async () => {
  const server = createFakeLspServer({
    initialize: { capabilities: { ...CAPS, documentSymbolProvider: true } },
    "textDocument/documentSymbol": DOC_SYMBOLS,
  })
  const inst = new LspInstance(spec(), server.spawner)
  await inst.ready
  const res = await inst.query({ operation: "documentSymbol", filePath: "/w/a.ts" }, "x")
  expect(res.kind).toBe("symbols")
  expect((res as { symbols: LspSymbol[] }).symbols.map((s) => s.name)).toEqual(["main", "inner"])
  expect(server.server.methods).toContain("textDocument/documentSymbol")
})

it("workspaceSymbol: sends workspace/symbol with the query string", async () => {
  const server = createFakeLspServer({
    initialize: { capabilities: { ...CAPS, workspaceSymbolProvider: true } },
    "workspace/symbol": [{ name: "util", kind: 7, location: { uri: FILE_A_TS, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } } }],
  })
  const inst = new LspInstance(spec(), server.spawner)
  await inst.ready
  const res = await inst.query({ operation: "workspaceSymbol", query: "util" }, "")
  expect((res as { symbols: LspSymbol[] }).symbols).toHaveLength(1)
  expect((server.server.requests.find((r) => methodOf(r) === "workspace/symbol")?.params as { query: string }).query).toBe("util")
})

it("callHierarchy prepare + incoming/outgoingCalls roundtrip the item", async () => {
  const server = createFakeLspServer({
    initialize: { capabilities: { ...CAPS, prepareCallHierarchyProvider: true, callHierarchyProvider: true } },
    "textDocument/prepareCallHierarchy": [CALL_ITEM],
    "callHierarchy/incomingCalls": CALLS,
    "callHierarchy/outgoingCalls": CALLS,
  })
  const inst = new LspInstance(spec(), server.spawner)
  await inst.ready
  const prep = await inst.query({ operation: "callHierarchy", filePath: "/w/a.ts", line: 1, character: 1 }, "x")
  expect(prep.kind).toBe("callHierarchy")
  const item = (prep as { items: LspCallHierarchyItem[] }).items[0]!
  const incoming = await inst.query({ operation: "incomingCalls", item }, "x")
  expect((incoming as { calls: LspCallHierarchyCall[] }).calls).toHaveLength(1)
  const outgoing = await inst.query({ operation: "outgoingCalls", item }, "x")
  expect((outgoing as { calls: LspCallHierarchyCall[] }).calls).toHaveLength(1)
})
```

（`LspSymbol`/`LspCallHierarchyItem`/`LspCallHierarchyCall` 由 src/index.ts export——Step 3 後補齊；`server.server.requests` 是 FakeLspServerLog 既有欄位。capability 未宣告 → LSP_UNSUPPORTED_OPERATION 用既有 `"textDocument/hover"` 能力門樣式另測一支：`documentSymbolProvider: false` → query documentSymbol rejects。）

- [ ] **Step 2: 跑確認失敗**

Run: `pnpm --filter @i-harness/lsp test test/instance.test.ts`
Expected: FAIL——LspOperation 無新值、查詢結果 shape 對不上。

- [ ] **Step 3: 實作 instance.ts（op 分派 + 能力門）**

```ts
// packages/lsp/src/instance.ts（提取修改處）
export type LspOperation =
  | "goToDefinition" | "findReferences" | "hover"
  | "documentSymbol" | "workspaceSymbol"
  | "callHierarchy" | "incomingCalls" | "outgoingCalls"

export type LspQuery =
  | { operation: "goToDefinition" | "findReferences" | "hover"; filePath: string; line: number; character: number }
  | { operation: "documentSymbol"; filePath: string }
  | { operation: "workspaceSymbol"; query: string }
  | { operation: "callHierarchy"; filePath: string; line: number; character: number }
  | { operation: "incomingCalls" | "outgoingCalls"; item: LspCallHierarchyItem }

export interface LspSymbol { name: string; kind: number; detail?: string; uri: string; range: LspRange }
export interface LspCallHierarchyItem {
  name: string; kind: number; detail?: string; uri: string; range: LspRange; selectionRange: LspRange; data?: unknown
}
export interface LspCallHierarchyCall { item: LspCallHierarchyItem; fromRanges: LspRange[] }

export type LspQueryResult =
  | { kind: "locations"; locations: LspLocation[] }
  | { kind: "empty" }
  | { kind: "hover"; hover: LspHover | null }
  | { kind: "symbols"; symbols: LspSymbol[] }
  | { kind: "callHierarchy"; items: LspCallHierarchyItem[] }
  | { kind: "calls"; calls: LspCallHierarchyCall[]; direction: "incoming" | "outgoing"; target: LspCallHierarchyItem }

const OP_TO_METHOD: Record<LspOperation, string> = {
  goToDefinition: "textDocument/definition",
  findReferences: "textDocument/references",
  hover: "textDocument/hover",
  documentSymbol: "textDocument/documentSymbol",
  workspaceSymbol: "workspace/symbol",
  callHierarchy: "textDocument/prepareCallHierarchy",
  incomingCalls: "callHierarchy/incomingCalls",
  outgoingCalls: "callHierarchy/outgoingCalls",
}
const OP_TO_CAPABILITY: Record<LspOperation, string> = {
  goToDefinition: "definitionProvider", findReferences: "referencesProvider", hover: "hoverProvider",
  documentSymbol: "documentSymbolProvider", workspaceSymbol: "workspaceSymbolProvider",
  callHierarchy: "prepareCallHierarchyProvider", incomingCalls: "callHierarchyProvider", outgoingCalls: "callHierarchyProvider",
}
export { isPos } // additive：translate.ts 要用的既有 helper（原 local，改 export）

// doQuery 分派（既有 doQuery 改 switch——讀檔後有兩類動作）：
//   A) textDocument 類（documentSymbol/callHierarchy 與既有三 op）→ withOpenDocument 內 request
//      （documentSymbol 不需要 position；callHierarchy 需要 position）
//   B) 無文檔類（workspaceSymbol/incomingCalls/outgoingCalls）→ 直接 conn.request（不 didOpen）
// 結果歸一（fail-closed 結構檢查，translate.ts）：
//   documentSymbol → normalizeSymbols → { kind: "symbols", symbols }（空陣列→ { kind: "symbols", symbols: [] }，render 映 "No symbols."）
//   workspaceSymbol → 同上
//   callHierarchy → normalizeCallHierarchyItems → { kind: "callHierarchy", items }
//   incoming/outgoing → normalizeCallHierarchyCalls →
//     { kind: "calls", calls, direction, target: <prepare 那次 query item——由呼叫端併入> }
// wire params：
//   documentSymbol: { textDocument: { uri } }
//   workspaceSymbol: { query }
//   callHierarchy: { textDocument: { uri }, position: { line: line-1, character: character-1 } }
//   incomingCalls/outgoingCalls: { item }（raw item 原樣過 wire——data 欄位原樣隨行）
```

- [ ] **Step 4: 實作 translate.ts（normalizers）+ render.ts（formatters）**

```ts
// packages/lsp/src/translate.ts（追加——沿用既有 normalizeLocations 的「欄位卡死即丟」形狀）
import type {
  LspCallHierarchyCall, LspCallHierarchyItem, LspLocation, LspRange, LspSymbol,
} from "./instance.ts"

function locOf(raw: unknown): LspLocation | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.uri !== "string") return undefined
  const range = o.range as Record<string, unknown> | undefined
  if (typeof range !== "object" || range === null || !isPos(range.start) || !isPos(range.end)) return undefined
  return { uri: o.uri, range: range as unknown as LspRange }
}

/**
 * textDocument/documentSymbol：DocumentSymbol[]（階層）或 SymbolInformation[]（扁平）混收，
 * 階層性 children 深度優先平鋪（LSP 慣例：SymbolInformation 無 children）。
 * fail-closed：缺 name/kind 或不可解析位置的 entry 丟棄；payload 非陣列 → []。
 */
export function normalizeSymbols(payload: unknown): LspSymbol[] {
  if (!Array.isArray(payload)) return []
  const out: LspSymbol[] = []
  const walk = (items: unknown[]): void => {
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue
      const d = item as Record<string, unknown>
      if (typeof d.name !== "string" || typeof d.kind !== "number") continue
      const location = locOf(d) // SymbolInformation 帶 location
      if (!location) {
        // DocumentSymbol：selectionRange 直接上位
        if (!isPos((d.selectionRange as Record<string, unknown>)?.start) || typeof (d as { uri?: unknown }).uri !== "string") continue
      }
      const loc: LspLocation =
        location ?? { uri: d.uri as string, range: d.selectionRange as LspRange }
      out.push({
        name: d.name, kind: d.kind, uri: loc.uri, range: loc.range,
        ...(typeof d.detail === "string" ? { detail: d.detail } : {}),
      })
      if (Array.isArray(d.children)) walk(d.children)
    }
  }
  walk(payload)
  return out
}

const itemOf = (raw: unknown): LspCallHierarchyItem | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const d = raw as Record<string, unknown>
  if (typeof d.name !== "string" || typeof d.kind !== "number" || typeof d.uri !== "string") return undefined
  if (!isPos((d.selectionRange as Record<string, unknown>)?.start)) return undefined
  return {
    name: d.name, kind: d.kind, uri: d.uri,
    range: d.range as LspRange, selectionRange: d.selectionRange as LspRange,
    ...(typeof d.detail === "string" ? { detail: d.detail } : {}),
    ...(d.data !== undefined ? { data: d.data } : {}),
  }
}

/** textDocument/prepareCallHierarchy → items；空/畸形 → []（fail-closed）。 */
export function normalizeCallHierarchyItems(payload: unknown): LspCallHierarchyItem[] {
  if (!Array.isArray(payload)) return []
  return payload.map(itemOf).filter((i): i is LspCallHierarchyItem => i !== undefined)
}

/** callHierarchy/incomingCalls |outgoingCalls 的 wire 是 { items?: array }。 */
export function normalizeCallHierarchyCalls(payload: unknown): LspCallHierarchyCall[] {
  if (typeof payload !== "object" || payload === null) return []
  const items = (payload as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  const out: LspCallHierarchyCall[] = []
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) continue
    const e = entry as Record<string, unknown>
    const item = itemOf(e.item)
    if (!item) continue
    const fromRanges = Array.isArray(e.fromRanges)
      ? (e.fromRanges as unknown[]).filter((r) => isPos((r as Record<string, unknown>)?.start) && isPos((r as Record<string, unknown>)?.end)).map((r) => r as LspRange)
      : []
    out.push({ item, fromRanges })
  }
  return out
}
```

```ts
// packages/lsp/src/render.ts（追加——沿用 formatLocations 的 workspace-relative 慣例）
import { relative } from "node:path"
import type { LspCallHierarchyCall, LspCallHierarchyItem, LspSymbol } from "./instance.ts"

/** 一列一位符號："name [kind] file:line:ch — detail"（kind 是 LSP SymbolKind 整數）。 */
export function formatSymbols(symbols: LspSymbol[], opts: RenderOptions): string {
  return symbols.map((s) => {
    const loc = formatLocations([{ uri: s.uri, range: s.range }], opts)
    const detail = s.detail !== undefined ? ` — ${s.detail}` : ""
    return `${s.name} [${s.kind}] ${loc}${detail}`
  }).join("\n")
}

/** prepareCallHierarchy：一列一位項目。 */
export function formatCallHierarchyItem(item: LspCallHierarchyItem, opts: RenderOptions): string {
  return `${item.name} [${item.kind}] ${formatLocations([{ uri: item.uri, range: item.selectionRange }], opts)}`
}

/** incoming/outgoing 呼叫對。target 是備查的那個函式；calls 是呼叫方/被呼叫方，
 *  fromRanges 是呼叫點。direction 決定箭頭方向與語意標籤。 */
export function formatCallHierarchyCalls(
  calls: LspCallHierarchyCall[],
  target: LspCallHierarchyItem,
  direction: "incoming" | "outgoing",
  opts: RenderOptions,
): string {
  if (calls.length === 0) return "No calls."
  return calls.map((c) => {
    const site = c.fromRanges[0]
    const siteDesc = site !== undefined ? formatLocations([{ uri: c.item.uri, range: site }], opts) : "?"
    return direction === "incoming"
      ? `${c.item.name} calls ${target.name} at ${siteDesc}`
      : `${target.name} calls ${c.item.name} at ${siteDesc}`
  }).join("\n")
}
```

（isPos 是 instance.ts 既有 helper（export 或同模組複用）——translate.ts 已 import `isPos`？instance.ts 的 isPos 未 export——translate.ts 自家宣告一份同形件（10 行）或 instance.ts export 它：選後者（既有 normalizeDiagnostics 也在 instance.ts 自家用，export isPos 是 additive）。）

- [ ] **Step 5: 實作 tools.ts 操作枚舉擴充**

```ts
// packages/lsp/src/tools.ts（lsp 工具 inputSchema 與 execute 改）
const OPERATIONS = [
  "goToDefinition", "findReferences", "hover", "documentSymbol", "workspaceSymbol", "callHierarchy", "incomingCalls", "outgoingCalls",
] as const
// inputSchema.properties：
//   operation: { type: "string", enum: [...OPERATIONS] }
//   file_path, line, character（如舊）；query: { type: "string" }; item: {}（JSON 物件）
// execute 分派（各 op 的必需參數缺 → 錯誤訊息指明）：
//   documentSymbol → 需 file_path
//   workspaceSymbol → 需 query
//   callHierarchy → 需 file_path+line+character
//   incomingCalls/outgoingCalls → 需 item（JSON 物件：prepare 結果的整枚 item 原樣回傳）
// 回傳（工具層決定）：
//   documentSymbol/workspaceSymbol → formatSymbols(...) 文字（空 → "No symbols."）
//   callHierarchy → { items }（結構化：模型拿著 item 繼續 incoming/outgoing）
//   incomingCalls/outgoingCalls → { direction, target: { name, uri }, calls: [{ from, to, site }] } 結構化
//     單個 site 用 formatLocations 的 "file:line:ch" 字串表示（模型不必回填來回 JSON）
// 一個示例（calls op 實作形狀）：
//   const src = ...; const result = await instance.query({ operation: args.operation, item }, src, exec.abortSignal)
//   if (result.kind !== "calls") return { direction, target: null, calls: [] }
//   return {
//     direction, target: { name: result.target.name, uri: result.target.uri },
//     calls: result.calls.map((c) => ({
//       from: { name: c.item.name, uri: c.item.uri },
//       at: c.fromRanges[0] !== undefined ? formatLocations([{ uri: c.item.uri, range: c.fromRanges[0] }], { workspaceRoot }) : "?",
//     })),
//   }
```

- [ ] **Step 6: 跑 lsp 全包測試 + 提交**

Run: `pnpm --filter @i-harness/lsp test && pnpm --filter @i-harness/lsp typecheck`
Expected: 全綠——既有四 op 測試不受影響（union 加寬、舊 query 形狀保留）。

```bash
git add packages/lsp
git commit -m "M26-B5: lsp expansion — documentSymbol/workspaceSymbol/callHierarchy + incoming/outgoingCalls

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: B7 registry 級統一 output spill（上限 + 統一落盤 + GC + outputPaths）

**Files:**
- Modify: `packages/output-retention/{package.json,src/index.ts}`；Create: `packages/output-retention/src/spill-guard.ts`
- Create: `packages/output-retention/test/spill-guard.test.ts`
- Modify: `apps/cli/src/run.ts`（`opts.outputSpill` + `ctx.mount(createOutputSpillGuard(...))`——「有設就掛」）

**Interfaces:**
- Consumes: `ctx.onCascade("tools/execute")`（guard-timeout 先例——`dispatch` 是 `{ name, args, exec, tool }`、`next()` 回 raw output）、`createSpillStore`、`spillNotice`、`createTextRetainer`
- Produces:
  - `OutputSpillGuardConfig { maxOutputBytes?: number（64_000）; spillRoot?: string; gc?: { maxAgeMs?: number（86_400_000）; maxTotalBytes?: number（512MiB） } }`
  - `createOutputSpillGuard(ctx, config?): Plugin`；`gcSpillStore(root, opts): Promise<{ removedFiles; removedBytes }>`；`createUnifiedSpillStore(root?): SpillStore`

- [ ] **Step 1: 寫失敗測試（spill-guard.test.ts）**

```ts
// packages/output-retention/test/spill-guard.test.ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createOutputSpillGuard, gcSpillStore } from "../src/spill-guard.ts"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const mkdir = () => mkdtempSync(join(tmpdir(), "m26-spill-"))

it("string output over the budget is truncated head-tail + notice with the spill path", async () => {
  const root = mkdir()
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  registry.register({
    name: "big", description: "", inputSchema: {},
    execute: async () => "A".repeat(10_000),
  } as Tool)
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 100, spillRoot: root }))
  const result = await registry.execute({ name: "big", args: {} })
  const out = result.output as string
  expect(out.length).toBeLessThan(500)
  expect(out).toContain("Full result stored at:")
  expect(out).toContain("A") // retained tail
  const path = /Full result stored at: (.+?)\. Use read/.exec(out)![1]
  expect(readFileSync(path, "utf-8")).toBe("A".repeat(10_000))
  rmSync(root, { recursive: true, force: true })
})

it("under-budget string outputs pass through untouched", async () => {
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  registry.register({ name: "small", description: "", inputSchema: {}, execute: async () => "ok" } as Tool)
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 100, spillRoot: mkdir() }))
  const result = await registry.execute({ name: "small", args: {} })
  expect(result.output).toBe("ok")
})

it("object output over budget becomes { output, outputPaths, spill } envelope", async () => {
  const root = mkdir()
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  registry.register({ name: "obj", description: "", inputSchema: {}, execute: async () => ({ blob: "B".repeat(5000) }) } as Tool)
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 100, spillRoot: root }))
  const result = await registry.execute({ name: "obj", args: {} })
  const out = result.output as { output: string; outputPaths: string[]; spill: { omittedBytes: number } }
  expect(Array.isArray(out.outputPaths)).toBe(true)
  expect(out.outputPaths![0]).toContain(root)
  expect(readFileSync(out.outputPaths![0], "utf-8")).toContain('"B"')
  expect(out.spill.omittedBytes).toBeGreaterThan(4000)
})

it("gcSpillStore removes files older than maxAgeMs and trims to maxTotalBytes", async () => {
  const root = mkdir()
  for (let i = 0; i < 5; i++) {
    const p = join(root, `f${i}.log`)
    writeFileSync(p, "x".repeat(100))
    utimesSync(p, new Date(Date.now() - 10_000_000), new Date(Date.now() - 10_000_000)) // 老 2×maxAgeMs
  }
  const old = await gcSpillStore(root, { maxAgeMs: 1_000_000, maxTotalBytes: 1_000_000 })
  expect(old.removedFiles).toBe(5)
  // 新鮮檔案 + 總量修剪（最舊先刪）
  for (let i = 0; i < 5; i++) {
    const p = join(root, `fresh${i}.log`)
    writeFileSync(p, "y".repeat(100))
    utimesSync(p, new Date(Date.now() - i * 1000), new Date(Date.now() - i * 1000))
  }
  const trimmed = await gcSpillStore(root, { maxAgeMs: 60_000, maxTotalBytes: 150 })
  expect(trimmed.removedFiles).toBe(4) // 剩 1 個
  rmSync(root, { recursive: true, force: true })
})
```

- [ ] **Step 2: 跑確認失敗**

Run: `pnpm --filter @i-harness/output-retention test test/spill-guard.test.ts`
Expected: FAIL——模組不存在。

- [ ] **Step 3: 實作 spill-guard.ts**

```ts
// packages/output-retention/src/spill-guard.ts
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin, PluginContext } from "@i-harness/core-plugin"
import { createSpillStore, createTextRetainer, spillNotice, type SpillStore } from "./index.ts"

export interface OutputSpillGuardConfig {
  maxOutputBytes?: number   // 缺省 64_000
  spillRoot?: string        // 缺省 <tmpdir>/i-harness-spill（穩定目錄——GC 有意義）
  gc?: { maxAgeMs?: number; maxTotalBytes?: number } // 缺省 24h / 512MiB
}

const DEFAULT_MAX_OUTPUT_BYTES = 64_000
const DEFAULT_MAX_AGE_MS = 86_400_000
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024

/** registry 級統一落盤（opencode/dsh spill policy 吸收）。string 超限 → 截斷字串 + spill notice
 *  （notice 內含完整路徑）；object 超限 → { output, outputPaths, spill } 信封。**core-tools 零改動**
 *  ——core-tools 的 tools/execute cascade 縫（guard-timeout 先例）是唯一接入點。 */
export function createOutputSpillGuard(ctx: PluginContext, config?: OutputSpillGuardConfig): Plugin {
  const maxBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const root = config?.spillRoot ?? join(tmpdir(), "i-harness-spill")
  const store: SpillStore = createSpillStore({ root })
  // 掛載時跑一次 GC（best-effort；失敗只 warn——GC 是維生屋事，不阻擋掛載）
  const gcOpts = { maxAgeMs: config?.gc?.maxAgeMs ?? DEFAULT_MAX_AGE_MS, maxTotalBytes: config?.gc?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES }
  void gcSpillStore(root, gcOpts).catch((e) => console.warn("[i-harness] spill GC failed:", e))

  return {
    name: "output-spill",
    mount(ctx: PluginContext): void {
      ctx.onCascade("tools/execute", async (dispatch, next) => {
        const out = await next()
        if (out === undefined || out === null || typeof out === "number" || typeof out === "boolean") return out
        const d = dispatch as { name: string }
        if (typeof out === "string") {
          if (Buffer.byteLength(out, "utf-8") <= maxBytes) return out
          const r = createTextRetainer({ maxBytes, mode: "headTail" })
          r.push(out)
          const kept = r.finish()
          const path = await store.saveText(out, `${d.name}-output`)
          return kept.text + "\n" + spillNotice(kept.omittedBytes, path)
        }
        const json = JSON.stringify(out)
        if (Buffer.byteLength(json, "utf-8") <= maxBytes) return out
        const r = createTextRetainer({ maxBytes, mode: "headTail" })
        r.push(json)
        const kept = r.finish()
        const path = await store.saveText(json, `${d.name}-output`)
        return {
          output: kept.text + "\n" + spillNotice(kept.omittedBytes, path),
          outputPaths: [path],
          spill: { omittedBytes: kept.omittedBytes, label: d.name },
        }
      })
    },
  }
}

/** GC：刪 maxAgeMs 前的檔案（mtime），再按總量修剪——最舊先刪。回報刪除數/位元組。 */
export async function gcSpillStore(
  root: string,
  opts: { maxAgeMs: number; maxTotalBytes: number; now?: number },
): Promise<{ removedFiles: number; removedBytes: number }> {
  const { readdir, stat, unlink } = await import("node:fs/promises")
  const now = opts.now ?? Date.now()
  const entries: Array<{ path: string; mtime: number; size: number }> = []
  for (const name of await readdir(root)) {
    try {
      const st = await stat(join(root, name))
      if (st.isFile()) entries.push({ path: join(root, name), mtime: st.mtimeMs, size: st.size })
    } catch { /* 競態刪除中——跳過 */ }
  }
  let removedBytes = 0
  let removedFiles = 0
  const remaining: typeof entries = []
  for (const e of entries) {
    if (now - e.mtime > opts.maxAgeMs) { removedFiles++; removedBytes += e.size; await unlink(e.path).catch(() => {}) }
    else remaining.push(e)
  }
  remaining.sort((a, b) => a.mtime - b.mtime) // 最舊先
  let total = remaining.reduce((s, e) => s + e.size, 0)
  for (const e of remaining) {
    if (total <= opts.maxTotalBytes) break
    total -= e.size
    removedFiles++; removedBytes += e.size
    await unlink(e.path).catch(() => {})
  }
  return { removedFiles, removedBytes }
}

export function createUnifiedSpillStore(root?: string): SpillStore {
  return createSpillStore({ root: root ?? join(tmpdir(), "i-harness-spill") })
}
```

- [ ] **Step 4: index.ts exports + package.json 加 core-plugin + run.ts 接線 + 跑測試 + 提交**

```ts
// packages/output-retention/src/index.ts（追加）
export { createOutputSpillGuard, gcSpillStore, createUnifiedSpillStore } from "./spill-guard.ts"
export type { OutputSpillGuardConfig } from "./spill-guard.ts"
```

```ts
// apps/cli/src/run.ts（HeadlessOptions 加）
outputSpill?: import("@i-harness/output-retention").OutputSpillGuardConfig
// 掛載選位（run.ts line ~134 的註釋：cascade 按註冊順序，FIRST REGISTERED = OUTERMOST）——
// spill 要看到最大的未處理輸出，所以掛在 guards 之前（最外層，先於 createRetryGuard）：
if (opts.outputSpill) ctx.mount(createOutputSpillGuard(ctx, opts.outputSpill))
ctx.mount(createRetryGuard(ctx, opts.retry)) /* 既有 */
ctx.mount(createTimeoutGuard(ctx)) /* 既有 */
```

Run: `pnpm --filter @i-harness/output-retention test && pnpm --filter @i-harness/output-retention typecheck && pnpm --filter @i-harness/core-tools test`
Expected: 全綠（core-tools 零改動——既測證明未破）。

```bash
git add packages/output-retention apps/cli/src/run.ts
git commit -m "M26-B7: registry-wide output spill — unified store + GC + notice/outputPaths

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: B14 ask_user_input 工具化

**Files:**
- Modify: `packages/interaction/{package.json,src/index.ts}`（package.json 加 `@i-harness/core-tools`: `workspace:*`——index.ts 要 import Tool 型別）
- Create: `packages/interaction/test/ask-user-input.test.ts`
- Modify: `apps/cli/src/run.ts`（registerAskUserInput）

**Interfaces:**
- Consumes: `askUser(ctx, q)`（既有 questions/provider seam，`QuestionProvider.ask`）、`Tool`/`ToolExec`、M19 `ToolExec.sessionId`
- Produces: `createAskUserInputTool(deps?: { ask?: (q: UserQuestion) => Promise<string>; timeoutMs?: number }): Tool`、`registerAskUserInput(ctx, registry, opts?): void`

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/interaction/test/ask-user-input.test.ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { askUser, createAskUserInputTool, registerAskUserInput, registerQuestionProvider } from "../src/index.ts"

it("ask_user_input forwards the question to the provider and returns the answer", async () => {
  const ctx = createContext()
  registerQuestionProvider(ctx, { ask: async (q) => { expect(q.prompt).toBe("which approach?"); expect(q.options).toEqual(["a", "b"]); return "a" } })
  const tool = createAskUserInputTool({ ask: (q) => askUser(ctx, q) })
  expect(tool.name).toBe("ask_user_input")
  const out = await tool.execute({ question: "which approach?", options: ["a", "b"] }, {})
  expect(out).toEqual({ question: "which approach?", answer: "a" })
})

it("fails closed with NO_PROVIDER when no question provider is registered", async () => {
  const ctx = createContext()
  const tool = createAskUserInputTool({ ask: (q) => askUser(ctx, q) })
  await expect(tool.execute({ question: "x" }, {})).rejects.toThrow(/NO_PROVIDER/)
})

it("registerAskUserInput wires the ctx-based ask and registers the tool", () => {
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  registerAskUserInput(ctx, registry)
  expect(registry.get("ask_user_input")).toBeDefined()
  // provider 未註冊時執行失敗閉：從 registry 直取 execute
})
```

- [ ] **Step 2: 跑確認失敗**

Run: `pnpm --filter @i-harness/interaction test test/ask-user-input.test.ts`
Expected: FAIL——`createAskUserInputTool`/`registerAskUserInput` 不存在。

- [ ] **Step 3: 實作**

```ts
// packages/interaction/src/index.ts（追加）
import type { Tool } from "@i-harness/core-tools"

export interface AskUserInputToolDeps {
  /** 注入 seam（測試）；缺省 → ctx 版 askUser（無 provider 同步 NO_PROVIDER throw）。 */
  ask?: (q: UserQuestion) => Promise<string>
  /** 宣告給 guard-timeout 的 deadline；缺省 600_000（宿主題面 10 分未答 → TOOL_TIMEOUT 替換）。 */
  timeoutMs?: number
}

// B14：模型主動問使用者（codex request_user_input 吸收）。同 operator 只有一人——非並行安全。
// 回答不會進 session log 以外的新地方：答案作為 tool result 回傳（模型可看到）。
export function createAskUserInputTool(deps?: AskUserInputToolDeps): Tool {
  return {
    name: "ask_user_input",
    description:
      "Ask the human user a structured question and wait for their answer. Use this for decisions that need the user's preference (not for approvals — approvals use the approval flow).",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask (should be self-contained)." },
        options: { type: "array", items: { type: "string" }, maxItems: 10, description: "Suggested answers (the user may still answer freely)." },
      },
      required: ["question"],
    },
    timeoutMs: deps?.timeoutMs ?? 600_000,
    execute: async (args: { question: string; options?: string[] }) => {
      const ask = deps?.ask
      if (!ask) throw new Error("no user-questions provider is registered (NO_PROVIDER)") // 同步失敗 -> fail-closed
      const answer = await ask({
        id: `aiu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        prompt: args.question,
        ...(args.options !== undefined ? { options: args.options } : {}),
      })
      return { question: args.question, answer }
    },
  }
}

export function registerAskUserInput(ctx: PluginContext, registry: { register(t: Tool): void }): void {
  registry.register(createAskUserInputTool({ ask: (q) => askUser(ctx, q) }))
}
```

- [ ] **Step 4: run.ts 接線 + 跑測試 + 提交**

```ts
// apps/cli/src/run.ts（approveAll 區後）
import { registerAskUserInput } from "@i-harness/interaction"
// 在 registerShell 之後：
registerAskUserInput(ctx, tools)
// 注意：headless CLI 預設無 questions/provider → 工具存在但呼叫即 NO_PROVIDER（fail-closed）。
// 宿主（UI）用 registerQuestionProvider 注入（runHeadless 的 Host 通過 interaction 包直接註冊——或
// 之後的 HeadlessOptions 加 questionsProvider 傳入，本任務不加：保持 surface 最小）。
```

Run: `pnpm --filter @i-harness/interaction test && pnpm --filter @i-harness/interaction typecheck && pnpm --filter @i-harness/cli test`
Expected: 全綠。

```bash
git add packages/interaction apps/cli/src/run.ts
git commit -m "M26-B14: ask_user_input tool (question provider seam, fail-closed)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Final Verification

```bash
cd D:/I-harness-main
pnpm -r typecheck
pnpm -r test
```

Expected: all green (baseline + 9 new tasks). 若 CLI/子代理相關的全域測試受新工具註冊影響（tool_search/目錄容錯等），修到全綠再收尾——這幾個新工具註冊都是 additive，既有斷言不該碰到。

**Scope note（完成即止）**：R-B4（git undo——後補，待 UI 產品形狀）、R-B6（skills 增強——隨 R-E4 plugin-registry）、R-B9（fs watch——後補，消費方未定）、R-B10（執行策略深化——遠期）、R-B12（workflow worker-thread——後補）、R-B13（apply_patch AST——後補）、R-B11（PTC——不做）。本計畫範圍外，無任務。

---

## Self-Review

**1. Spec coverage**：R-B1（T1 OAuth PKCE+dyn-reg+callback+token store、T2 roots+資源模板、T3 blocked/direct）、R-B2（T4 node-pty 六工具）、R-B3（T6 webfetch + provider seam websearch）、R-B5（T7 五 op）、R-B7（T8 registry 級 spill + GC + outputPaths）、R-B8（T5 process 三工具 + background 表 terminal_list）、R-B14（T9 ask_user_input）——all mapped。R-B4/R-B6/R-B9/R-B10/R-B11/R-B12/R-B13 一行排除且無任務。

**2. Placeholder scan**：所有執行碼 block 均有完整實現（T1 的 mock OAuth 整合伺服器是測試資產；Step 10 明示「常見校正點」——若 SDK 1.30.0 的 discovery 走不同端點，改 fake 到對為止，SDK 行為為準；這不是 placeholder）。T7 Step 3 對 doQuery 只寫分派規則（wire params 精確列出）——與既有 doQuery 結構對齊，屬編輯指引而非骨架。無「TBD」、無「similar to」、無省略號碼（`…` 僅見於描述句，不裁切程式語法）。

**3. Type consistency**：`McpTokenStore`（get/put、null=absent）、`OAuthCallbackServer`（port()/redirectUrl()/waitForCallback(state,{timeoutMs})/stop()）、`TerminalService`（open/send/read/signal/close/resize/list/waitExited/dispose，owner 判定 sessionId===owner 且匿名否決）、`OutputSpillGuardConfig`、`WebSearchProvider`、`LspOperation`/`LspQuery` union（含 calls result 的 target/direction）、`ConnectedMcpClient.listResourceTemplates?(signal?)` 為 optional（onDisconnect 先例）——產生處與使用處一致；`createTransport(config, auth?)` 第二參數 optional 與既有呼叫相容；Task 4 的 RING_MAX/textSince、Task 5 的 process 工具參數在跨任務引用處一致。
