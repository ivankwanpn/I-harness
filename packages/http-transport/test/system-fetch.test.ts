import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"
import { connect, type Socket } from "node:net"
import { once } from "node:events"
import { createSystemFetch } from "../src/index.ts"
import { parseWindowsProxySettings } from "../src/system-fetch.ts"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const fn of cleanup.splice(0).reverse()) await fn() })
async function listen(server: Server): Promise<number> {
  const sockets = new Set<Socket>()
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return (server.address() as { port: number }).port
}
async function network() {
  // Reserved fixture hostnames are handled only by the local CONNECT proxy.
  // A routing regression must fail locally instead of attempting DNS/network.
  const nativeFetch = globalThis.fetch
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname.endsWith(".invalid") && (!init || !("dispatcher" in init))) throw new Error("Unexpected direct fixture request")
    return nativeFetch(input, init)
  })
  let targetRequests = 0
  const target = createServer((req, res) => { targetRequests++; if (req.url === "/wait") return; res.setHeader("Content-Type", "text/plain"); res.end(`target:${req.url}`) })
  const targetPort = await listen(target)
  const connects: string[] = []
  const proxy = createServer((_req, res) => { res.writeHead(500).end("Expected CONNECT") })
  proxy.on("connect", (req, socket, head) => {
    connects.push(req.url!)
    const upstream = connect(targetPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy())
  })
  const proxyPort = await listen(proxy)
  return { targetPort, proxyPort, connects, requests: () => targetRequests, proxyUrl: `http://127.0.0.1:${proxyPort}`, url: `http://service.fixture.invalid:${targetPort}/path` }
}
function transport(options: Parameters<typeof createSystemFetch>[0] = {}) {
  const value = createSystemFetch({ env: () => ({}), platform: "linux", ...options })
  cleanup.push(() => value.close()); return value
}

