import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListRootsRequestSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { pathToFileURL } from "node:url"
import { basename, isAbsolute, resolve } from "node:path"
import { z } from "zod"
import { createTransport, type McpAuthAttachment } from "./transport.ts"
import { createOAuthCallbackServer, type OAuthCallbackServer } from "./oauth-callback.ts"
import { createOAuthClientProvider, type IHOAuthClientProvider } from "./oauth.ts"
import { McpOAuthError } from "./errors.ts"
import type { McpServerConfig } from "./types.ts"

export interface McpTool {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpCallResult {
  content: unknown[]
  isError?: boolean
  structuredContent?: unknown
}

const RawCallToolResultSchema = z.object({
  content: z.array(z.unknown()),
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
})

/** M26-B1b: roots 設定 → roots/list 回應的 uri 陣列。絕對路徑 → file://（Windows 盤符安全），
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

export interface ConnectedMcpClient {
  listTools(cursor?: string): Promise<{ tools: McpTool[]; nextCursor?: string }>
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>
  listResources(server?: string, signal?: AbortSignal): Promise<unknown[]>
  readResource(server: string, uri: string, signal?: AbortSignal): Promise<unknown>
  close(): Promise<void>
  /**
   * Generation-death observation point: register a callback fired when the
   * underlying transport closes ON ITS OWN (server death). The SDK Client also
   * fires it for a deliberate close() — the reconnect supervisor distinguishes
   * those with its own guards. Optional so test fakes and custom clients can
   * omit it.
   */
  onDisconnect?(cb: () => void): void
  /** M26-B1b: resources/templates/list—optional（既有 fake 不實作也零改動）。 */
  listResourceTemplates?(signal?: AbortSignal): Promise<unknown[]>
}

const MAX_AUTH_ATTEMPTS = 3
const AUTH_RETRY_DELAY_MS = 1_000

const isUnauthorized = (err: unknown): boolean =>
  err instanceof UnauthorizedError || (err as { code?: unknown }).code === "UnauthorizedError"

// M26-B1: OAuth 連線迴圈。connect → UnauthorizedError（SDK 已叫過 provider.redirectToAuthorization，
// 瀏覽器流啟動中）→ 等回調碼 → transport.finishAuth(code) → 重試 connect。超時/3 次仍失敗
// → McpOAuthError（fail-closed：不省略、不帶傷掛載）。
// SDK 1.30 現實：Client.connect 失敗時內部 `void this.close()`（abort 該 transport，_abortController
// 不清除）——同一 transport 重連會抛 "already started"，所以每次嘗試新 transport；finishAuth 用
// 觀察到 401 的那枚（它持有 WWW-Authenticate 抓到的 resource-metadata URL/scope）。
async function connectWithAuth(
  client: Client,
  makeTransport: () => Promise<StreamableHTTPClientTransport>,
  server: OAuthCallbackServer,
  provider: OAuthClientProvider,
  config: McpServerConfig & { transport: "streamable-http" },
): Promise<void> {
  const timeoutMs = config.auth!.authTimeoutMs ?? 300_000
  for (let attempt = 0; ; attempt++) {
    const transport = await makeTransport() // 建構失敗 → 原始錯誤傳播（fail-closed）
    try {
      await client.connect(transport)
      return
    } catch (err) {
      if (!isUnauthorized(err)) throw err
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
  // M26-B1: OAuth 組裝——先綁回調端口才能得出 redirectUrl（端口 0 = 系統分配；EADDRINUSE fail-closed）。
  let oauthServer: OAuthCallbackServer | undefined
  let oauthProvider: IHOAuthClientProvider | undefined
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
    const attachment: McpAuthAttachment | undefined = oauthProvider ? { provider: oauthProvider } : undefined
    const client = new Client({ name: "i-harness-mcp-client", version: "0.1.0" })
    const timeout = config.toolCallTimeoutMs ?? 60_000
    // SDK Client (Protocol) fires `onclose` both when the transport dies on its
    // own and when close() is called deliberately — the supervisor treats
    // deliberate closes via its own guards, so this simply notifies observers.
    // Assigned BEFORE connect(): Protocol only reads `onclose` at fire time
    // (never overwrites it during connect), so installing it first leaves no
    // window in which an early transport death goes unobserved.
    const disconnectCallbacks: Array<() => void> = []
    client.onclose = () => {
      for (const cb of [...disconnectCallbacks]) cb()
    }
    // M26-B1b: roots 能力 + 伺服器→客戶端 roots/list 請求（都必須在 connect 前——capabilities
    // 隨 initialize 廣播；request handler 由 Protocol 在 connect 時安裝）。
    client.registerCapabilities({ roots: { listChanged: false } })
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: resolveRootUris(config.roots ?? []).map((uri) => ({
        uri,
        name: basename(new URL(uri).pathname) || uri,
      })),
    }))
    if (oauthServer && oauthProvider) {
      await connectWithAuth(
        client,
        () => createTransport(config, attachment) as Promise<StreamableHTTPClientTransport>,
        oauthServer,
        oauthProvider,
        config as McpServerConfig & { transport: "streamable-http" },
      )
    } else {
      const transport = await createTransport(config)
      await client.connect(transport)
    }

    return {
      // Paginated shape (nextCursor) so syncTools can loop on cursor (Task 4).
      async listTools(cursor) {
        const response = await client.request(
          { method: "tools/list", params: cursor !== undefined ? { cursor } : {} } as never,
          ListToolsResultSchema,
        )
        return {
          tools: response.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          ...(response.nextCursor !== undefined ? { nextCursor: response.nextCursor } : {}),
        }
      },
      async callTool(name, args, signal) {
        const response = await client.request(
          { method: "tools/call", params: { name, arguments: args } } as never,
          RawCallToolResultSchema,
          { timeout, signal },
        )
        return {
          content: response.content,
          ...(response.isError !== undefined ? { isError: response.isError } : {}),
          ...(response.structuredContent !== undefined ? { structuredContent: response.structuredContent } : {}),
        }
      },
      async listResources(_server, signal) {
        const response = await client.request(
          { method: "resources/list", params: {} } as never,
          ListResourcesResultSchema,
          { timeout, signal },
        )
        return response.resources
      },
      async readResource(_server, uri, signal) {
        const response = await client.request(
          { method: "resources/read", params: { uri } } as never,
          ReadResourceResultSchema,
          { timeout, signal },
        )
        return response.contents
      },
      // M26-B1b: optional——既有 fake/mock 陣列零改動（onDisconnect 先例）。
      async listResourceTemplates(signal) {
        const response = await client.request(
          { method: "resources/templates/list", params: {} } as never,
          ListResourceTemplatesResultSchema,
          { timeout, signal },
        )
        return response.resourceTemplates
      },
      async close() {
        await oauthServer?.stop().catch(() => {})
        await client.close()
      },
      onDisconnect(cb) {
        disconnectCallbacks.push(cb)
      },
    }
  } catch (err) {
    await oauthServer?.stop().catch(() => {})
    throw err
  }
}
