import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { normalizeSettings, SettingsStore } from "../src/index.ts"

it("defaults Code Mode off and accepts only explicit named modes", () => {
  expect(normalizeSettings(undefined).codeMode).toEqual({ mode: "off" })
  for (const mode of ["off", "mixed", "only"] as const) expect(normalizeSettings({ codeMode: { mode } }).codeMode.mode).toBe(mode)
  expect(normalizeSettings({ codeMode: { mode: "typo" } }).codeMode.mode).toBe("off")
})

it("bounds finite Code Mode limits and drops invalid values", () => {
  expect(normalizeSettings({ codeMode: { mode: "only", memoryLimitMb: 999, cpuTimeMs: -1, maxActiveCells: 2.9, maxResultBytes: "1", defaultOutputTokens: Infinity } }).codeMode)
    .toEqual({ mode: "only", memoryLimitMb: 256, cpuTimeMs: 10, maxActiveCells: 2 })
})

it("persists Code Mode settings through a store reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-settings-code-"))
  try {
    const path = join(root, "settings.json")
    const store = new SettingsStore({ path })
    await store.set({ codeMode: { mode: "mixed", maxActiveCells: 2 } })
    expect((await new SettingsStore({ path }).load()).codeMode).toEqual({ mode: "mixed", maxActiveCells: 2 })
  } finally { await rm(root, { recursive: true, force: true }) }
})
