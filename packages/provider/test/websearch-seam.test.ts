import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { getWebSearchProvider, registerWebSearchProvider } from "../src/index.ts"

const provider = (url: string) => ({
  search: async () => ({ sources: [{ url }], truncated: false }),
})

it("register/get roundtrip (dsh shape: id-typed registration, pin-selected read)", () => {
  const ctx = createContext()
  const impl = provider("https://x")
  registerWebSearchProvider(ctx, "default", impl)
  expect(getWebSearchProvider(ctx)).toBe(impl)
  expect(getWebSearchProvider(ctx, "default")).toBe(impl)
})

it("fails closed when no provider registered", () => {
  const ctx = createContext()
  expect(() => getWebSearchProvider(ctx)).toThrow(/NO_PROVIDER/)
})

it("selection: multiple providers without a pin fail loud; the pin resolves; a ghost pin fails", () => {
  const ctx = createContext()
  registerWebSearchProvider(ctx, "a", provider("https://a"))
  registerWebSearchProvider(ctx, "b", provider("https://b"))
  expect(() => getWebSearchProvider(ctx)).toThrow(/MULTIPLE_PROVIDERS/)
  expect(getWebSearchProvider(ctx, "b")).toBeTruthy()
  expect(() => getWebSearchProvider(ctx, "ghost")).toThrow(/ghost/)
})

it("registerWebSearchProvider rejects blank ids and duplicate ids loud", () => {
  const ctx = createContext()
  expect(() => registerWebSearchProvider(ctx, "", provider("https://x"))).toThrow(/non-empty/)
  registerWebSearchProvider(ctx, "a", provider("https://a"))
  expect(() => registerWebSearchProvider(ctx, "a", provider("https://b"))).toThrow(/duplicate/)
})
