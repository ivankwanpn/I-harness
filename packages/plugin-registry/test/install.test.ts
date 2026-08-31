import { afterEach, describe, expect, it, vi } from "vitest"
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { inspectCapabilities } from "../src/capability.ts"
import {
  InstallError,
  installPlugin,
  mcpServerKey,
  mcpServerKeyPrefix,
  pluginId,
  readMcpServers,
  resolveEntrySource,
  uninstallPlugin,
} from "../src/install.ts"
import { MarketplaceFetchError } from "../src/marketplaces.ts"

// rename is wrapped in a mock so tests can observe the two-phase overwrite
// sequence (park → swap → drop) and force a swap failure. Everything else in
// node:fs/promises keeps its real implementation.
const fsMock = vi.hoisted(() => ({
  rename: undefined as unknown as ReturnType<typeof vi.fn>,
  realRename: undefined as unknown as (from: string, to: string) => Promise<void>,
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  fsMock.realRename = actual.rename as (from: string, to: string) => Promise<void>
  fsMock.rename = vi.fn((from: string, to: string) => fsMock.realRename(from, to))
  return { ...actual, rename: fsMock.rename }
})

// Committed fixture marketplace (read-only): hello = skills + commands, proxy = .mcp.json only.
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/marketplace-a", import.meta.url))

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** Copy a fixture plugin subtree into a fresh temp dir (the fixture itself is never written to). */
async function copyPlugin(rel: string): Promise<string> {
  const dir = await tempDir("inst-src-")
  await cp(join(FIXTURE_DIR, "plugins", rel), dir, { recursive: true })
  return dir
}

/** Assert a sync function throws MarketplaceFetchError (code: manifest-invalid). */
function expectManifestInvalid(f: () => void): void {
  let caught: unknown = null
  try {
    f()
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(MarketplaceFetchError)
  expect(caught).toMatchObject({ code: "manifest-invalid" })
}

describe("inspectCapabilities", () => {
  it("hello fixture: skills + commands, no mcp, not executable", async () => {
    const dir = await copyPlugin("hello")
    expect(inspectCapabilities(dir)).toEqual({ skills: true, commands: true, mcp: false, executable: false })
  })

  it("proxy fixture: mcp only", async () => {
    const dir = await copyPlugin("proxy")
    expect(inspectCapabilities(dir)).toEqual({ skills: false, commands: false, mcp: true, executable: false })
  })

  it("executable: package.json main or exports['./server'] (JSON.parse only, never loaded)", async () => {
    const main = await tempDir("inst-exec-")
    await writeFile(join(main, "package.json"), JSON.stringify({ name: "x", main: "index.js" }), "utf8")
    expect(inspectCapabilities(main).executable).toBe(true)

    const exp = await tempDir("inst-expsrv-")
    await writeFile(join(exp, "package.json"), JSON.stringify({ name: "x", exports: { "./server": "./server.js" } }), "utf8")
    expect(inspectCapabilities(exp).executable).toBe(true)

    const bare = await tempDir("inst-none-")
    expect(inspectCapabilities(bare)).toEqual({ skills: false, commands: false, mcp: false, executable: false })

    const broken = await tempDir("inst-badpkg-")
    await writeFile(join(broken, "package.json"), "{broken", "utf8")
    expect(inspectCapabilities(broken).executable).toBe(false)
  })

  it("missing directory → all false (safe to inspect an uninstalled id)", async () => {
    const ghost = await tempDir("inst-ghost-")
    await rm(ghost, { recursive: true, force: true })
    expect(inspectCapabilities(ghost)).toEqual({ skills: false, commands: false, mcp: false, executable: false })
  })
})

describe("resolveEntrySource (entry source 約束: resolves only within manifestDir)", () => {
  it("resolves relative sources inside the marketplace dir", () => {
    const mkt = resolve(FIXTURE_DIR)
    expect(resolveEntrySource(mkt, "./plugins/hello")).toBe(resolve(join(mkt, "plugins", "hello")))
    expect(resolveEntrySource(mkt, "plugins/proxy")).toBe(resolve(join(mkt, "plugins", "proxy")))
    expect(resolveEntrySource(mkt, "./plugins/hello/skills")).toBe(resolve(join(mkt, "plugins", "hello", "skills")))
  })

  it("absolute path inside the marketplace dir is allowed", () => {
    const mkt = resolve(FIXTURE_DIR)
    expect(resolveEntrySource(mkt, resolve(join(mkt, "plugins", "hello")))).toBe(resolve(join(mkt, "plugins", "hello")))
  })

  it("filesystem-root manifestDir does not false-reject (root base already ends with sep)", () => {
    const root = resolve(sep) // e.g. "C:\" on win32, "/" on posix
    expect(resolveEntrySource(root, "apps")).toBe(resolve(root, "apps"))
  })

  it("path traversal or absolute path outside the marketplace dir → manifest-invalid", () => {
    const mkt = resolve(FIXTURE_DIR)
    expectManifestInvalid(() => resolveEntrySource(mkt, "../other"))
    expectManifestInvalid(() => resolveEntrySource(mkt, "./plugins/hello/../../../escape"))
    expectManifestInvalid(() => resolveEntrySource(mkt, resolve(join(mkt, "..", "outside"))))
  })
})

describe("resolveEntrySource: symlink containment (realpath, not just lexical)", () => {
  it("rejects an in-marketplace symlink pointing outside; allows one inside — and the installed copy dereferences it", async (ctx) => {
    const marketRoot = await tempDir("inst-mkt-sym-")
    const outside = await tempDir("inst-out-side-")
    await writeFile(join(outside, "secret.txt"), "outside", "utf8")
    const realPlugins = join(marketRoot, "plugins", "real-hello")
    await mkdir(join(realPlugins, "skills", "hello"), { recursive: true })
    await writeFile(join(realPlugins, "skills", "hello", "SKILL.md"), "# internal", "utf8")
    // Directory symlinks need privileges on win32; junctions do not (and fs
    // treats them like symlinks: lstat says so, realpath follows them).
    let linked = false
    for (const type of ["dir", "junction"] as const) {
      try {
        await symlink(outside, join(marketRoot, "plugins", "outside-link"), type)
        await symlink(realPlugins, join(marketRoot, "plugins", "inside-link"), type)
        linked = true
        break
      } catch {
        // try the next link type (dir → junction), keep the dir empty
        await rm(join(marketRoot, "plugins", "outside-link"), { recursive: true, force: true }).catch(() => {})
        await rm(join(marketRoot, "plugins", "inside-link"), { recursive: true, force: true }).catch(() => {})
      }
    }
    if (!linked) {
      ctx.skip() // platform cannot create dir symlinks OR junctions — assertion skipped (noted)
      return
    }
    // a symlink inside the marketplace whose target is outside → manifest-invalid
    expectManifestInvalid(() => resolveEntrySource(marketRoot, "./plugins/outside-link"))
    // a symlink inside the marketplace whose target is also inside → allowed
    const src = resolveEntrySource(marketRoot, "./plugins/inside-link")
    // and the installed copy dereferences: plain files, no link into the marketplace
    const installRoot = await tempDir("inst-root-")
    const res = await installPlugin(src, "mkt", "inside", installRoot)
    expect(res.capabilities.skills).toBe(true)
    const installedSkill = join(res.installPath, "skills", "hello", "SKILL.md")
    expect(await readFile(installedSkill, "utf8")).toContain("# internal")
    expect((await lstat(installedSkill)).isSymbolicLink()).toBe(false)
  })
})

describe("installPlugin", () => {
  it("copies the plugin into installRoot/<mkt>__<name> (atomic; no tmp leftovers) with correct capabilities", async () => {
    const mktDir = await tempDir("inst-mkt-")
    await cp(FIXTURE_DIR, mktDir, { recursive: true })
    const installRoot = await tempDir("inst-root-")
    // The Task 4 flow: entry source resolved against the marketplace manifestDir first.
    const sourceDir = resolveEntrySource(mktDir, "./plugins/hello")
    const res = await installPlugin(sourceDir, "Marketplace A", "hello", installRoot)
    expect(res.id).toBe("Marketplace A__hello")
    expect(res.installPath).toBe(resolve(join(installRoot, "Marketplace A__hello")))
    expect(res.capabilities).toEqual({ skills: true, commands: true, mcp: false, executable: false })
    const skill = await readFile(join(res.installPath, "skills", "hello", "SKILL.md"), "utf8")
    expect(skill).toContain("A tiny demo skill bundled with the fixture marketplace plugin.")
    expect((await stat(join(res.installPath, "commands", "hello.md"))).isFile()).toBe(true)
    expect(await readdir(installRoot)).toEqual(["Marketplace A__hello"])
    // a plugin without .mcp.json contributes no MCP config
    expect(await readMcpServers(res.installPath)).toEqual({})
  })

  it("re-keys .mcp.json servers as plugin:<mkt>__<name>:<server> in the installed copy", async () => {
    const sourceDir = await copyPlugin("proxy")
    const installRoot = await tempDir("inst-root-")
    const res = await installPlugin(sourceDir, "mkt-b", "proxy", installRoot)
    expect(res.capabilities.mcp).toBe(true)
    const installed = JSON.parse(await readFile(join(res.installPath, ".mcp.json"), "utf8"))
    expect(installed).toEqual({ mcpServers: { "plugin:mkt-b__proxy:echo": { command: "node", args: ["echo-server.mjs"] } } })
    expect(await readMcpServers(res.installPath)).toEqual({
      "plugin:mkt-b__proxy:echo": { command: "node", args: ["echo-server.mjs"] },
    })
  })

  it("sanitizes marketplace/plugin/server names in the re-key (space → _): a real marketplace display name must not make the MCP surface unmountable", async () => {
    // Unit: the key composer (+ its per-plugin prefix view) is the SINGLE
    // source for the install-time re-key AND the host's key attribution —
    // chars outside the mounted-server grammar `[A-Za-z0-9_.:-]` become `_`.
    expect(mcpServerKey("Marketplace A__hello", "echo")).toBe("plugin:Marketplace_A__hello:echo")
    expect(mcpServerKey("hello-world__demo", "echo server")).toBe("plugin:hello-world__demo:echo_server")
    expect(mcpServerKeyPrefix("Marketplace A__hello")).toBe("plugin:Marketplace_A__hello:")
    expect(mcpServerKeyPrefix("hello-world__demo")).toBe("plugin:hello-world__demo:")
    // Integration: the installed .mcp.json carries the sanitized key (the
    // record id stays VERBATIM — state/dir identity is unchanged; only the
    // key surface is sanitized), and readMcpServers round-trips it.
    const sourceDir = await copyPlugin("proxy")
    const installRoot = await tempDir("inst-root-")
    const res = await installPlugin(sourceDir, "Marketplace A", "proxy", installRoot)
    expect(res.id).toBe("Marketplace A__proxy")
    expect(await readMcpServers(res.installPath)).toEqual({
      "plugin:Marketplace_A__proxy:echo": { command: "node", args: ["echo-server.mjs"] },
    })
  })

  it("preserves every MCP config field (command/args/cwd/env/url/headers), drops unknown fields", async () => {
    const sourceDir = await tempDir("inst-mcpfull-")
    await writeFile(
      join(sourceDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          full: {
            command: "node",
            args: ["a.js"],
            cwd: "/tmp",
            env: { NODE_ENV: "prod" },
            url: "http://127.0.0.1:1/sse",
            headers: { "x-token": "abc" },
            bogus: 42,
          },
        },
      }),
      "utf8",
    )
    const installRoot = await tempDir("inst-root-")
    const res = await installPlugin(sourceDir, "m", "srv", installRoot)
    expect(await readMcpServers(res.installPath)).toEqual({
      "plugin:m__srv:full": {
        command: "node",
        args: ["a.js"],
        cwd: "/tmp",
        env: { NODE_ENV: "prod" },
        url: "http://127.0.0.1:1/sse",
        headers: { "x-token": "abc" },
      },
    })
  })

  it("overwrite: re-installing the same id replaces the previous copy (stale files gone, content refreshed)", async () => {
    const sourceDir = await copyPlugin("hello")
    const installRoot = await tempDir("inst-root-")
    const first = await installPlugin(sourceDir, "mkt", "hello", installRoot)
    // stale content inside the installed copy (as if it had been edited by a previous consumer)
    await mkdir(join(first.installPath, "stale"), { recursive: true })
    await writeFile(join(first.installPath, "stale", "old.txt"), "should be gone", "utf8")
    // source gains a package.json → the re-install must reflect it
    await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "hello", main: "hello.js" }), "utf8")
    const second = await installPlugin(sourceDir, "mkt", "hello", installRoot)
    expect(second.id).toBe(first.id)
    expect(second.installPath).toBe(first.installPath)
    expect(second.capabilities.executable).toBe(true)
    await expect(stat(join(second.installPath, "stale"))).rejects.toThrow()
    expect((await stat(join(second.installPath, "package.json"))).isFile()).toBe(true)
  })

  it("idempotent: installing twice with an untouched source succeeds and keeps content", async () => {
    const sourceDir = await copyPlugin("hello")
    const installRoot = await tempDir("inst-root-")
    const first = await installPlugin(sourceDir, "mkt", "hello", installRoot)
    const second = await installPlugin(sourceDir, "mkt", "hello", installRoot)
    expect(second.installPath).toBe(first.installPath)
    expect((await readFile(join(first.installPath, "commands", "hello.md"), "utf8")).length).toBeGreaterThan(0)
  })

  it("heals leftover .tmp-/.old- staging dirs of a crash during a previous install", async () => {
    const sourceDir = await copyPlugin("hello")
    const installRoot = await tempDir("inst-root-")
    const id = pluginId("mkt", "hello")
    await mkdir(join(installRoot, `.${id}.tmp-deadbeef`), { recursive: true })
    await writeFile(join(installRoot, `.${id}.tmp-deadbeef`, "junk.txt"), "junk", "utf8")
    await mkdir(join(installRoot, `.${id}.old-cafebabe`), { recursive: true })
    await writeFile(join(installRoot, `.${id}.old-cafebabe`, "junk.txt"), "junk", "utf8")
    const res = await installPlugin(sourceDir, "mkt", "hello", installRoot)
    expect(res.id).toBe(id)
    expect(await readdir(installRoot)).toEqual([id])
    expect((await stat(join(res.installPath, "commands", "hello.md"))).isFile()).toBe(true)
  })

  it("missing source dir → InstallError plugin-invalid; nothing left in installRoot", async () => {
    const installRoot = await tempDir("inst-root-")
    const missing = join(resolve(tmpdir()), "no-such-plugin-source-dir-321")
    await expect(installPlugin(missing, "mkt", "ghost", installRoot)).rejects.toBeInstanceOf(InstallError)
    await expect(installPlugin(missing, "mkt", "ghost", installRoot)).rejects.toMatchObject({ code: "plugin-invalid" })
    expect(await readdir(installRoot)).toEqual([])
  })

  it("invalid .mcp.json → InstallError plugin-invalid; no partial install left", async () => {
    const sourceDir = await copyPlugin("proxy")
    const installRoot = await tempDir("inst-root-")
    await writeFile(join(sourceDir, ".mcp.json"), "{broken", "utf8")
    await expect(installPlugin(sourceDir, "mkt", "proxy", installRoot)).rejects.toMatchObject({ code: "plugin-invalid" })
    await writeFile(join(sourceDir, ".mcp.json"), JSON.stringify({ mcpServers: { echo: 42 } }), "utf8")
    await expect(installPlugin(sourceDir, "mkt", "proxy", installRoot)).rejects.toMatchObject({ code: "plugin-invalid" })
    expect(await readdir(installRoot)).toEqual([])
  })
})

