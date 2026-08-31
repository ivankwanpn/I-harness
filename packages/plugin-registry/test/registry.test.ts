import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { cacheNameForSource } from "../src/marketplaces.ts"
import { loadState } from "../src/state.ts"

const execFileAsync = promisify(execFile)

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@test.local",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@test.local",
}

/** git URL (file://) form of an absolute on-disk path (Windows-safe). */
function fileUrl(path: string): string {
  return `file:///${path.replaceAll("\\", "/")}`
}

/** Hermetic `https://github.com/...` → local file URL override, applied on the
 * git process via GIT_CONFIG_* env (every child git in this file has
 * `env: {...process.env}` — the github-form test needs the override, the
 * file://-based tests are unaffected by a remote rewrite). The insteadOf
 * match is the EXACT repo URL (prefix-style bases do not match in git's url
 * rewrite), so the fixture repo's expanded URL is rewritten verbatim. */
function withGithubRewrite(localDir: string, run: () => Promise<void>): Promise<void> {
  const snapshot = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0,
  }
  process.env.GIT_CONFIG_COUNT = "1"
  process.env.GIT_CONFIG_KEY_0 = `url.${fileUrl(localDir)}.insteadOf`
  process.env.GIT_CONFIG_VALUE_0 = "https://github.com/owner/repo.git"
  const restore = (): void => {
    if (snapshot.count === undefined) delete process.env.GIT_CONFIG_COUNT
    else process.env.GIT_CONFIG_COUNT = snapshot.count
    if (snapshot.key === undefined) delete process.env.GIT_CONFIG_KEY_0
    else process.env.GIT_CONFIG_KEY_0 = snapshot.key
    if (snapshot.value === undefined) delete process.env.GIT_CONFIG_VALUE_0
    else process.env.GIT_CONFIG_VALUE_0 = snapshot.value
  }
  return run().finally(restore)
}

// saveState write counter (state module is forwarded, only counted): the
// reinstall tests pin that the refreshed install + recomputed conflicts land
// in exactly ONE atomic state write.
const stateMocks = vi.hoisted(() => ({ saveCount: 0 }))

vi.mock("../src/state.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state.ts")>()
  return {
    ...actual,
    saveState: vi.fn(async (root: string, state: unknown) => {
      stateMocks.saveCount++
      return actual.saveState(root, state as Parameters<typeof actual.saveState>[1])
    }),
  }
})
import {
  PluginArtifactError,
  PluginNotFoundError,
  PluginRegistry,
  SourceConflictError,
  SourceNotFoundError,
  describeCommands,
  parseCommandMarkdown,
  validateCompatibility,
} from "../src/index.ts"

// Committed fixture marketplace: hello (skills + commands/hello.md with
// frontmatter), proxy (.mcp.json only). Read-only — never written to.
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/marketplace-a", import.meta.url))
const HELLO_ID = "Marketplace A__hello"
const PROXY_ID = "Marketplace A__proxy"

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** Build a minimal marketplace (`name: "Test Mkt"`) with the given plugins. */
async function writeMarketplace(
  dir: string,
  plugins: Array<{ name: string; source?: string; description?: string }>,
): Promise<void> {
  await mkdir(join(dir, ".claude-plugin"), { recursive: true })
  const entries = plugins.map((p) => ({ ...p, source: p.source ?? `./plugins/${p.name}` }))
  await writeFile(
    join(dir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: "Test Mkt", plugins: entries }, null, 2),
    "utf8",
  )
  for (const p of entries) {
    await mkdir(join(dir, p.source), { recursive: true })
  }
}

let root: string

beforeEach(async () => {
  root = await tempDir("reg-")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {})
})

function makeRegistry(opts: { existingCommandNames?: string[] | (() => string[]) } = {}): PluginRegistry {
  return new PluginRegistry({ root, ...opts })
}

const NO_RUNTIME = { skillDirs: [], mcpServerConfigs: {}, commandDescriptors: [] }

