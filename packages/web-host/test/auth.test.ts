import { describe, expect, it } from "vitest"
import { createAuth } from "../src/auth.ts"

const auth = createAuth({ hmacSecret: "a".repeat(64), launchToken: "launch-xyz" })

describe("createAuth", () => {
  it("signs and verifies a session token; expiry fails closed", () => {
    const token = auth.signSession()
    expect(auth.verifySession(token)).toBe(true)
    const expired = auth.signSession({ exp: Math.floor(Date.now() / 1000) - 10 })
    expect(auth.verifySession(expired)).toBe(false)
    expect(auth.verifySession(token + "0")).toBe(false)
    expect(auth.verifySession(undefined)).toBe(false)
  })
  it("launch token verification is constant-time safe", () => {
    expect(auth.tokenValid("launch-xyz")).toBe(true)
    expect(auth.tokenValid("launch-xy")).toBe(false)
    expect(auth.tokenValid("")).toBe(false)
    expect(auth.tokenValid(undefined)).toBe(false)
  })
  it("fences only loopback hosts and origins", () => {
    expect(auth.hostAllowed("localhost:4310")).toBe(true)
    expect(auth.hostAllowed("127.0.0.1:4310")).toBe(true)
    expect(auth.hostAllowed("[::1]:4310")).toBe(true)
    expect(auth.hostAllowed("evil.com")).toBe(false)
    expect(auth.hostAllowed(undefined)).toBe(false)
    expect(auth.originAllowed("http://localhost:4310")).toBe(true)
    expect(auth.originAllowed("http://127.0.0.1:9955")).toBe(true)
    expect(auth.originAllowed("https://evil.com")).toBe(false)
    expect(auth.originAllowed(undefined)).toBe(true) // non-browser (curl) — host fence applies
  })
  it("rejects a short hmac secret", () => {
    expect(() => createAuth({ hmacSecret: "short", launchToken: "t" })).toThrow(/hmacSecret/)
  })
})