describe("uninstallPlugin", () => {
  it("removes the install dir + materialize dirs (skills/commands); idempotent", async () => {
    const sourceDir = await copyPlugin("hello")
    const installRoot = await tempDir("inst-root-")
    const res = await installPlugin(sourceDir, "mkt", "hello", installRoot)
    // materialize dirs as Task 4 will lay them out: <root>/skills/<id>, <root>/commands/<id>
    await mkdir(join(installRoot, "skills", res.id), { recursive: true })
    await mkdir(join(installRoot, "commands", res.id), { recursive: true })
    await uninstallPlugin(res.id, installRoot)
    await expect(stat(res.installPath)).rejects.toThrow()
    await expect(stat(join(installRoot, "skills", res.id))).rejects.toThrow()
    await expect(stat(join(installRoot, "commands", res.id))).rejects.toThrow()
    await uninstallPlugin(res.id, installRoot) // second call → no throw
    expect((await readdir(installRoot)).sort()).toEqual(["commands", "skills"])
  })

  it("rejects ids that would escape installRoot (no traversal), touching nothing outside", async () => {
    const installRoot = await tempDir("inst-root-")
    const outside = await tempDir("inst-outside-")
    await writeFile(join(outside, "guard.txt"), "keep", "utf8")
    await expect(uninstallPlugin("..", installRoot)).rejects.toMatchObject({ code: "plugin-invalid" })
    await expect(uninstallPlugin("mkt/..", installRoot)).rejects.toMatchObject({ code: "plugin-invalid" })
    expect((await stat(join(outside, "guard.txt"))).isFile()).toBe(true)
  })

  it("rejects the reserved single-component ids 'skills'/'commands' (would collide with a materialize root)", async () => {
    const installRoot = await tempDir("inst-root-")
    await mkdir(join(installRoot, "skills", "other__x"), { recursive: true })
    await writeFile(join(installRoot, "skills", "other__x", "keep.txt"), "keep", "utf8")
    await expect(uninstallPlugin("skills", installRoot)).rejects.toMatchObject({ code: "plugin-invalid" })
    await expect(uninstallPlugin("commands", installRoot)).rejects.toMatchObject({ code: "plugin-invalid" })
    expect((await stat(join(installRoot, "skills", "other__x", "keep.txt"))).isFile()).toBe(true)
  })
})