describe("PluginRegistry: sources", () => {
  it("fresh root: empty sources, empty catalog, empty runtime", async () => {
    const r = makeRegistry()
    expect(await r.listSources()).toEqual([])
    expect(await r.catalog()).toEqual({ plugins: [] })
    expect(r.runtimeInputs()).toEqual(NO_RUNTIME)
  })

  it("addSource(local fixture) registers the source under its manifest name and lists it after a fresh instance", async () => {
    const r = makeRegistry()
    const res = await r.addSource(FIXTURE_DIR)
    expect(res.source).toEqual({ name: "Marketplace A", source: FIXTURE_DIR, lastUpdated: expect.any(Number) })
    expect(res.plugins.map((p) => p.name)).toEqual(["hello", "proxy"])
    // state persisted: a second instance sees the source
    expect(await makeRegistry().listSources()).toEqual([
      { name: "Marketplace A", source: FIXTURE_DIR, lastUpdated: expect.any(Number) },
    ])
  })

  it("adding the same source string again refreshes instead of duplicating", async () => {
    const r = makeRegistry()
    const first = await r.addSource(FIXTURE_DIR)
    const second = await r.addSource(FIXTURE_DIR)
    expect(second.source.name).toBe("Marketplace A")
    expect(first.source.lastUpdated).toBeLessThanOrEqual(second.source.lastUpdated)
    expect(await r.listSources()).toHaveLength(1)
  })

  it("a second source with the same manifest name → SourceConflictError, state unchanged", async () => {
    const copy = await tempDir("reg-dup-")
    await cp(FIXTURE_DIR, copy, { recursive: true })
    const r = makeRegistry()
    await r.addSource(FIXTURE_DIR)
    await expect(r.addSource(copy)).rejects.toThrow(SourceConflictError)
    expect(await r.listSources()).toHaveLength(1)
    await rm(copy, { recursive: true, force: true })
  })

  it("a source directory without a manifest → MarketplaceFetchError, nothing recorded", async () => {
    const src = await tempDir("reg-nomkt-")
    const r = makeRegistry()
    await expect(r.addSource(src)).rejects.toMatchObject({ code: "manifest-invalid" })
    expect(await r.listSources()).toEqual([])
    await rm(src, { recursive: true, force: true })
  })

  it("refreshSource re-reads the manifest and picks up newly added plugins", async () => {
    const src = await tempDir("reg-refresh-")
    await cp(FIXTURE_DIR, src, { recursive: true })
    const r = makeRegistry()
    await r.addSource(src)
    // add a third plugin to the manifest on disk
    const manifest = JSON.parse(await readFile(join(src, ".claude-plugin", "marketplace.json"), "utf8"))
    manifest.plugins.push({ name: "third", source: "./plugins/third" })
    await mkdir(join(src, "plugins", "third", "skills", "third"), { recursive: true })
    await writeFile(join(src, "plugins", "third", "skills", "third", "SKILL.md"), "# third skill", "utf8")
    await writeFile(join(src, ".claude-plugin", "marketplace.json"), JSON.stringify(manifest), "utf8")
    await r.refreshSource("Marketplace A")
    expect((await r.catalog()).plugins.map((p) => p.id)).toContain("Marketplace A__third")
    await rm(src, { recursive: true, force: true })
  })

  it("refreshSource with an unknown name → SourceNotFoundError", async () => {
    await expect(makeRegistry().refreshSource("nope")).rejects.toThrow(SourceNotFoundError)
  })

  it("listSources reports a collect error but keeps the source registered", async () => {
    const src = await tempDir("reg-src-")
    await cp(FIXTURE_DIR, src, { recursive: true })
    const r = makeRegistry()
    await r.addSource(src)
    await rm(join(src, ".claude-plugin"), { recursive: true, force: true })
    await rm(join(src, "marketplace.json"), { force: true })
    const list = await r.listSources()
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe("Marketplace A")
    expect(list[0]!.error).toBeTruthy()
    await rm(src, { recursive: true, force: true })
  })

  it("removeSource drops the source and its cache dir; installed plugins (and their state) stay", async () => {
    const r = makeRegistry()
    await r.addSource(FIXTURE_DIR)
    await r.install(HELLO_ID)
    await r.enable(HELLO_ID)
    // seed the local source's would-be cache dir so clearing is observable
    const cacheDir = join(root, "cache", cacheNameForSource(FIXTURE_DIR))
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(cacheDir, "junk.txt"), "junk", "utf8")
    await r.removeSource("Marketplace A")
    expect(await r.listSources()).toEqual([])
    expect(existsSync(cacheDir)).toBe(false)
    // installed + enabled plugin survives with its runtime intact
    expect((await r.catalog()).plugins.find((p) => p.id === HELLO_ID)).toMatchObject({
      installed: true,
      enabled: true,
    })
    expect(r.runtimeInputs().skillDirs).toEqual([join(root, "skills", HELLO_ID)])
  })
})

