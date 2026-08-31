// Reconnect supervisor options (dsh absorb). Absent or `enabled: false` → the
// mount behaves exactly like the pre-supervisor one-shot connect.
export interface McpReconnectConfig {
  enabled?: boolean
  initialDelayMs?: number
  maxDelayMs?: number
  maxRetries?: number
}

/** M26-B1: OAuth 2.1 設定（streamable-http 變體專屬）。 */
export interface McpOAuthConfig {
  /** RFC 7591 client_id；缺省由 dynamic registration 決定（provider 不硬編碼）。 */
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

export type McpServerConfig =
  | {
      transport: "stdio"
      serverName: string
      command: string
      args: string[]
      env?: Record<string, string>
      cwd?: string
      toolCallTimeoutMs?: number
      failOnStartupError?: boolean
      reconnect?: McpReconnectConfig
      /** M26-B1b: roots 設定——絕對路徑 → file://，http(s) URL 原樣，相對路徑對 cwd 解析。 */
      roots?: string[]
      /** M26-B1c: 禁止安裝的工具清單（raw server 名；命中 → 根本不註冊）。 */
      blockedTools?: string[]
      /** M26-B1c: 直接暴露清單（default：全部 direct）。 */
      directTools?: string[]
    }
  | {
      transport: "streamable-http"
      serverName: string
      url: string
      headers?: Record<string, string>
      toolCallTimeoutMs?: number
      failOnStartupError?: boolean
      reconnect?: McpReconnectConfig
      auth?: McpOAuthConfig
      /** M26-B1b: roots 設定——絕對路徑 → file://，http(s) URL 原樣，相對路徑對 cwd 解析。 */
      roots?: string[]
      /** M26-B1c: 禁止安裝的工具清單（raw server 名；命中 → 根本不註冊）。 */
      blockedTools?: string[]
      /** M26-B1c: 直接暴露清單（default：全部 direct）。 */
      directTools?: string[]
    }

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

export function validateMcpConfig(config: McpServerConfig): void {
  const { serverName } = config
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
    throw new Error(`mcp-client: serverName must match ^[A-Za-z0-9_-]{1,32}$ (got "${serverName}")`)
  }
  if (config.toolCallTimeoutMs !== undefined && (!Number.isInteger(config.toolCallTimeoutMs) || config.toolCallTimeoutMs <= 0)) {
    throw new Error(`mcp-client: toolCallTimeoutMs must be a positive integer (got ${config.toolCallTimeoutMs})`)
  }
  const rc = config.reconnect
  if (rc !== undefined) {
    if (typeof rc !== "object" || rc === null || Array.isArray(rc)) {
      throw new Error("mcp-client: reconnect must be an object")
    }
    if (rc.enabled !== undefined && typeof rc.enabled !== "boolean") {
      throw new Error(`mcp-client: reconnect.enabled must be a boolean (got ${String(rc.enabled)})`)
    }
    if (rc.initialDelayMs !== undefined && (!Number.isInteger(rc.initialDelayMs) || rc.initialDelayMs <= 0)) {
      throw new Error(`mcp-client: reconnect.initialDelayMs must be a positive integer (got ${String(rc.initialDelayMs)})`)
    }
    if (rc.maxDelayMs !== undefined && (!Number.isInteger(rc.maxDelayMs) || rc.maxDelayMs <= 0)) {
      throw new Error(`mcp-client: reconnect.maxDelayMs must be a positive integer (got ${String(rc.maxDelayMs)})`)
    }
    if (rc.maxRetries !== undefined && (!Number.isInteger(rc.maxRetries) || rc.maxRetries < 1)) {
      throw new Error(`mcp-client: reconnect.maxRetries must be an integer >= 1 (got ${String(rc.maxRetries)})`)
    }
  }
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
  if (config.roots !== undefined) {
    if (!Array.isArray(config.roots) || config.roots.length > 200) throw new Error("mcp-client: roots must be a string array with at most 200 entries")
    for (const r of config.roots) {
      if (typeof r !== "string" || r.length === 0) throw new Error("mcp-client: roots entries must be non-empty strings")
    }
  }
  validateNameList(config.blockedTools, "blockedTools")
  validateNameList(config.directTools, "directTools")
  if (config.transport === "stdio" && (!config.command || config.command.length === 0)) {
    throw new Error("mcp-client: stdio config requires a non-empty command")
  }
  if (config.transport === "streamable-http" && (!config.url || config.url.length === 0)) {
    throw new Error("mcp-client: streamable-http config requires a url")
  }
}