describe("installPlugin: two-phase overwrite (park → swap → drop)", () => {
  afterEach(() => {
    fsMock.rename.mockReset()
    fsMock.rename.mockImplementation((from: string, to: string) => fsMock.realRename(from, to))
  })

  it("parks the old copy before the swap, then drops it; no .old/.tmp leftovers", async () => {
    const calls: Array<[string, string]> = []
    fsMock.rename.mockImplementation(async (from: string, to: string) => {
      calls.push([from, to])
      return fsMock.realRename(from, to)
    })
    const sourceDir = await copyPlugin("hello")
    const installRoot = await tempDir("inst-root-")
    const first = await installPlugin(sourceDir, "mkt", "hello", installRoot)
    await writeFile(join(first.installPath, "commands", "hello.md"), "stale", "utf8")
    expect(calls).toHaveLength(1) // fresh install: one swap rename
    const second = await installPlugin(sourceDir, "mkt", "hello", installRoot)
    expect(calls).toHaveLength(3) // park(2), swap(3); dropping the parked copy is an rm, not a rename
    expect(calls[1][0]).toBe(first.installPath)
    expect(calls[1][1].includes(`.${second.id}.old-`)).toBe(true)
    expect(calls[2][0].includes(`.${second.id}.tmp-`)).toBe(true)
    expect(calls[2][1]).toBe(first.installPath)
    // content refreshed, no staging leftovers
    expect(await readFile(join(first.installPath, "commands", "hello.md"), "utf8")).not.toBe("stale")
    expect(await readdir(installRoot)).toEqual([first.id])
  })

  it("a failed swap restores the parked old copy (the install path is never left empty)", async () => {
    let renames = 0
    fsMock.rename.mockImplementation(async (from: string, to: string) => {
      renames++
      if (renames === 3) throw new Error("simulated swap failure (EPERM)")
      return fsMock.realRename(from, to)
    })
    const sourceDir = await copyPlugin("hello")
    const installRoot = await tempDir("inst-root-")
    const first = await installPlugin(sourceDir, "mkt", "hello", installRoot)
    await writeFile(join(first.installPath, "commands", "hello.md"), "v1-original", "utf8")
    // park(2) → swap(3, throws) → rollback(4): install-failed, old copy restored
    await expect(installPlugin(sourceDir, "mkt", "hello", installRoot)).rejects.toMatchObject({
      code: "install-failed",
    })
    expect(renames).toBe(4)
    expect(await readFile(join(first.installPath, "commands", "hello.md"), "utf8")).toBe("v1-original")
    expect(await readdir(installRoot)).toEqual([first.id])
    // self-heals: the next install succeeds cleanly
    const healed = await installPlugin(sourceDir, "mkt", "hello", installRoot)
    expect(await readdir(installRoot)).toEqual([healed.id])
    expect(await readFile(join(healed.installPath, "commands", "hello.md"), "utf8")).not.toBe("v1-original")
  })
})

describe("pluginId", () => {
  it("joins marketplace and name with __ and strips path-hostile characters", () => {
    expect(pluginId("mkt", "hello")).toBe("mkt__hello")
    expect(pluginId("Marketplace A", "hello")).toBe("Marketplace A__hello")
    expect(pluginId("mkt", "a/b")).toBe("mkt__a-b")
    expect(pluginId("owner/repo", "x:y")).toBe("owner-repo__x-y")
  })

  it("rejects parts that would form an unsafe path component", () => {
    expect(() => pluginId("..", "x")).toThrow(InstallError)
    expect(() => pluginId("x", "..")).toThrow(InstallError)
    expect(() => pluginId(" ", "x")).toThrow(InstallError)
  })
})