describe("PluginRegistry: catalog", () => {
  it("merges discovered marketplace entries with manifest metadata (not installed yet)", async () => {
    const r = makeRegistry()
    await r.addSource(FIXTURE_DIR)
    const { plugins } = await r.catalog()
    expect(plugins.map((p) => p.id)).toEqual([HELLO_ID, PROXY_ID])
    expect(plugins[0]!).toMatchObject({
      id: HELLO_ID,
      marketplace: "Marketplace A",
      name: "hello",
      description: "Greeting plugin with a skill and a command",
      category: "utility",
      tags: ["greeting", "demo"],
      source: FIXTURE_DIR,
      installed: false,
      enabled: false,
    })
    expect(plugins[0]!.capabilities).toBeUndefined()
  })

  it("installed plugins appear with installed=true and disk capabilities", async () => {
    const r = makeRegistry()
    await r.addSource(FIXTURE_DIR)
    await r.install(HELLO_ID)
    const hello = (await r.catalog()).plugins.find((p) => p.id === HELLO_ID)!
    expect(hello.installed).toBe(true)
    expect(hello.enabled).toBe(false)
    expect(hello.capabilities).toEqual({ skills: true, commands: true, mcp: false, executable: false })
    // state round-trips through a fresh instance
    expect((await makeRegistry().catalog()).plugins.find((p) => p.id === HELLO_ID)).toMatchObject({
      installed: true,
      enabled: false,
    })
  })
})

describe("PluginRegistry: install/uninstall", () => {
  it("install copies the plugin into <root>/<mkt>__<name> and records it; reinstall is idempotent", async () => {
    const r = makeRegistry()
    await r.addSource(FIXTURE_DIR)
    await r.install(HELLO_ID)
    expect((await stat(join(root, HELLO_ID, "commands", "hello.md"))).isFile()).toBe(true)
    expect((await readdir(root)).sort()).toEqual(["Marketplace A__hello", "state.json"])
    await r.install(HELLO_ID) // second call: no throw, same copy
    expect((await readdir(root)).sort()).toEqual(["Marketplace A__hello", "state.json"])
  })

  it("reinstall of an enabled plugin: a materialize failure atomically disables it (no mixed runtime surface)", async () => {
    const src = await tempDir("reg-reinst-fail-")
    await cp(FIXTURE_DIR, src, { recursive: true })
    const r = makeRegistry()
    await r.addSource(src)
    await r.install(HELLO_ID)
    await r.enable(HELLO_ID)
    expect(r.runtimeInputs().skillDirs).toEqual([join(root, "skills", HELLO_ID)])
    // occupy the skills overlay PARENT with a file → materialize's first rm
    // (which resolves skills/<id> below it) fails with ENOTDIR
    await rm(join(root, "skills"), { recursive: true, force: true })
    await writeFile(join(root, "skills"), "blocker", "utf8")
    await expect(r.install(HELLO_ID)).rejects.toThrow(PluginArtifactError)
    // state ends COMPLETE and consistent: disabled, limitation cleared,
    // no phantom runtime surface (new install copy stays; overlays are gone)
    const rec = (await loadState(root)).plugins.find((p) => p.id === HELLO_ID)!
    expect(rec).toMatchObject({ installed: true, enabled: false })
    expect(rec.conflicts).toBeUndefined()
    expect(r.runtimeInputs()).toEqual(NO_RUNTIME)
    // healing: remove the blocker → re-enable re-materializes from the new copy
    await rm(join(root, "skills"), { force: true })
    const inputs = await r.enable(HELLO_ID)
    expect(inputs.skillDirs).toEqual([join(root, "skills", HELLO_ID)])
    expect(inputs.commandDescriptors).toHaveLength(1)
    await rm(src, { recursive: true, force: true })
  })

  it("reinstall of an enabled plugin refreshes descriptors and re-evaluates conflicts in ONE state write", async () => {
    const src = await tempDir("reg-reinst-")
    await cp(FIXTURE_DIR, src, { recursive: true })
    const r = makeRegistry({ existingCommandNames: () => ["hello"] })
    await r.addSource(src)
    await r.install(HELLO_ID)
    await r.enable(HELLO_ID)
    expect(r.runtimeInputs().commandDescriptors).toEqual([]) // hello is host-blocked
    // the marketplace gains a second, non-conflicting command
    await writeFile(join(src, "plugins", "hello", "commands", "meta.md"), "# meta command", "utf8")
    stateMocks.saveCount = 0
    await r.install(HELLO_ID)
    expect(stateMocks.saveCount).toBe(1) // refreshed install + recomputed conflicts = one atomic write
    // fresh descriptor materialized; the still-conflicting command stays blocked
    expect((await stat(join(root, "commands", HELLO_ID, "meta.md"))).isFile()).toBe(true)
    expect((await stat(join(root, "commands", HELLO_ID, "hello.md"))).isFile()).toBe(true) // materialized but excluded
    expect(r.runtimeInputs().commandDescriptors).toEqual([{ name: "meta", body: "# meta command" }])
    const rec = (await loadState(root)).plugins.find((p) => p.id === HELLO_ID)!
    expect(rec).toMatchObject({ enabled: true, installed: true })
    expect(rec.conflicts).toEqual([{ name: "hello", reason: "already registered by the host" }])
    await rm(src, { recursive: true, force: true })
  })

  it("install of an id not listed by any registered marketplace → PluginNotFoundError", async () => {
    const r = makeRegistry()
    await r.addSource(FIXTURE_DIR)
    await expect(r.install("No Source__missing")).rejects.toThrow(PluginNotFoundError)
  })

  it("install without any registered source → PluginNotFoundError", async () => {
    await expect(makeRegistry().install(HELLO_ID)).rejects.toThrow(PluginNotFoundError)
  })

  it("uninstall removes the record, install dir and materialize dirs; idempotent", async () => {
    const r = makeRegistry()
    await r.addSource(FIXTURE_DIR)
    await r.install(HELLO_ID)
    await r.enable(HELLO_ID)
    await r.uninstall(HELLO_ID)
    expect(existsSync(join(root, HELLO_ID))).toBe(false)
    expect(existsSync(join(root, "skills", HELLO_ID))).toBe(false)
    expect((await r.catalog()).plugins.find((p) => p.id === HELLO_ID)).toMatchObject({
      installed: false,
      enabled: false,
    })
    await r.uninstall(HELLO_ID) // second call: no throw
    expect(r.runtimeInputs()).toEqual(NO_RUNTIME)
  })

  it("uninstall of a never-installed id is an idempotent no-op (unknown ids are validated, not wiped)", async () => {
    const r = makeRegistry()
    await r.uninstall("some__ghost")
    expect(await loadState(root)).toEqual({ version: 1, sources: [], plugins: [] })
    await expect(r.uninstall("..")).rejects.toMatchObject({ code: "plugin-invalid" })
  })
})

