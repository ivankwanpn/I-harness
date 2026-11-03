import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { isIP } from "node:net"
import { win32 } from "node:path"
import type { Dispatcher } from "undici"

export interface WindowsProxySettings {
  enabled: boolean
  server?: string
  override?: string
  autoConfigUrl?: string
  autoConfigEnabled?: boolean
  autoDetect?: boolean
}
/** Trusted process dependencies only. Never populate these from renderer IPC. */
export interface SystemFetchOptions {
  env?: () => NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  readWindowsProxySettings?: () => Promise<WindowsProxySettings>
  /** Electron session.resolveProxy-compatible result: DIRECT, PROXY host:port,
   * HTTPS host:port. Only the first route is used; failures never retry direct. */
  resolveProxy?: (url: string) => Promise<string | undefined>
  now?: () => number
  proxyCacheTtlMs?: number
}
export type GenerationTransportGuard = () => Promise<() => void>
export type SystemFetchFunction = (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit, beforeTransport?: GenerationTransportGuard) => Promise<Response>
export interface SystemFetch { fetch: SystemFetchFunction; close(): Promise<void> }

const execute = promisify(execFile)
const INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"
const configurationError = () => new Error("The configured proxy is invalid or unsupported. Use an HTTP or HTTPS proxy.")
const abortError = () => new DOMException("The request was aborted.", "AbortError")

/** Parses only named current-user Internet Settings values; never logs raw output. */
export function parseWindowsProxySettings(output: string, connections = ""): WindowsProxySettings {
  const values: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL|AutoDetect)\s+REG_(?:DWORD|SZ|EXPAND_SZ)\s*(.*)$/i.exec(line)
    if (match) values[match[1]!.toLowerCase()] = match[2]!.trim()
  }
  const settings: WindowsProxySettings = { enabled: Number(values.proxyenable ?? 0) === 1 }
  if (values.proxyserver) settings.server = values.proxyserver
  if (values.proxyoverride) settings.override = values.proxyoverride
  if (values.autoconfigurl) settings.autoConfigUrl = values.autoconfigurl
  if (values.autodetect !== undefined) settings.autoDetect = Number(values.autodetect) !== 0
  // WinINet's connection flags are a little-endian DWORD at offset 8:
  // PROXY_TYPE_AUTO_PROXY_URL=4 and PROXY_TYPE_AUTO_DETECT=8. These flags,
  // when present, distinguish an inactive retained PAC URL from enabled PAC.
  const binary = /^\s*DefaultConnectionSettings\s+REG_BINARY\s+([\da-f\s]+)$/im.exec(connections)?.[1]?.replace(/\s/g, "")
  if (binary && binary.length >= 24 && binary.length % 2 === 0) {
    const flags = Buffer.from(binary, "hex").readUInt32LE(8)
    settings.autoConfigEnabled = (flags & 4) !== 0
    settings.autoDetect = (flags & 8) !== 0
  }
  return settings
}

async function readWindowsProxySettings(): Promise<WindowsProxySettings> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows"
  if (!win32.isAbsolute(systemRoot)) throw new Error("Windows system directory is unavailable.")
  const registryExecutable = win32.join(systemRoot, "System32", "reg.exe")
  const options = { windowsHide: true, timeout: 2000, maxBuffer: 128 * 1024, encoding: "utf8" as const }
  let primary: string
  try { primary = (await execute(registryExecutable, ["query", INTERNET_SETTINGS], options)).stdout }
  catch { throw new Error("Windows system proxy settings could not be read.") }
  let connections = ""
  try { connections = (await execute(registryExecutable, ["query", `${INTERNET_SETTINGS}\\Connections`, "/v", "DefaultConnectionSettings"], options)).stdout }
  catch (error) {
    // A missing connection record is normal; other failures must not silently
    // downgrade an unknown automatic-proxy configuration to a direct request.
    if ((error as { code?: unknown }).code !== 1) throw new Error("Windows automatic proxy settings could not be read.")
  }
  return parseWindowsProxySettings(primary, connections)
}

function loopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || (isIP(host) === 4 && /^127\./.test(host))
    || (isIP(host) === 6 && /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(host))
}

function interruptible<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); return Promise.reject(abortError()) }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(abortError()) }
    signal.addEventListener("abort", abort, { once: true })
    operation.then(value => { signal.removeEventListener("abort", abort); resolve(value) }, error => { signal.removeEventListener("abort", abort); reject(error) })
  })
}

function bypass(url: URL, raw: string | undefined, system = false): boolean {
  if (!raw) return false
  const host = url.hostname.toLowerCase().replace(/\.$/, "")
  const port = url.port || (url.protocol === "https:" ? "443" : "80")
  for (let item of raw.toLowerCase().split(/[;,\s]+/).filter(Boolean)) {
    if (item === "*") return true
    if (item === "<local>") { if (!host.includes(".") && !host.includes(":")) return true; continue }
    const scheme = /^(https?):\/\//.exec(item)
    if (scheme) { if (`${scheme[1]}:` !== url.protocol) continue; item = item.slice(scheme[0].length) }
    const withPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(item)
    if (withPort) { if (withPort[2] !== port) continue; item = withPort[1]! }
    if (item === host) return true
    if (!system && !item.includes("*") && !item.includes(":")) {
      const domain = item.replace(/^\./, "")
      if (host === domain || host.endsWith(`.${domain}`)) return true
    }
    if (item.includes("*")) {
      const pattern = item.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")
      if (new RegExp(`^${pattern}$`).test(host)) return true
    }
  }
  return false
}

function proxyUrl(raw: string): string {
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`)
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || (url.pathname && url.pathname !== "/") || url.search || url.hash) throw configurationError()
    return url.href
  } catch { throw configurationError() }
}

function manualProxy(settings: WindowsProxySettings, url: URL): string | undefined {
  if (!settings.enabled) return undefined
  if (!settings.server?.trim()) throw configurationError()
  const server = settings.server.trim()
  if (!server.includes("=")) return proxyUrl(server)
  const values = new Map<string, string>()
  for (const item of server.split(";")) {
    if (!item.trim()) continue
    const match = /^\s*([a-z]+)\s*=\s*(\S+)\s*$/i.exec(item)
    if (!match) throw configurationError()
    values.set(match[1]!.toLowerCase(), match[2]!)
  }
  const selected = values.get(url.protocol.slice(0, -1))
  if (selected) return proxyUrl(selected)
  if (values.has("socks")) throw configurationError()
  return undefined
}

function resolvedProxy(raw: string | undefined): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("System automatic proxy resolution returned no route.")
  const first = raw.split(";")[0]!.trim()
  if (first.toUpperCase() === "DIRECT") return undefined
  const match = /^(PROXY|HTTP|HTTPS)\s+(\S+)$/i.exec(first)
  if (!match || match[2]!.includes("://")) throw configurationError()
  return proxyUrl(`${match[1]!.toUpperCase() === "HTTPS" ? "https" : "http"}://${match[2]}`)
}

/** Per-request dispatch only. No global dispatcher, TLS overrides, proxy-setting
 * changes, PAC downloads or implicit direct retry are performed here. */
