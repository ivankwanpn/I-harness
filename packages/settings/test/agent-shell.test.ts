import { expect, it } from "vitest"
import { normalizeSettings, SettingsStore } from "../src/index.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

it("preserves Agent shell choice across settings saves and reloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-agent-shell-settings-"))
  try {
    const path = join(root, "settings.json")
    const store = new SettingsStore({ path })
    await store.load()
    await store.set({ agentShell: "powershell" })
    await store.set({ compaction: { auto: false } })
    const reload = new SettingsStore({ path })
    expect((await reload.load()).agentShell).toBe("powershell")
    expect(normalizeSettings(undefined).agentShell).toBe("auto")
    expect(normalizeSettings({ agentShell: "D:/untrusted.exe" }).agentShell).toBe("auto")
  } finally { await rm(root, { recursive: true, force: true }) }
})