describe("PluginRegistry: object plugin sources (bug fix 1)", () => {
  // Fixture: a real git REPO (two commits; HEAD differs from the earlier sha)
  // that the manifest's git-subdir/url entries clone via file://, plus an
  // in-marketplace directory/file pair. The sha-pinned assertions are
  // DISCRIMINATING: a clone-at-HEAD install would yield "v2" content, so the
  // "v1" result proves the pinned-sha checkout is honored.
  let pluginRepo: string
  let mktDir: string
  let sha1: string
  let branch: string
  let sourceFileUrl: string

  beforeAll(async () => {
    pluginRepo = await tempDir("reg-objrepo-")
    await mkdir(join(pluginRepo, "plugins", "obj", "skills", "obj"), { recursive: true })
    await writeFile(join(pluginRepo, "plugins", "obj", "skills", "obj", "SKILL.md"), "# obj v1\n", "utf8")
    await writeFile(join(pluginRepo, "root-marker.txt"), "ROOT_V1", "utf8")
    await execFileAsync("git", ["init", "-q"], { cwd: pluginRepo })
    await execFileAsync("git", ["add", "-A"], { cwd: pluginRepo })
    await execFileAsync("git", ["commit", "-q", "-m", "v1"], { cwd: pluginRepo, env: { ...process.env, ...GIT_IDENTITY } })
    sha1 = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: pluginRepo, encoding: "utf8" })).stdout.trim()
    branch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: pluginRepo, encoding: "utf8" })).stdout.trim()
    await writeFile(join(pluginRepo, "plugins", "obj", "skills", "obj", "SKILL.md"), "# obj v2\n", "utf8")
    await writeFile(join(pluginRepo, "root-marker.txt"), "ROOT_V2", "utf8")
    await execFileAsync("git", ["add", "-A"], { cwd: pluginRepo })
    await execFileAsync("git", ["commit", "-q", "-m", "v2"], { cwd: pluginRepo, env: { ...process.env, ...GIT_IDENTITY } })
    // file transport: allow the depth-1 fetch of an arbitrary (reachable) sha
    await execFileAsync("git", ["config", "uploadpack.allowReachableSHA1InWant", "true"], { cwd: pluginRepo })
    await execFileAsync("git", ["config", "uploadpack.allowAnySHA1InWant", "true"], { cwd: pluginRepo })
    sourceFileUrl = fileUrl(pluginRepo)

    mktDir = await tempDir("reg-objmkt-")
    await mkdir(join(mktDir, ".claude-plugin"), { recursive: true })
    await mkdir(join(mktDir, "plugins", "dir", "skills", "dir"), { recursive: true })
    await writeFile(join(mktDir, "plugins", "dir", "skills", "dir", "SKILL.md"), "# dir plugin\n", "utf8")
    await mkdir(join(mktDir, "plugins", "file"), { recursive: true })
    await writeFile(join(mktDir, "plugins", "file", "plugin.json"), JSON.stringify({ name: "file-plugin" }), "utf8")
    await writeFile(
      join(mktDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "Object Mkt",
        plugins: [
          { name: "subpid", source: { source: "git-subdir", url: sourceFileUrl, path: "plugins/obj", sha: sha1 } },
          { name: "urlpid", source: { source: "url", url: sourceFileUrl, sha: sha1 } },
          { name: "ghpid", source: { source: "github", repo: "owner/repo", path: "plugins/obj" } },
          { name: "refpid", source: { source: "git-subdir", url: sourceFileUrl, path: "plugins/obj", ref: branch } },
          { name: "dirpid", source: { source: "directory", path: "./plugins/dir" } },
          { name: "filepid", source: { source: "file", path: "./plugins/file/plugin.json" } },
          { name: "escapepid", source: { source: "git-subdir", url: sourceFileUrl, path: "plugins/obj/../../../oops" } },
        ],
      }, null, 2),
      "utf8",
    )
  })

  afterAll(async () => {
    await rm(pluginRepo, { recursive: true, force: true }).catch(() => {})
    await rm(mktDir, { recursive: true, force: true }).catch(() => {})
  })

  it("git-subdir: installs from the pinned SHA's SUBDIR (earlier than HEAD), not the clone root — sha checkout honored", async () => {
    const r = makeRegistry()
    await r.addSource(mktDir)
    await r.install("Object Mkt__subpid")
    const installed = join(root, "Object Mkt__subpid")
    expect(await readFile(join(installed, "skills", "obj", "SKILL.md"), "utf8")).toContain("# obj v1")
    // the SUBDIR is the source: the clone root's own marker never leaks in
    await expect(stat(join(installed, "root-marker.txt"))).rejects.toThrow()
    // the per-plugin clone lives at cache/plugins/<mkt>__<plugin>
    expect((await stat(join(root, "cache", "plugins", "Object Mkt__subpid"))).isDirectory()).toBe(true)
  })

  it("url: installs the pinned SHA from the clone ROOT", async () => {
    const r = makeRegistry()
    await r.addSource(mktDir)
    await r.install("Object Mkt__urlpid")
    expect(await readFile(join(root, "Object Mkt__urlpid", "root-marker.txt"), "utf8")).toBe("ROOT_V1")
  })

  it("github: 'owner/repo' expands to the GitHub git URL and the subdir path applies (no pin → HEAD)", async () => {
    // https://github.com/ is rewritten to the local fixture repo via the git
    // process env (GIT_CONFIG_*) — the clone target is the expanded GitHub URL.
    await withGithubRewrite(pluginRepo, async () => {
      const r = makeRegistry()
      await r.addSource(mktDir)
      await r.install("Object Mkt__ghpid")
      expect(await readFile(join(root, "Object Mkt__ghpid", "skills", "obj", "SKILL.md"), "utf8")).toContain("# obj v2")
    })
  })

  it("git-subdir with a ref pin: the ref is checked out (branch tip == HEAD content)", async () => {
    const r = makeRegistry()
    await r.addSource(mktDir)
    await r.install("Object Mkt__refpid")
    expect(await readFile(join(root, "Object Mkt__refpid", "skills", "obj", "SKILL.md"), "utf8")).toContain("# obj v2")
  })

  it("directory: resolved inside the marketplace directory (string-form behavior)", async () => {
    const r = makeRegistry()
    await r.addSource(mktDir)
    await r.install("Object Mkt__dirpid")
    expect(await readFile(join(root, "Object Mkt__dirpid", "skills", "dir", "SKILL.md"), "utf8")).toContain("# dir plugin")
  })

  it("file: the named file's parent directory is the copy source", async () => {
    const r = makeRegistry()
    await r.addSource(mktDir)
    await r.install("Object Mkt__filepid")
    const installed = JSON.parse(await readFile(join(root, "Object Mkt__filepid", "plugin.json"), "utf8"))
    expect(installed).toEqual({ name: "file-plugin" })
  })

  it("a git-subdir path that escapes the clone dir → manifest-invalid (containment, same rule as string sources)", async () => {
    const r = makeRegistry()
    await r.addSource(mktDir)
    await expect(r.install("Object Mkt__escapepid")).rejects.toMatchObject({ code: "manifest-invalid" })
  })
})

