import { describe, expect, it } from "vitest"
import { createOpenAICompatibleClient } from "../src/index.ts"
import { describeTransportError, type LLMRequest } from "@i-harness/llm-seam"

// M62 regression for the DSH discussion #175 failure mode.
//
// Node collapses every pre-response failure into `TypeError: fetch failed`,
// keeping the reason only in `cause`. An adapter that reports `err.message`
// alone therefore renders DNS, TCP, TLS and proxy failures IDENTICAL — which is
// precisely what made #175 cost 27 comments: nobody could tell a corporate proxy
// from a typo'd baseURL, and the fix (NODE_USE_ENV_PROXY) was in none of the
// error text. These tests pin the distinction, not the phrasing.

/** Build the exact chain shape measured from a real Node fetch rejection. */
function transportRejection(code: string, message: string): Error {
  const cause = Object.assign(new Error(message), { code })
  const err = new TypeError("fetch failed")
  err.cause = cause
  return err
}

const base = { apiKey: "k", baseUrl: "https://provider.example", model: "m" }

function request(): LLMRequest {
  return { messages: [{ role: "user", content: "hi" }], tools: [] } as unknown as LLMRequest
}

async function drain(client: ReturnType<typeof createOpenAICompatibleClient>): Promise<string> {
  let text = ""
  for await (const ev of client.stream(request())) {
    if (ev.type === "error") text += ev.error.message
  }
  return text
}

describe("M62 transport-failure reporting", () => {
  it("names the failing host and the DNS cause instead of only 'fetch failed'", async () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND provider.example"), { code: "ENOTFOUND" }),
    })
    const described = await describeTransportError("openai-compatible", "https://provider.example/v1/chat/completions", err)
    expect(described.message).toContain("ENOTFOUND")
    expect(described.message).toContain("provider.example")
    // The pre-M62 message was exactly this and nothing more.
    expect(described.message).not.toBe("fetch failed")
  })

  it("distinguishes a TLS/cert failure from a DNS failure (the #175 ambiguity)", async () => {
    const dns = await describeTransportError("x", "https://h.example/p", transportRejection("ENOTFOUND", "getaddrinfo ENOTFOUND h.example"))
    const tls = await describeTransportError("x", "https://h.example/p", transportRejection("DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"))
    expect(dns.message).toContain("ENOTFOUND")
    expect(tls.message).toContain("DEPTH_ZERO_SELF_SIGNED_CERT")
    // The whole point: the two are no longer the same string.
    expect(dns.message).not.toBe(tls.message)
  })

  it("carries the remediation hint for the proxy/CA case", async () => {
    const err = transportRejection("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:8080")
    const described = await describeTransportError("x", "https://h.example/p", err)
    expect(described.message).toContain("NODE_USE_ENV_PROXY")
    // The hint is only useful if it also names the CA half of the problem.
    expect(described.message).toContain("NODE_EXTRA_CA_CERTS")
  })

  it("never leaks an API key or Authorization header into the message", async () => {
    const err = transportRejection("ENOTFOUND", "getaddrinfo ENOTFOUND h.example")
    const described = await describeTransportError("x", "https://h.example/p?token=SECRET", err)
    expect(described.message).not.toContain("SECRET")
  })

  it("does not call a caller-initiated abort a transport failure", async () => {
    const abort = new Error("This operation was aborted")
    abort.name = "AbortError"
    const described = await describeTransportError("x", "https://h.example/p", abort)
    expect(described.message).toMatch(/aborted/i)
    expect(described.message).not.toContain("NODE_USE_ENV_PROXY")
  })

  it("keeps the original error reachable as `cause`", async () => {
    const original = transportRejection("ENOTFOUND", "getaddrinfo ENOTFOUND h.example")
    const described = await describeTransportError("x", "https://h.example/p", original)
    expect(described.cause).toBe(original)
  })
})

describe("M62 the adapter actually routes a transport rejection through it", () => {
  it("reports the cause for a rejected fetch, not the bare message", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(transportRejection("ENOTFOUND", "getaddrinfo ENOTFOUND provider.example"))) as typeof fetch
    try {
      const text = await drain(createOpenAICompatibleClient(base))
      expect(text).toContain("ENOTFOUND")
      expect(text).toContain("provider.example")
      // Discriminating: the pre-M62 behaviour produced exactly this and nothing else.
      expect(text).not.toBe("fetch failed")
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("still reports an HTTP error status verbatim (no over-correction)", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response("nope", { status: 404 }))) as typeof fetch
    try {
      const text = await drain(createOpenAICompatibleClient(base))
      expect(text).toContain("404")
      expect(text).toContain("nope")
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
