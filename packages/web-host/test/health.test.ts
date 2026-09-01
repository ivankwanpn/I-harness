import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWebHost } from "../src/host.ts"

// M27-H-1: GET /api/health — { healthy: true, version } served by the host
// with NO seams required (a probe/embedder ping route).
describe("GET /api/health (H-1)", () => {
  async function withHealthHost(
    run: (base: string) => Promise<void>,
    options: Parameters<typeof createWebHost>[0] = { port: 0 },
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-health-"))
    const host = createWebHost({ ...options, port: 0 })
    const { port } = await host.listen()
    try {
      await run(`http://127.0.0.1:${port}`)
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  }

  it("returns healthy+version with no seams at all", async () => {
    await withHealthHost(async (base) => {
      const res = await fetch(`${base}/api/health`)
      expect(res.status).toBe(200)
      expect((await res.json() as { healthy: boolean; version: string })).toMatchObject({
        healthy: true,
        version: expect.any(String),
      })
    })
  })

  it("carries the injectable version (WebHostOptions.version)", async () => {
    await withHealthHost(async (base) => {
      const res = await fetch(`${base}/api/health`)
      expect(res.status).toBe(200)
      const body = await res.json() as { healthy: boolean; version: string }
      expect(body).toEqual({ healthy: true, version: "9.9.9-test" })
    }, { port: 0, version: "9.9.9-test" })
  })

  it("falls back to the exported default version constant", async () => {
    await withHealthHost(async (base) => {
      const res = await fetch(`${base}/api/health`)
      const body = await res.json() as { version: string }
      expect(body.version).toBe("0.1.0")
    })
  })
})