describe("PluginRegistry: enable/disable", () => {
  it("enable materializes skills and commands and returns RuntimeInputs (mcp comes from the re-keyed install copy)", async () => {
    const r = makeRegistry()
    await r.addSource(FIXTURE_DIR)
    await r.install(HELLO_ID)
    await r.install(PROXY_ID)
    const inputs = await r.enable(HELLO_ID)
    expect(inputs).toEqual({
      skillDirs: [join(root, "skills", HELLO_ID)],
      mcpServerConfigs: {},
      commandDescriptors: [
        {
          name: "hello",
          description: "Greets the user by name",
          argumentHints: "[name]",
          body: "Greet the user named {name} with a warm hello.",
        },
      ],
    })
    expect((await stat(join(root, "skills", HELLO_ID, "hello", "SKILL.md"))).isFile()).toBe(true)
    expect((await stat(join(root, "commands", HELLO_ID, "hello.md"))).isFile()).toBe(true)
    // mcp-only plugin: re-keyed server surfaced in mcpServerConfigs
    const inputs2 = await r.enable(PROXY_ID)
    expect(inputs2).toEqual({
      skillDirs: [join(root, "skills", HELLO_ID)],
      mcpServerConfigs: { "plugin:Marketplace_A__proxy:echo": { command: "node", args: ["echo-server.mjs"] } },
      commandDescriptors: [
        {
          name: "hello",
          description: "Greets the user by name",
          argumentHints: "[name]",
          body: "Greet the user named {name} with a warm hello.",
        },
      ],
    })
  })

  it("enabled state + runtime round-trip through a fresh registry instance (state persisted)", async () => {
    const r = makeRegistry()
    await r.addSource(FIXTURE_DIR)
    await r.install(HELLO_ID)
    await r.install(PROXY_ID)
    await r.enable(HELLO_ID)
    await r.enable(PROXY_ID)
    const r2 = makeRegistry()
    expect(r2.runtimeInputs()).toEqual(
      expect.objectContaining({
        skillDirs: [join(root, "skills", HELLO_ID)],
        mcpServerConfigs: { "plugin:Marketplace_A__proxy:echo": { command: "node", args: ["echo-server.mjs"] } },
      }),
    )
    expect((await r2.catalog()).plugins.find((p) => p.id === HELLO_ID)).toMatchObject({
      installed: true,
      enabled: true,
    })
  })

  it("enable is idempotent: a second call returns the same inputs without touching anything", async () => {
    const r = makeRegistry()
    await r.addSource(FIXTURE_DIR)
    await r.install(HELLO_ID)
    const first = await r.enable(HELLO_ID)
    const second = await r.enable(HELLO_ID)
    expect(second).toEqual(first)
  })

  it("disable removes materialized dirs and clears runtime; idempotent; re-enable heals", async () => {
    const r = makeRegistry()
    await r.addSource(FIXTURE_DIR)
    await r.install(HELLO_ID)
    await r.enable(HELLO_ID)
    expect(await r.disable(HELLO_ID)).toEqual(NO_RUNTIME)
    expect(existsSync(join(root, "skills", HELLO_ID))).toBe(false)
    expect((await r.catalog()).plugins.find((p) => p.id === HELLO_ID)).toMatchObject({
      installed: true,
      enabled: false,
    })
    await r.disable(HELLO_ID) // idempotent
    await r.enable(HELLO_ID) // re-enable re-materializes
    expect(r.runtimeInputs().skillDirs).toEqual([join(root, "skills", HELLO_ID)])
  })

  it("enable of an unknown id → PluginNotFoundError", async () => {
    await expect(makeRegistry().enable("nope__x")).rejects.toThrow(PluginNotFoundError)
  })

  it("enable of a record that was never installed → PluginArtifactError", async () => {
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, "state.json"),
      JSON.stringify({
        version: 1,
        sources: [],
        plugins: [{ id: HELLO_ID, marketplace: "Marketplace A", name: "hello", installPath: "", installed: false, enabled: false }],
      }),
      "utf8",
    )
    await expect(makeRegistry().enable(HELLO_ID)).rejects.toThrow(PluginArtifactError)
  })

  it("enable of an installed id whose install dir vanished → PluginArtifactError", async () => {
    const r = makeRegistry()
    await r.addSource(FIXTURE_DIR)
    await r.install(HELLO_ID)
    await rm(join(root, HELLO_ID), { recursive: true })
    await expect(r.enable(HELLO_ID)).rejects.toThrow(PluginArtifactError)
  })

  it("enable of a plugin without skills/commands/mcp → PluginArtifactError", async () => {
    const src = await tempDir("reg-empty-")
    await writeMarketplace(src, [{ name: "empty", source: "./plugins/empty" }])
    const r = makeRegistry()
    await r.addSource(src)
    await r.install("Test Mkt__empty")
    await expect(r.enable("Test Mkt__empty")).rejects.toThrow(PluginArtifactError)
    await rm(src, { recursive: true, force: true })
  })
})

