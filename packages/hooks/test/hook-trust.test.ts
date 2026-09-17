import { afterEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { HooksConfig } from "../src/types.ts"
import { sha256File } from "../src/trust.ts"
import { createHookTrustStore, loadHooksConfig, resolveHookTrustPath } from "../src/index.ts"

// D1 of docs/handoff/2026-09-18-prior-art-survey.md: **a declaring layer may
// declare; only the user layer may grant.**
//
// The gap this closes is the one `verifyHandlerTrust` alone cannot: it compares
// the artifact's CURRENT hash against `spec.trust.sha256` -- the value the
// config itself declares. A config that names its own script and its own hash
// therefore satisfies it completely. Whoever writes the config writes the grant.
//
// Survey evidence for why that matters: Codex pins the same self-declared object
// (hash of the config TEXT), Grok pins nothing at all. Neither shipping harness
// solves the first anchor; ours is that the DECLARED hash counts only when the
// config IS the harness home's own file.

afterEach(() => { delete process.env.IH_CONFIG_DIR })

/** A temp dir that is ALSO the harness home. The home resolves through
 * `$IH_CONFIG_DIR` (the isolation contract the skills global-root tests
 * established), and the layer rule is defined against it -- so a test that wants
 * a NON-home config must pass a config path outside this dir. */
async function homeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "i-harness-hooktrust-"))
  process.env.IH_CONFIG_DIR = dir
  return dir
}

/** Write a handler script plus a config that declares it, and return both. */
async function declare(dir: string, id: string, configName = "hooks.json"): Promise<{ configPath: string; sha256: string }> {
  const script = join(dir, `${id}.mjs`)
  await writeFile(script, "process.stdout.write('{}')\n", "utf8")
  const sha256 = await sha256File(script)
  const config: HooksConfig = {
    version: 1,
    handlers: [{
      id,
      event: "session/start",
      type: "command",
      command: { cmd: process.execPath, args: [script] },
      trust: { script, sha256 },
    }],
  }
  const configPath = join(dir, configName)
  await mkdir(dirname(configPath), { recursive: true }) // the plugin shape nests under hooks/
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8")
  return { configPath, sha256 }
}

describe("a declared hash is a grant only in the home's own config", () => {
  it("the home's own hooks.json is self-granting — the user's file IS the grant", async () => {
    const home = await homeDir()
    const { configPath } = await declare(home, "own")
    const loaded = await loadHooksConfig(configPath, home)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.valid).toBe(true)
    expect(loaded[0]!.trustError).toBeUndefined()
  })

  it("a NON-home config's handler is NOT valid even though its declared hash matches the file", async () => {
    await homeDir()
    // A plugin-shaped tree: its own dir, its own hooks/hooks.json. Nothing here
    // is the home's config, so nothing here is the user's grant.
    const plugin = await mkdtemp(join(tmpdir(), "i-harness-plugin-"))
    const { configPath } = await declare(plugin, "from-plugin", join("hooks", "hooks.json"))

    const loaded = await loadHooksConfig(configPath, plugin)
    expect(loaded).toHaveLength(1)
    // THE ASSERTION THAT MATTERS. `verifyHandlerTrust` is satisfied — the file
    // matches its own declared hash — so this is false ONLY because the
    // declaring layer is not allowed to grant itself.
    expect(loaded[0]!.valid).toBe(false)
    expect(String(loaded[0]!.trustError)).toMatch(/not approved/i)
  })

  it("...and becomes valid once that exact hash is approved by the user", async () => {
    await homeDir()
    const plugin = await mkdtemp(join(tmpdir(), "i-harness-plugin-"))
    const { configPath, sha256 } = await declare(plugin, "from-plugin", join("hooks", "hooks.json"))

    const store = createHookTrustStore(resolveHookTrustPath())
    store.approve({ sha256, script: join(plugin, "from-plugin.mjs"), handlerId: "from-plugin" })

    const loaded = await loadHooksConfig(configPath, plugin, store)
    expect(loaded[0]!.valid).toBe(true)
    expect(loaded[0]!.trustError).toBeUndefined()
  })

  it("an approval for a DIFFERENT hash does not approve it", async () => {
    await homeDir()
    const plugin = await mkdtemp(join(tmpdir(), "i-harness-plugin-"))
    const { configPath } = await declare(plugin, "from-plugin", join("hooks", "hooks.json"))

    const store = createHookTrustStore(resolveHookTrustPath())
    store.approve({ sha256: "0".repeat(64), script: "/somewhere/else.mjs", handlerId: "another" })

    const loaded = await loadHooksConfig(configPath, plugin, store)
    expect(loaded[0]!.valid).toBe(false)
  })
})

describe("HookTrustStore", () => {
  it("approve persists: a fresh store over the same path sees it", async () => {
    await homeDir()
    const path = resolveHookTrustPath()
    expect(existsSync(path)).toBe(false)

    createHookTrustStore(path).approve({ sha256: "a".repeat(64), script: "/s.mjs", handlerId: "h" })
    expect(existsSync(path)).toBe(true)

    const reopened = createHookTrustStore(path)
    expect(reopened.isApproved("a".repeat(64))).toBe(true)
    expect(reopened.isApproved("b".repeat(64))).toBe(false)
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.list()[0]!.handlerId).toBe("h")
  })

  it("revoke removes the grant, and revoking an absent hash is a no-op", async () => {
    await homeDir()
    const path = resolveHookTrustPath()
    const store = createHookTrustStore(path)
    store.approve({ sha256: "c".repeat(64), script: "/s.mjs", handlerId: "h" })
    expect(store.isApproved("c".repeat(64))).toBe(true)

    store.revoke("c".repeat(64))
    expect(store.isApproved("c".repeat(64))).toBe(false)
    store.revoke("d".repeat(64)) // absent: no throw
    expect(store.list()).toEqual([])
  })

  it("the store path follows the harness home", async () => {
    const home = await homeDir()
    expect(resolveHookTrustPath()).toBe(join(home, "hook-trust.json"))
    // an explicit dir keeps its own location (the settings config-home convention)
    expect(resolveHookTrustPath("/somewhere/else")).toBe(join("/somewhere/else", "hook-trust.json"))
  })
})
