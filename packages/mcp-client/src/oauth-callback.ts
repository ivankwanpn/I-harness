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
  let expectedState = ""

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
