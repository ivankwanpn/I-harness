import { randomBytes, webcrypto } from "node:crypto"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
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

// M26-B1：provider saveCodeVerifier 存了 runtime 記憶體 + store 兩處；本介面把內部
// 狀態存取與「waitForCallback 等待的那個 state」對齊（SDK 在 oauthFlow 內自己呼叫
// state()——connectWithAuth 必須等同一枚，見下方 state() 註釋）。
export interface IHOAuthClientProvider extends OAuthClientProvider {
  /** 目前握在手上的 flow state（SDK/connectWithAuth 拿到的是同一枚）。 */
  currentState(): Promise<string | undefined>
}

/**
 * 官方 SDK OAuthClientProvider 的 IH 實作（吸收 opencode core/src/mcp/oauth-provider.ts 形狀）。
 * 狀態（state/verifier/tokens/client）全部走注入的 McpTokenStore——記憶體預設、coordinator
 * 文件持久化由 CLI 適配（fs-lock doc:<key> 紀律在 coordinator 層，見 run.ts）。
 * fail-closed：授權未完成前 redirectUrl/code 不存在 → 回調超時 → McpOAuthError。
 */
export function createOAuthClientProvider(config: OAuthProviderConfig): IHOAuthClientProvider {
  const { auth, serverName } = config
  // 記憶體寫穿覆層：auth.store 缺省 = 純記憶體（不持久化）；有 store 時 write-through——
  // 兩者都保證「同一 provider 生命週期內 state/verifier 一致」——SDK 在 oauthFlow 內呼叫
  // state() 之後 connectWithAuth 必須拿回同一枚（單次 flow）。持久化 store 跨重啟仍可讀回。
  const mem = new Map<string, unknown>()
  const store: McpTokenStore = auth.store
    ? {
        get: async (k) => (mem.has(k) ? mem.get(k) : auth.store!.get(k)),
        put: async (k, v) => { mem.set(k, v); await auth.store!.put(k, v) },
      }
    : {
        get: async (k) => mem.get(k),
        put: async (k, v) => { mem.set(k, v) },
      }
  // null 視同 absent：invalidateCredentials 以 put(key, null) 表達刪除（coordinator 文件 API 只有
  // put/get 兩員——putDocument(key, null) 對 jsonl 安全（寫 null 台），讀回 null 同樣視為空）。
  const get = <T>(key: OAuthStoreKey): Promise<T | undefined> =>
    store.get(`oauth:${serverName}:${key}`).then((v) => (v === undefined || v === null ? undefined : (v as T)))
  const put = (key: OAuthStoreKey, data: unknown): Promise<void> => store.put(`oauth:${serverName}:${key}`, data)

  const scopes = auth.scopes ?? []
  // SDK 1.30 的 OAuthClientMetadata 是 RFC 7591 蛇形 wire 格式（redirect_uris / client_name /
  // grant_types / token_endpoint_auth_method）——registerClient 直接 JSON.stringify 它到 /register。
  const clientMetadata: OAuthClientMetadata = {
    client_name: "i-harness",
    client_uri: "https://github.com/i-harness/i-harness",
    redirect_uris: [config.redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
  }
  let savedVerifier = "" // runtime 記憶體（跨 waitForCallback 的 finishAuth 提取）

  return {
    get redirectUrl() { return config.redirectUrl },
    get clientMetadata() { return clientMetadata },
    // state() 是單次 flow 的「既存值優先」（opencode 吸收）：SDK 在 oauthFlow 於 401 後呼叫
    // provider.state() 且把結果嵌入 authorize URL；connectWithAuth 再呼叫必須拿到同一枚，
    // 否則 waitForCallback 的 state 與 URL 不符（fail-closed state mismatch 而非跑通）。
    // invalidateCredentials("all") 清除後下一 flow 重新生成。
    async state() {
      const existing = (await get("state")) as string | undefined
      if (existing !== undefined) return existing
      const s = generateCodeVerifier()
      await put("state", s)
      return s
    },
    async currentState() { return get("state") },
    async clientInformation() {
      // 顯式 clientId → 靜態 client secrets 先例（opencode：clientInformation 直接回 client_id，
      // SDK 據此省略 DCR）；缺省無 → dynamic registration（store 回帶）。
      if (auth.clientId !== undefined) return { client_id: auth.clientId }
      return get("client")
    },
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
