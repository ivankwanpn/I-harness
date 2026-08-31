import { afterEach, expect, it } from "vitest"
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
  // handler 附在 fetch 前：server handler 會在 fetch 期間 reject——晚附會成 unhandled rejection。
  const expectation = expect(promise).rejects.toThrow(/state mismatch/)
  await fetch(server.redirectUrl() + "?code=X&state=evil", {})
  await expectation
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
