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

/**
 * DNS-rebind fence: the `Host` header must name a loopback host.
 *
 * Exported FREE functions (not just AuthContext methods) because the fence and
 * the auth check are INDEPENDENT duties: a host with no auth configured must
 * still not be reachable through a rebound hostname or a foreign page.
 * `createAuth` used to be the only way to reach these, and host.ts's mux
 * upgrade handler only called them inside `if (auth !== undefined)` — so a bare
 * `i-harness web` (no `--launch-token`) skipped the fence entirely and accepted
 * a WebSocket upgrade from ANY Origin. Browsers do NOT apply CORS to
 * WebSocket frames, so that origin check is the whole fence for the mux.
 */
export function hostAllowed(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || hostHeader === "") return false // no Host header: not a browser/HTTP client we serve
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "")
    return LOOPBACK_HOSTS.has(hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * CORS fence: an `Origin`, when present, must be a loopback http(s) origin.
 * An ABSENT Origin is allowed — that is a non-browser client (curl, the SDK,
 * the CLI) — which the Host fence covers instead. A browser ALWAYS sends
 * Origin on a WebSocket handshake, so an absent Origin cannot be a forgery
 * vector for the browser case.
 */
export function originAllowed(originHeader: string | undefined): boolean {
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

  return {
    cookieName: () => cookieName,
    launchToken: () => opts.launchToken,
    tokenValid: (token) => token !== undefined && constantTimeEq(token, opts.launchToken),
    signSession,
    verifySession,
    // The fence methods delegate to the module-level functions so the HTTP
    // routes and the mux upgrade can call the SAME predicate with or without
    // an AuthContext in hand.
    hostAllowed,
    originAllowed,
  }
}