describe("PluginRegistry: command conflicts (D5: enable succeeds, conflicting commands are NOT registered)", () => {
  it("a command name already in the host catalog → enable succeeds, the command is excluded from runtime, the conflict is recorded", async () => {
    const src = await tempDir("reg-conf-")
    await cp(FIXTURE_DIR, src, { recursive: true })
    const r = makeRegistry({ existingCommandNames: () => ["hello"] })
    await r.addSource(src)
    await r.install(HELLO_ID)
    const inputs = await r.enable(HELLO_ID) // D5: a naming conflict is not a rejection
    expect(inputs).toEqual({
      skillDirs: [join(root, "skills", HELLO_ID)],
      mcpServerConfigs: {},
      commandDescriptors: [], // the colliding command is not registered
    })
    // state written atomically: a complete enable with a recorded limitation
    const rec = (await loadState(root)).plugins.find((p) => p.id === HELLO_ID)!
    expect(rec).toMatchObject({ enabled: true, installed: true })
    expect(rec.conflicts).toEqual([{ name: "hello", reason: "already registered by the host" }])
    // catalog exposes the limitation for the UI's failed(部分) badge
    expect((await r.catalog()).plugins.find((p) => p.id === HELLO_ID)).toMatchObject({
      enabled: true,
      conflicts: [{ name: "hello", reason: "already registered by the host" }],
    })
    // skills are unaffected — only the colliding command is blocked
    expect((await stat(join(root, "skills", HELLO_ID, "hello", "SKILL.md"))).isFile()).toBe(true)
    await rm(src, { recursive: true, force: true })
  })

  it("a colliding built-in ('help') blocks only itself: enable succeeds, other commands stay registered", async () => {
    const src = await tempDir("reg-help-")
    await writeMarketplace(src, [{ name: "builder", source: "./plugins/builder" }])
    await mkdir(join(src, "plugins", "builder", "commands"), { recursive: true })
    await writeFile(join(src, "plugins", "builder", "commands", "help.md"), "# collides with the host", "utf8")
    await writeFile(join(src, "plugins", "builder", "commands", "greet.md"), "# builder-specific", "utf8")
    const r = makeRegistry({ existingCommandNames: () => ["help"] })
    await r.addSource(src)
    await r.install("Test Mkt__builder")
    const inputs = await r.enable("Test Mkt__builder")
    expect(inputs.commandDescriptors).toEqual([{ name: "greet", body: "# builder-specific" }])
    expect((await loadState(root)).plugins.find((p) => p.id === "Test Mkt__builder")).toMatchObject({
      enabled: true,
      conflicts: [{ name: "help", reason: "already registered by the host" }],
    })
    await rm(src, { recursive: true, force: true })
  })

  it("a plugin whose command clashes with an already-enabled plugin records the conflict; exactly one command survives", async () => {
    const src = await tempDir("reg-conf2-")
    await writeMarketplace(src, [
      { name: "alpha", source: "./plugins/alpha" },
      { name: "beta", source: "./plugins/beta" },
    ])
    await mkdir(join(src, "plugins", "alpha", "commands"), { recursive: true })
    await writeFile(join(src, "plugins", "alpha", "commands", "hello.md"), "# hello from alpha", "utf8")
    await mkdir(join(src, "plugins", "beta", "commands"), { recursive: true })
    await writeFile(join(src, "plugins", "beta", "commands", "hello.md"), "# hello from beta", "utf8")
    const r = makeRegistry()
    await r.addSource(src)
    await r.install("Test Mkt__alpha")
    await r.install("Test Mkt__beta")
    await r.enable("Test Mkt__alpha")
    await r.enable("Test Mkt__beta") // succeeds; beta's hello is blocked instead
    expect(r.runtimeInputs().commandDescriptors.map((d) => d.name)).toEqual(["hello"])
    expect((await loadState(root)).plugins.find((p) => p.id === "Test Mkt__beta")).toMatchObject({
      enabled: true,
      conflicts: [{ name: "hello", reason: "already provided by enabled plugin Test Mkt__alpha" }],
    })
    // the limitation is a record at enable time: disabling alpha does not resurrect beta's hello
    await r.disable("Test Mkt__alpha")
    expect(r.runtimeInputs().commandDescriptors).toEqual([])
    expect((await loadState(root)).plugins.find((p) => p.id === "Test Mkt__alpha")!.conflicts).toBeUndefined()
    await rm(src, { recursive: true, force: true })
  })

  it("unrelated existing command names do not block an enable and record no conflicts", async () => {
    const r = makeRegistry({ existingCommandNames: () => ["unrelated"] })
    await r.addSource(FIXTURE_DIR)
    await r.install(HELLO_ID)
    const inputs = await r.enable(HELLO_ID)
    expect(inputs.commandDescriptors).toHaveLength(1)
    expect((await loadState(root)).plugins.find((p) => p.id === HELLO_ID)!.conflicts).toBeUndefined()
  })

  it("re-enable re-evaluates conflicts: the command registers once the host no longer claims the name", async () => {
    const r = makeRegistry({ existingCommandNames: ["hello"] })
    await r.addSource(FIXTURE_DIR)
    await r.install(HELLO_ID)
    await r.enable(HELLO_ID)
    expect(r.runtimeInputs().commandDescriptors).toEqual([])
    await r.disable(HELLO_ID)
    const r2 = makeRegistry({ existingCommandNames: ["unrelated"] })
    await r2.enable(HELLO_ID)
    expect(r2.runtimeInputs().commandDescriptors).toHaveLength(1)
    expect((await loadState(root)).plugins.find((p) => p.id === HELLO_ID)!.conflicts).toBeUndefined()
  })
})

