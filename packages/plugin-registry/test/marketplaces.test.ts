import { describe, expect, it, afterAll, beforeAll } from "vitest"
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import {
  MarketplaceFetchError,
  cacheNameForSource,
  fetchSource,
  githubGitUrl,
  parseManifest,
} from "../src/marketplaces.ts"

const execFileAsync = promisify(execFile)

// Real committed fixture: a marketplace repo with .claude-plugin/marketplace.json
// naming two plugins — hello (skills + commands) and proxy (.mcp.json only).
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/marketplace-a", import.meta.url))

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

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

async function fixtureManifestText(): Promise<string> {
  return readFile(join(FIXTURE_DIR, ".claude-plugin", "marketplace.json"), "utf8")
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

describe("fetchSource: local directory", () => {
  let cacheDir: string

  beforeAll(async () => {
    cacheDir = await tempDir("mkt-cache-")
  })

  afterAll(async () => {
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
  })

  it("reads the manifest in place (manifestDir = resolved source, no cache written)", async () => {
    const res = await fetchSource(FIXTURE_DIR, cacheDir)
    expect(res.manifestDir).toBe(resolve(FIXTURE_DIR))
    expect(res.manifest.name).toBe("Marketplace A")
    expect(res.manifest.plugins).toHaveLength(2)

    // hello: all optional fields present
    expect(res.manifest.plugins[0]).toEqual({
      name: "hello",
      source: "./plugins/hello",
      description: "Greeting plugin with a skill and a command",
      version: "1.2.3",
      category: "utility",
      tags: ["greeting", "demo"],
    })

    // proxy: minimal entry — absent optional fields stay undefined
    expect(res.manifest.plugins[1]).toEqual({
      name: "proxy",
      source: "./plugins/proxy",
      description: "MCP-only proxy plugin (no skills or commands)",
    })

    // local sources never write to the cache dir
    expect(await readdir(cacheDir)).toEqual([])
  })

  it("invalid JSON in the manifest → MarketplaceFetchError code manifest-invalid", async () => {
    const dir = await tempDir("mkt-badjson-")
    await mkdir(join(dir, ".claude-plugin"), { recursive: true })
    await writeFile(join(dir, ".claude-plugin", "marketplace.json"), "{not json", "utf8")
    await expect(fetchSource(dir, cacheDir)).rejects.toBeInstanceOf(MarketplaceFetchError)
    await expect(fetchSource(dir, cacheDir)).rejects.toMatchObject({ code: "manifest-invalid" })
  })

  it("directory with no manifest at all → manifest-invalid", async () => {
    const dir = await tempDir("mkt-nomanifest-")
    await expect(fetchSource(dir, cacheDir)).rejects.toMatchObject({ code: "manifest-invalid" })
  })
})

describe("parseManifest", () => {
  it("prefers .claude-plugin/marketplace.json over bare marketplace.json; absent entry source defaults to ./plugins/<name>", async () => {
    const dir = await tempDir("mkt-parse-")
    await mkdir(join(dir, ".claude-plugin"), { recursive: true })
    await writeFile(
      join(dir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "Dot Pref", plugins: [{ name: "dot", version: "9.9.9" }] }),
      "utf8",
    )
    await writeFile(join(dir, "marketplace.json"), JSON.stringify({ name: "Bare", plugins: [] }), "utf8")
    const m = parseManifest("", dir)
    expect(m.name).toBe("Dot Pref")
    expect(m.plugins[0]).toEqual({ name: "dot", version: "9.9.9", source: "./plugins/dot" })
  })

  it("falls back to bare marketplace.json when .claude-plugin/marketplace.json is missing", async () => {
    const dir = await tempDir("mkt-bare-")
    await writeFile(
      join(dir, "marketplace.json"),
      JSON.stringify({ name: "Bare M", plugins: [{ name: "min", source: "custom/path" }] }),
      "utf8",
    )
    const m = parseManifest("", dir)
    expect(m.name).toBe("Bare M")
    expect(m.plugins[0]).toEqual({ name: "min", source: "custom/path" })
  })

  it("parses given text (no file access): minimal field set + blank source default", async () => {
    const m = parseManifest(JSON.stringify({ name: "T", plugins: [{ name: "p", tags: ["a", "b"], source: "" }] }), "/nonexistent")
    expect(m).toEqual({ name: "T", plugins: [{ name: "p", tags: ["a", "b"], source: "./plugins/p" }] })
  })

  it("missing name / missing or empty plugins → manifest-invalid", async () => {
    const dir = await tempDir("mkt-shape-")
    expectManifestInvalid(() => parseManifest(JSON.stringify({ plugins: [{ name: "p" }] }), dir))
    expectManifestInvalid(() => parseManifest(JSON.stringify({ name: "x" }), dir))
    expectManifestInvalid(() => parseManifest(JSON.stringify({ name: "x", plugins: [] }), dir))
  })

  it("invalid JSON text and wrong-typed entry fields → manifest-invalid", async () => {
    const dir = await tempDir("mkt-typo-")
    expectManifestInvalid(() => parseManifest("{not json", dir))
    expectManifestInvalid(() =>
      parseManifest(JSON.stringify({ name: "x", plugins: [{ name: "p", tags: "not-an-array" }] }), dir),
    )
    expectManifestInvalid(() =>
      parseManifest(JSON.stringify({ name: "x", plugins: [{ name: "p", version: 1 }] }), dir),
    )
  })

  it("passes OBJECT sources through as typed PluginSource members (opencode contract; bug fix 1)", () => {
    const dir = "/nonexistent"
    const m = parseManifest(JSON.stringify({
      name: "T",
      plugins: [
        { name: "a", source: { source: "git-subdir", url: "https://github.com/x/y.git", path: "plugins/a", ref: "v1.2", sha: "abc" } },
        { name: "b", source: { source: "url", url: "https://github.com/x/b.git", sha: "def" } },
        { name: "c", source: { source: "github", repo: "owner/repo", path: "plugins/c" } },
        { name: "d", source: { source: "git", url: "https://github.com/x/d.git", ref: "main" } },
        { name: "e", source: { source: "directory", path: "./plugins/e" } },
        { name: "f", source: { source: "file", path: "./plugins/f/plugin.md" } },
      ],
    }), dir)
    expect(m.plugins[0]!.source).toEqual({
      source: "git-subdir", url: "https://github.com/x/y.git", path: "plugins/a", ref: "v1.2", sha: "abc",
    })
    expect(m.plugins[1]!.source).toEqual({ source: "url", url: "https://github.com/x/b.git", sha: "def" })
    expect(m.plugins[2]!.source).toEqual({ source: "github", repo: "owner/repo", path: "plugins/c" })
    expect(m.plugins[3]!.source).toEqual({ source: "git", url: "https://github.com/x/d.git", ref: "main" })
    expect(m.plugins[4]!.source).toEqual({ source: "directory", path: "./plugins/e" })
    expect(m.plugins[5]!.source).toEqual({ source: "file", path: "./plugins/f/plugin.md" })
  })

  it("object sources with a wrong shape (unknown tag / missing or wrong-typed fields) → manifest-invalid", () => {
    const dir = "/nonexistent"
    const bad: unknown[] = [
      { name: "u", source: { source: "web-server" } },
      { name: "u", source: { source: "git-subdir", url: "https://x" } },             // path missing
      { name: "u", source: { source: "git-subdir", path: "p", url: 42 } },           // url wrong type
      { name: "u", source: { source: "url" } },                                      // url missing
      { name: "u", source: { source: "github", repo: "justowner" } },                // repo not owner/repo
      { name: "u", source: { source: "directory" } },                                // path missing
      { name: "u", source: { source: "file", path: 7 } },                            // path wrong type
      { name: "u", source: 42 },                                                     // neither string nor object
    ]
    for (const plugins of bad.map((p) => [p])) {
      expectManifestInvalid(() => parseManifest(JSON.stringify({ name: "x", plugins }), dir))
    }
  })

  it("githubGitUrl expands owner/repo to the GitHub git URL; rejects malformed shapes", () => {
    expect(githubGitUrl("owner/repo")).toBe("https://github.com/owner/repo.git")
    expect(githubGitUrl("Owner-1/Repo.Name")).toBe("https://github.com/Owner-1/Repo.Name.git")
    expectManifestInvalid(() => githubGitUrl("justowner"))
    expectManifestInvalid(() => githubGitUrl("a/b/c"))
  })
})