export function createSystemFetch(options: SystemFetchOptions = {}): SystemFetch {
  const env = options.env ?? (() => process.env), now = options.now ?? Date.now
  const platform = options.platform ?? process.platform
  const ttl = Math.max(0, Math.min(options.proxyCacheTtlMs ?? 30_000, 300_000))
  const closing = new AbortController()
  let closed = false, cache: Promise<WindowsProxySettings> | undefined, expires = 0
  const agents = new Map<string, Promise<Dispatcher>>()
  const retiring = new Set<Promise<Dispatcher>>()
  function settings(): Promise<WindowsProxySettings> {
    if (!cache || now() >= expires) {
      expires = now() + ttl
      cache = (options.readWindowsProxySettings ?? readWindowsProxySettings)().catch(() => { throw new Error("Windows system proxy settings could not be read.") })
    }
    return cache
  }
  async function select(url: URL): Promise<string | undefined> {
    const vars = env()
    if (loopback(url.hostname) || bypass(url, vars.no_proxy ?? vars.NO_PROXY)) return undefined
    const specific = url.protocol === "https:" ? vars.https_proxy ?? vars.HTTPS_PROXY : vars.http_proxy ?? vars.HTTP_PROXY
    const explicit = specific?.trim() || (vars.all_proxy ?? vars.ALL_PROXY)?.trim()
    if (explicit) return proxyUrl(explicit)
    if (options.resolveProxy) {
      let resolved: string | undefined
      try { resolved = await options.resolveProxy(url.href) }
      catch { throw new Error("System automatic proxy resolution failed.") }
      return resolvedProxy(resolved)
    }
    if (platform !== "win32") return undefined
    const config = await settings()
    if ((config.autoConfigUrl && config.autoConfigEnabled !== false) || config.autoDetect || config.autoConfigEnabled) {
      throw new Error("Windows PAC/WPAD proxy configuration requires a trusted system proxy resolver; direct fallback is disabled.")
    }
    if (bypass(url, config.override, true)) return undefined
    return manualProxy(config, url)
  }
  function agent(uri: string): Promise<Dispatcher> {
    let promise = agents.get(uri)
    if (promise) { agents.delete(uri); agents.set(uri, promise); return promise }
    promise = import("undici").then(({ ProxyAgent }) => new ProxyAgent({ uri, proxyTunnel: true }))
    agents.set(uri, promise)
    if (agents.size > 8) {
      const oldest = agents.entries().next().value!
      agents.delete(oldest[0]); retiring.add(oldest[1])
      void oldest[1].then(value => value.close()).catch(() => {}).finally(() => retiring.delete(oldest[1]))
    }
    return promise
  }
  const transport: SystemFetch = {
    async fetch(input, init, beforeTransport) {
      if (closed) throw new Error("System HTTP transport is closed.")
      const requestSignal = init && "signal" in init ? init.signal : input instanceof Request ? input.signal : undefined
      const signal = AbortSignal.any([closing.signal, ...(requestSignal ? [requestSignal] : [])])
      if (signal.aborted) throw abortError()
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("System HTTP transport supports HTTP and HTTPS only.")
      const uri = await interruptible(select(url), signal)
      if (signal.aborted) throw abortError()
      let dispatcher: Dispatcher | undefined
      try {
        if (uri) dispatcher = await agent(uri)
        if (signal.aborted) throw abortError()
      } catch {
        if (signal.aborted) throw abortError()
        throw new Error("The selected proxy request failed. Check the proxy connection and configuration.")
      }
      // Owner failures deliberately remain outside transport redaction. The
      // returned synchronous issue check follows every proxy/dispatcher await.
      const issue = await beforeTransport?.()
      if (signal.aborted) throw abortError()
      issue?.()
      if (!dispatcher) return globalThis.fetch(input, { ...init, signal })
      try { return await globalThis.fetch(input, { ...init, signal, dispatcher } as RequestInit) }
      catch {
        if (signal.aborted) throw abortError()
        throw new Error("The selected proxy request failed. Check the proxy connection and configuration.")
      }
    },
    async close() {
      if (closed) return
      closed = true; closing.abort()
      const pending = [...new Set([...agents.values(), ...retiring])]
      agents.clear(); retiring.clear(); cache = undefined
      await Promise.all(pending.map(async promise => { try { await (await promise).destroy() } catch { /* cleanup does not expose configuration */ } }))
    },
  }
  return transport
}

let shared: SystemFetch | undefined
/** Lazy process singleton; direct requests consult the current global fetch so
 * trusted test stubs and ordinary API-key callers retain their existing seam. */
export const systemFetch: SystemFetchFunction = (input, init, beforeTransport) => (shared ??= createSystemFetch()).fetch(input, init, beforeTransport)
/** Shutdown hook for hosts owning the process-wide transport. */
export async function closeSystemFetch(): Promise<void> { const prior = shared; shared = undefined; await prior?.close() }