describe("PluginRegistry: runtimeInputs", () => {
  it("corrupt state.json → empty runtime (rebuilt defaults + warn); the registry keeps working", async () => {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, "state.json"), "{broken", "utf8")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const r = makeRegistry()
      expect(r.runtimeInputs()).toEqual(NO_RUNTIME)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("runtimeInputs skips an enabled record whose installed copy vanished (materialized dirs keep serving)", async () => {
    const r = makeRegistry()
    await r.addSource(FIXTURE_DIR)
    await r.install(HELLO_ID)
    await r.enable(HELLO_ID)
    await rm(join(root, HELLO_ID), { recursive: true })
    expect(r.runtimeInputs()).toEqual({
      skillDirs: [join(root, "skills", HELLO_ID)],
      mcpServerConfigs: {},
      commandDescriptors: [
        {
          name: "hello",
          description: "Greets the user by name",
          argumentHints: "[name]",
          body: "Greet the user named {name} with a warm hello.",
        },
      ],
    })
  })
})

describe("validateCompatibility", () => {
  it("returns the sorted, deduplicated intersection of command names", () => {
    expect(
      validateCompatibility(
        [
          { name: "c", body: "" },
          { name: "a", body: "" },
          { name: "b", body: "" },
          { name: "a", body: "" },
        ],
        [{ name: "b" }, { name: "c" }, { name: "z" }],
      ),
    ).toEqual({ conflicts: ["b", "c"] })
  })

  it("no overlap → empty conflicts", () => {
    expect(validateCompatibility([{ name: "a", body: "" }], [{ name: "b" }])).toEqual({ conflicts: [] })
  })
})