describe("fetchSource: http(s) URL", () => {
  let server: Server
  let base: string
  let manifestText: string

  beforeAll(async () => {
    manifestText = await fixtureManifestText()
    server = createServer((req, res) => {
      const path = req.url ?? "/"
      if (path === "/" || path === "/marketplace.json") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(manifestText)
      } else if (path === "/bad.json") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{not json")
      } else {
        res.writeHead(404)
        res.end("not found")
      }
    })
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
    const addr = server.address() as AddressInfo
    base = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  })

  it("fetches marketplace.json, caches it under the cache dir, and parses it", async () => {
    const cacheDir = await tempDir("mkt-http-cache-")
    const source = `${base}/marketplace.json`
    const res = await fetchSource(source, cacheDir)
    expect(res.manifest.name).toBe("Marketplace A")
    expect(res.manifestDir).toBe(join(cacheDir, cacheNameForSource(source)))
    const cached = await readFile(join(res.manifestDir, "marketplace.json"), "utf8")
    expect(JSON.parse(cached).name).toBe("Marketplace A")
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
  })

  it("HTTP error status → source-unreachable", async () => {
    const cacheDir = await tempDir("mkt-http-cache-")
    await expect(fetchSource(`${base}/missing.json`, cacheDir)).rejects.toMatchObject({ code: "source-unreachable" })
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
  })

  it("invalid JSON from the URL → manifest-invalid", async () => {
    const cacheDir = await tempDir("mkt-http-cache-")
    await expect(fetchSource(`${base}/bad.json`, cacheDir)).rejects.toMatchObject({ code: "manifest-invalid" })
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
  })

  it("connection refused → source-unreachable", async () => {
    const cacheDir = await tempDir("mkt-http-cache-")
    const dead = createServer(() => {})
    await new Promise<void>((resolveListen) => dead.listen(0, "127.0.0.1", resolveListen))
    const port = (dead.address() as AddressInfo).port
    await new Promise<void>((resolveClose) => dead.close(() => resolveClose()))
    await expect(fetchSource(`http://127.0.0.1:${port}/marketplace.json`, cacheDir)).rejects.toMatchObject({
      code: "source-unreachable",
    })
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
  })
})

