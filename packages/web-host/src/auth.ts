// packages/web-host/src/auth.ts — R-C3 (dsh browser-auth + api-request-trust
// shape): 1) launch token via query param (?token=) — bootstrap + WS/curl
// clients; 2) HMAC-signed session cookie set by GET /api/auth/login;
// 3) DNS-rebind fence: Host/Origin must be loopback; CORS allow-list =
// loopback origins.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export interface AuthOptions {
  hmacSecret: string // ≥32 chars — cipher key for the cookie signature; NEVER defaulted
  launchToken: string // the bootstrap secret (query ?token=)
  cookieName?: string // default "i-harness"
  maxAgeMs?: number // session-cookie TTL; default 7 days
}

export interface AuthContext {
  cookieName(): string
  launchToken(): string
  tokenValid(token: string | undefined): boolean // constant-time vs launchToken
  signSession(extra?: Record<string, unknown>): string // b64u(payload).b64u(hmac)
  verifySession(token: string | undefined): boolean // hmac constant-time + exp check
  hostAllowed(hostHeader: string | undefined): boolean // loopback only (DNS-rebind fence)
  originAllowed(originHeader: string | undefined): boolean // http(s) + loopback (CORS fence)
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"])

function hmac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest()
}

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function createAuth(opts: AuthOptions): AuthContext {
  const cookieName = opts.cookieName ?? "i-harness"
  const maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 3600 * 1000
  if (opts.hmacSecret.length < 32) throw new Error("auth: hmacSecret must be at least 32 chars (64 hex chars of entropy)")
  const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64url")
  const decode = (value: string): string => Buffer.from(value, "base64url").toString("utf8")

  function signSession(extra: Record<string, unknown> = {}): string {
    const payload = encode(JSON.stringify({
      s: randomBytes(16).toString("base64url"),
      exp: Math.floor(Date.now() / 1000) + Math.floor(maxAgeMs / 1000),
      ...extra,
    }))
    return `${payload}.${hmac(opts.hmacSecret, payload).toString("base64url")}`
  }

  function verifySession(token: string | undefined): boolean {
    if (token === undefined || token === "") return false
    const i = token.indexOf(".")
    if (i === -1) return false
    const payload = token.slice(0, i)
    const signature = token.slice(i + 1)
    const expected = hmac(opts.hmacSecret, payload).toString("base64url")
    if (!constantTimeEq(signature, expected)) return false
    try {
      const data = JSON.parse(decode(payload)) as { exp?: number }
      return typeof data.exp === "number" && data.exp > Math.floor(Date.now() / 1000)
    } catch {
      return false
    }
  }

  function hostAllowed(hostHeader: string | undefined): boolean {
    if (hostHeader === undefined || hostHeader === "") return false // no Host header: not a browser/HTTP client we serve
    try {
      const hostname = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "")
      return LOOPBACK_HOSTS.has(hostname.toLowerCase())
    } catch {
      return false
    }
  }

  function originAllowed(originHeader: string | undefined): boolean {
    if (originHeader === undefined || originHeader === "") return true // no Origin = non-browser request
    try {
      const url = new URL(originHeader)
      if (url.protocol !== "http:" && url.protocol !== "https:") return false
      const hostname = url.hostname.replace(/^\[|\]$/g, "")
      return LOOPBACK_HOSTS.has(hostname.toLowerCase())
    } catch {
      return false
    }
  }

  return {
    cookieName: () => cookieName,
    launchToken: () => opts.launchToken,
    tokenValid: (token) => token !== undefined && constantTimeEq(token, opts.launchToken),
    signSession,
    verifySession,
    hostAllowed,
    originAllowed,
  }
}
