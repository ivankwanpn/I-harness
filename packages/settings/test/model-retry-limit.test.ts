import { expect, it } from "vitest"
import { normalizeSettings } from "../src/index.ts"

it.each([undefined, -1, 101, 1.5, "3", NaN])("defaults invalid retry budget %s to five", modelRetryLimit => {
  expect(normalizeSettings({ modelRetryLimit }).modelRetryLimit).toBe(5)
})
it.each([0, 1, 5, 100])("keeps the retry budget %s", modelRetryLimit => {
  expect(normalizeSettings({ modelRetryLimit }).modelRetryLimit).toBe(modelRetryLimit)
})
