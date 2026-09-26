import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { withDevConnectSources } from "../electron.csp.ts"

const html = readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8")

describe("renderer CSP", () => {
  it("keeps the shipped document free of dev websocket origins", () => {
    expect(html).toContain("connect-src 'self'")
    expect(html).not.toContain("ws://")
  })

  it("adds the dev websocket origins only for the dev server, idempotently", () => {
    const dev = withDevConnectSources(html)

    expect(dev).toContain("connect-src 'self' ws://localhost:* ws://127.0.0.1:*")
    expect(withDevConnectSources(dev)).toBe(dev)
    expect(html).not.toContain("ws://")
  })
})