describe("system proxy fetch", () => {
  it("sends through an actual local CONNECT proxy using environment precedence", async () => {
    const n = await network()
    const t = transport({ platform: "win32", env: () => ({ HTTP_PROXY: n.proxyUrl }), readWindowsProxySettings: async () => { throw new Error("must not read OS when env selects proxy") } })
    const response = await t.fetch(n.url)
    expect(await response.text()).toBe("target:/path")
    expect(n.connects).toEqual([`service.fixture.invalid:${n.targetPort}`])
    expect(n.requests()).toBe(1)
  })

  it("uses Windows per-protocol configuration, with a bounded shared lookup cache", async () => {
    const n = await network(); let reads = 0, now = 0
    const t = transport({ platform: "win32", now: () => now, proxyCacheTtlMs: 50, readWindowsProxySettings: async () => { reads++; return { enabled: true, server: `http=127.0.0.1:${n.proxyPort};https=127.0.0.1:1` } } })
    const results = await Promise.all([t.fetch(n.url), t.fetch(n.url)])
    expect(await Promise.all(results.map(r => r.text()))).toEqual(["target:/path", "target:/path"])
    expect(reads).toBe(1)
    now = 51; expect(await (await t.fetch(n.url)).text()).toBe("target:/path"); expect(reads).toBe(2)
  })

  it("bypasses loopback even when a proxy is configured", async () => {
    const n = await network()
    const t = transport({ env: () => ({ HTTP_PROXY: n.proxyUrl }) })
    expect(await (await t.fetch(`http://127.0.0.1:${n.targetPort}/direct`)).text()).toBe("target:/direct")
    expect(n.connects).toEqual([])
  })

  it("does not classify a remote hostname beginning with 127 as loopback", async () => {
    const n = await network()
    const t = transport({ env: () => ({ HTTP_PROXY: n.proxyUrl }) })
    expect(await (await t.fetch(`http://127.example.invalid:${n.targetPort}/path`)).text()).toBe("target:/path")
    expect(n.connects).toEqual([`127.example.invalid:${n.targetPort}`])
  })

  it("honors NO_PROXY host, subdomain, wildcard and port matching", async () => {
    const calls: RequestInit[] = []
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => { calls.push(init ?? {}); return new Response("fixture") })
    const t = transport({ env: () => ({ HTTPS_PROXY: "http://127.0.0.1:32123", NO_PROXY: "example.test:443,*.internal.test" }) })
    for (const url of ["https://example.test", "https://sub.example.test", "https://a.internal.test", "https://example.test:444"]) await t.fetch(url)
    expect(calls.map(c => "dispatcher" in c)).toEqual([false, false, false, true])
  })

  it("honors system bypass patterns, local names, and disabled manual settings", async () => {
    const dispatch: boolean[] = []
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => { dispatch.push(!!init && "dispatcher" in init); return new Response("fixture") })
    const t = transport({ platform: "win32", readWindowsProxySettings: async () => ({ enabled: true, server: "127.0.0.1:32123", override: "<local>;*.internal.test;special.test:8443" }) })
    for (const url of ["http://intranet", "https://a.internal.test", "https://special.test:8443", "https://special.test"]) await t.fetch(url)
    expect(dispatch).toEqual([false, false, false, true])
    await transport({ platform: "win32", readWindowsProxySettings: async () => ({ enabled: false, server: "127.0.0.1:32123" }) }).fetch("https://service.fixture.invalid")
    expect(dispatch.at(-1)).toBe(false)
  })

  it("consults the current global fetch when direct and chooses lowercase env before uppercase and ALL_PROXY", async () => {
    const n = await network()
    const t = transport({ env: () => ({ http_proxy: n.proxyUrl, HTTP_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:2" }) })
    expect(await (await t.fetch(n.url)).text()).toBe("target:/path")
    const direct = transport()
    vi.stubGlobal("fetch", async () => new Response("late stub"))
    expect(await (await direct.fetch("https://service.fixture.invalid")).text()).toBe("late stub")
  })

  it("fails explicitly for PAC/WPAD without a trusted resolver and accepts resolved directives", async () => {
    const n = await network()
    const settings = async () => ({ enabled: false, autoConfigUrl: "http://pac.fixture.invalid/private-token" })
    await expect(transport({ platform: "win32", readWindowsProxySettings: settings }).fetch(n.url)).rejects.toThrow("PAC")
    await expect(transport({ platform: "win32", readWindowsProxySettings: async () => ({ enabled: false, autoDetect: true }) }).fetch(n.url)).rejects.toThrow("WPAD")
    const t = transport({ platform: "win32", readWindowsProxySettings: settings, resolveProxy: async () => `PROXY 127.0.0.1:${n.proxyPort}; DIRECT` })
    expect(await (await t.fetch(n.url)).text()).toBe("target:/path")
  })

  it("does not fall back to a direct request when the selected proxy fails and redacts errors", async () => {
    const n = await network()
    const rejected = createServer()
    rejected.on("connect", (_req, socket) => socket.end("HTTP/1.1 502 Proxy Error\r\nContent-Length:0\r\n\r\n"))
    const port = await listen(rejected)
    const t = transport({ env: () => ({ HTTP_PROXY: `http://secret-user:secret-password@127.0.0.1:${port}` }) })
    const error = await t.fetch(n.url).catch(e => e)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain("proxy")
    expect(JSON.stringify(error) + String(error)).not.toMatch(/secret-user|secret-password/)
    expect(n.requests()).toBe(0)
  })

  it("propagates cancellation and closes active proxy sockets", async () => {
    const n = await network()
    const t = transport({ env: () => ({ HTTP_PROXY: n.proxyUrl }) })
    const controller = new AbortController()
    const request = t.fetch(n.url.replace("/path", "/wait"), { signal: controller.signal }).catch(e => e)
    while (n.requests() === 0) await new Promise(r => setTimeout(r, 5))
    controller.abort()
    expect((await request).name).toBe("AbortError")
    const active = t.fetch(n.url.replace("/path", "/wait")).catch(e => e)
    while (n.requests() < 2) await new Promise(r => setTimeout(r, 5))
    await t.close()
    expect((await active).name).toBe("AbortError")
    await expect(t.fetch(n.url)).rejects.toThrow("closed")
  })

  it("aborts while system proxy lookup is pending and redacts lookup/resolver errors", async () => {
    const controller = new AbortController()
    const t = transport({ platform: "win32", readWindowsProxySettings: () => new Promise(() => {}) })
    const request = t.fetch("https://service.fixture.invalid", { signal: controller.signal }).catch(e => e)
    controller.abort()
    const outcome = await Promise.race([request, new Promise(resolve => setTimeout(() => resolve("not-aborted"), 80))])
    expect(outcome).toHaveProperty("name", "AbortError")
    const readFailure = transport({ platform: "win32", readWindowsProxySettings: async () => { throw new Error("secret-proxy-password") } })
    await expect(readFailure.fetch("https://service.fixture.invalid")).rejects.not.toThrow("secret-proxy-password")
    const resolverFailure = transport({ resolveProxy: async () => { throw new Error("The configured proxy secret-proxy-password") } })
    await expect(resolverFailure.fetch("https://service.fixture.invalid")).rejects.not.toThrow("secret-proxy-password")
  })

  it("parses registry fixtures without conflating disabled PAC with enabled PAC", () => {
    const main = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=proxy.local:80;https=proxy.local:81
    ProxyOverride    REG_SZ    <local>;*.internal
    AutoConfigURL    REG_SZ    http://pac.local/script
    AutoDetect    REG_DWORD    0x0`
    const flags = `    DefaultConnectionSettings    REG_BINARY    46000000000000000B000000`
    expect(parseWindowsProxySettings(main, flags)).toEqual({ enabled: true, server: "http=proxy.local:80;https=proxy.local:81", override: "<local>;*.internal", autoConfigUrl: "http://pac.local/script", autoConfigEnabled: false, autoDetect: true })
    expect(parseWindowsProxySettings("ProxyEnable REG_DWORD 0x0")).toEqual({ enabled: false })
  })
})