describe("fetchSource: git sources", () => {
  let repoDir: string
  let cacheDir: string

  beforeAll(async () => {
    // A real git repo created from the fixture in a temp dir (the committed
    // fixture is a plain directory; a repo root is what file:// cloning needs).
    repoDir = await tempDir("mkt-git-src-")
    cacheDir = await tempDir("mkt-git-cache-")
    await cp(FIXTURE_DIR, repoDir, { recursive: true })
    await execFileAsync("git", ["init", "-q"], { cwd: repoDir })
    await execFileAsync("git", ["add", "-A"], { cwd: repoDir })
    await execFileAsync("git", ["commit", "-q", "-m", "fixture"], { cwd: repoDir, env: { ...process.env, ...GIT_IDENTITY } })
  })

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true }).catch(() => {})
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
  })

  it("git URL → clone --depth 1 into the cache dir and parse the clone", async () => {
    const source = fileUrl(repoDir)
    const res = await fetchSource(source, cacheDir)
    expect(res.manifest.name).toBe("Marketplace A")
    expect(res.manifestDir).toBe(join(cacheDir, cacheNameForSource(source)))
    expect(res.manifestDir).not.toBe(resolve(repoDir)) // a clone, not the source dir
    expect((await stat(join(res.manifestDir, ".claude-plugin", "marketplace.json"))).isFile()).toBe(true)
  })

  it("existing cache dir for the same source → re-pull (refreshes a stale manifest)", async () => {
    const source = fileUrl(repoDir)
    const first = await fetchSource(source, cacheDir)
    // Corrupt the cached clone, then fetch again: the fetch must replace it.
    await writeFile(join(first.manifestDir, ".claude-plugin", "marketplace.json"), "{broken", "utf8")
    const second = await fetchSource(source, cacheDir)
    expect(second.manifest.name).toBe("Marketplace A")
    await expect(readFile(join(second.manifestDir, ".claude-plugin", "marketplace.json"), "utf8")).resolves.toContain(
      "Marketplace A",
    )
  })

  it("clone of a nonexistent repository → source-unreachable (hermetic, no network)", async () => {
    const doomed = fileUrl(join(repoDir, "no-such-sibling-repo"))
    const res = await fetchSource(doomed, cacheDir).catch((e: unknown) => e)
    expect(res).toBeInstanceOf(MarketplaceFetchError)
    expect((res as MarketplaceFetchError).code).toBe("source-unreachable")
  })
})

describe("cacheNameForSource", () => {
  it("is deterministic per source form", () => {
    expect(cacheNameForSource("https://host.example/path/marketplace.json")).toBe("host-example-path-marketplace-json")
    expect(cacheNameForSource("git@github.com:owner/repo.git")).toBe("repo")
  })

  it("owner/repo and its expanded GitHub git URL share one cache key (fetch/purge symmetry)", () => {
    expect(cacheNameForSource("owner/repo")).toBe("github-com-owner-repo")
    expect(cacheNameForSource("owner/repo.git")).toBe("github-com-owner-repo")
    expect(cacheNameForSource("owner/repo")).toBe(cacheNameForSource("https://github.com/owner/repo.git"))
  })
})
