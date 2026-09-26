import { expect, it } from "vitest"
import { resolveLocale } from "../src/renderer/design/locale.ts"
it("keeps saved locale ahead of system languages", () => {
  expect(resolveLocale("en", ["zh-HK"])).toBe("en")
  expect(resolveLocale("zh-TW", ["en-US"])).toBe("zh-TW")
})
it("uses the first supported system language and a safe English fallback", () => {
  expect(resolveLocale(null, ["zh-HK", "en-US"])).toBe("zh-TW")
  expect(resolveLocale(null, ["fr-FR", "en-GB"])).toBe("en")
  expect(resolveLocale("invalid", [])).toBe("en")
})