describe("commands frontmatter parser", () => {
  it("parses --- description/argument-hints + body (name from the file name)", () => {
    const text = `---
description: Greets the user by name
argument-hints: [name]
---

Greet the user named {name} with a warm hello.
`
    expect(parseCommandMarkdown("hello.md", text)).toEqual({
      name: "hello",
      description: "Greets the user by name",
      argumentHints: "[name]",
      body: "Greet the user named {name} with a warm hello.",
    })
  })

  it("strips quoted values and accepts argument_hints/argumentHints aliases", () => {
    expect(
      parseCommandMarkdown("c.md", '---\ndescription: "A quoted description"\nargument_hints: "[x]"\n---\n\nBODY'),
    ).toEqual({ name: "c", description: "A quoted description", argumentHints: "[x]", body: "BODY" })
    expect(parseCommandMarkdown("c.md", "---\nargumentHints: [y]\n---\nTALE").argumentHints).toBe("[y]")
  })

  it("no frontmatter → body only", () => {
    expect(parseCommandMarkdown("plain.md", "# Plain")).toEqual({ name: "plain", body: "# Plain" })
  })

  it("unclosed fence → whole text as body, no metadata", () => {
    expect(parseCommandMarkdown("broken.md", "---\ndescription: lost")).toEqual({
      name: "broken",
      body: "---\ndescription: lost",
    })
  })

  it("describeCommands scans a commands/ dir (top-level .md only, sorted, missing dir → [])", async () => {
    const dir = await tempDir("reg-cmds-")
    await writeFile(join(dir, "z.md"), "# z", "utf8")
    await writeFile(join(dir, "a.md"), "---\ndescription: A one\n---\nA body", "utf8")
    await writeFile(join(dir, "notes.txt"), "not a command", "utf8")
    expect(describeCommands(dir)).toEqual([
      { name: "a", description: "A one", body: "A body" },
      { name: "z", body: "# z" },
    ])
    expect(describeCommands(join(dir, "missing"))).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})
