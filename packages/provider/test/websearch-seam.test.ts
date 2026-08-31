import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { getWebSearchProvider, registerWebSearchProvider } from "../src/index.ts"

it("register/get roundtrip", () => {
  const ctx = createContext()
  const provider = { search: async () => [{ title: "t", url: "https://x" }] }
  registerWebSearchProvider(ctx, provider)
  expect(getWebSearchProvider(ctx)).toBe(provider)
})

it("fails closed when no provider registered", () => {
  const ctx = createContext()
  expect(() => getWebSearchProvider(ctx)).toThrow(/NO_PROVIDER/)
})
