import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PluginRegistry } from "@i-harness/plugin-registry"
import { parsePluginsArgs, renderPluginTable, runPluginsCommand } from "../src/plugins.ts"

// `i-harness plugins` — the CLI face of the plugin registry's readiness
// vocabulary (owner ruling 2026-09-21, M6 precedent synthesis #8). The registry
// state, the catalog merge and evaluatePlugin have existed since the frontend
// removal with zero production consumers; this is the consumer the owner chose.
//
// THE CASES THAT MATTER MOST are the honesty ones: a listing has no live
// session, so it must not print `failed` for a dimension that only a live
// session could have observed (the D-MCP-1 week was exactly that false signal,
// in the other direction — a real failure nothing could see).

function marketplaceWith(plugins: Record<string, (dir: string) => void>): string {
  const src = mkdtempSync(join(tmpdir(), "i-harness-plugins-cmd-src-"))
  mkdirSync(join(src, ".claude-plugin"), { recursive: true })
  writeFileSync(
    join(src, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "Cmd Mkt",
      plugins: Object.keys(plugins).map((name) => ({ name, source: `./plugins/${name}` })),
    }),
    "utf8",
  )
  for (const [name, build] of Object.entries(plugins)) {
    const dir = join(src, "plugins", name)
    mkdirSync(dir, { recursive: true })
    build(dir)
  }
  return src
}

describe("parsePluginsArgs", () => {
  it("bare `plugins` is the list, and `list` says the same", () => {
    expect(parsePluginsArgs(["plugins"])).toEqual({ subcommand: "list" })
    expect(parsePluginsArgs(["plugins", "list"])).toEqual({ subcommand: "list" })
    expect(parsePluginsArgs(["plugins", "--json"])).toEqual({ subcommand: "list", json: true })
    expect(parsePluginsArgs(["plugins", "list", "--json"])).toEqual({ subcommand: "list", json: true })
  })

  it("help forms", () => {
    expect(parsePluginsArgs(["plugins", "help"])).toEqual({ subcommand: "help" })
    expect(parsePluginsArgs(["plugins", "--help"])).toEqual({ subcommand: "help" })
    expect(parsePluginsArgs(["plugins", "-h"])).toEqual({ subcommand: "help" })
  })

  it("lifecycle verbs are refused by name — this listing is read-only", () => {
    // The owner's ruling built the REPORT face; install/enable/disable are a
    // separate decision. A verb that silently listed nothing would read as
    // "the plugin is fine", which is the worst possible answer.
    for (const verb of ["install", "enable", "disable"]) {
      const parsed = parsePluginsArgs(["plugins", verb, "m__p"])
      expect(parsed.subcommand).toBe("help")
      expect(parsed.error).toMatch(new RegExp(`${verb}.*read-only`))
    }
  })

  it("an unknown token is an error, not a silent list", () => {
    const parsed = parsePluginsArgs(["plugins", "lst"])
    expect(parsed.subcommand).toBe("help")
    expect(parsed.error).toMatch(/lst/)
  })
})

describe("renderPluginTable", () => {
  it("nothing installed is stated, never an empty screen", () => {
    expect(renderPluginTable({ pluginsRoot: "/nowhere/plugins", plugins: [] })).toMatch(/no plugins installed in \/nowhere\/plugins/)
  })

  it("prints each plugin's flag, the provable readiness, dimensions and diagnostics", () => {
    const out = renderPluginTable({
      pluginsRoot: "/h/plugins",
      plugins: [
        {
          id: "Mkt__proxy",
          marketplace: "Mkt",
          name: "proxy",
          installed: true,
          enabled: true,
          status: "not-evaluated",
          dimensions: { skills: "unsupported", commands: "unsupported", mcp: "not-evaluated", agents: "unsupported", hooks: "unsupported", executable: "unsupported" },
          declaredCommands: [],
          declaredMcpServers: ["plugin:Mkt__proxy:echo"],
          conflicts: [],
          diagnostics: [],
        },
        {
          id: "Mkt__off",
          marketplace: "Mkt",
          name: "off",
          installed: true,
          enabled: false,
          status: "disabled",
          dimensions: { skills: "disabled", commands: "disabled", mcp: "disabled", agents: "disabled", hooks: "disabled", executable: "unsupported" },
          declaredCommands: [],
          declaredMcpServers: [],
          conflicts: [],
          diagnostics: [],
        },
      ],
    })
    expect(out).toContain("Mkt__proxy")
    expect(out).toContain("[enabled]")
    expect(out).toContain("Mkt__off")
    expect(out).toContain("[disabled]")
    expect(out).toContain("plugin:Mkt__proxy:echo")
    expect(out).toMatch(/mcp: not evaluated here \(needs a live session\)/)
    // The readiness line names the dimensions that made it unprovable — derived
    // from the row, so it cannot drift from the lines below it.
    expect(out).toContain("readiness: not evaluated here (needs a live session: mcp)")
  })
})

describe("runPluginsCommand — against a real registry home", () => {
  let home: string
  let previous: string | undefined
  let src: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "i-harness-plugins-cmd-"))
    previous = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = home

    src = marketplaceWith({
      hello: (dir) => {
        mkdirSync(join(dir, "skills", "hello"), { recursive: true })
        writeFileSync(join(dir, "skills", "hello", "SKILL.md"), "# hello\n\nGreets the user.\n", "utf8")
        mkdirSync(join(dir, "commands"), { recursive: true })
        // `allowed-tools` is a frontmatter key this repo does NOT honour — it
        // must be REPORTED, never silently ignored.
        writeFileSync(
          join(dir, "commands", "hello.md"),
          ["---", "description: Greets the user", "allowed-tools: Read", "---", "", "Greet {name}."].join("\n"),
          "utf8",
        )
      },
      proxy: (dir) => {
        writeFileSync(
          join(dir, ".mcp.json"),
          JSON.stringify({ mcpServers: { echo: { command: "node", args: ["echo-server.mjs"] } } }),
          "utf8",
        )
      },
      off: (dir) => {
        mkdirSync(join(dir, "commands"), { recursive: true })
        writeFileSync(join(dir, "commands", "off.md"), ["---", "description: Disabled plugin"].join("\n"), "utf8")
      },
    })

    const registry = new PluginRegistry({ root: join(home, "plugins") })
    await registry.addSource(src)
    for (const name of ["hello", "proxy", "off"]) {
      await registry.install(`Cmd Mkt__${name}`)
    }
    await registry.enable("Cmd Mkt__hello")
    await registry.enable("Cmd Mkt__proxy")
    // `off` stays installed and disabled — the disabled case.
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previous
    rmSync(home, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  })

  function captureLog(): { lines: string[]; restore: () => void } {
    const lines: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")) })
    return { lines, restore: () => spy.mockRestore() }
  }

  it("lists the installed plugins with their enabled flag", async () => {
    const { lines, restore } = captureLog()
    try {
      expect(await runPluginsCommand(["plugins"])).toBe(0)
    } finally {
      restore()
    }
    const out = lines.join("\n")
    expect(out).toContain("Cmd Mkt__hello")
    expect(out).toContain("[enabled]")
    expect(out).toContain("Cmd Mkt__off")
    expect(out).toContain("[disabled]")
    expect(out).toContain("readiness: disabled")
  })

  it("a statically provable dimension is printed as the evaluator's own verdict: skills ready", async () => {
    const { lines, restore } = captureLog()
    try {
      await runPluginsCommand(["plugins"])
    } finally {
      restore()
    }
    // The materialized overlay is on disk and is what a live build reads back —
    // so this WAS knowable without a session, and is printed as fact.
    expect(lines.join("\n")).toMatch(/skills: ready/)
  })

  it("HONESTY: an MCP-declaring plugin is NOT reported failed merely because this process mounts nothing", async () => {
    const { lines, restore } = captureLog()
    try {
      await runPluginsCommand(["plugins"])
    } finally {
      restore()
    }
    const out = lines.join("\n")
    // The declared server is a disk fact and IS shown…
    expect(out).toContain("plugin:Cmd_Mkt__proxy:echo")
    // …while the connection verdict — which only a live session can produce —
    // is explicitly not evaluated here. `failed` would be an invented failure.
    const proxyBlock = out.slice(out.indexOf("Cmd Mkt__proxy"))
    expect(proxyBlock).toMatch(/mcp: not evaluated here \(needs a live session\)/)
    expect(proxyBlock).not.toMatch(/mcp: failed/)
    expect(proxyBlock).not.toContain("readiness: failed")
  })

  it("HONESTY: --json carries not-evaluated, never a fabricated failure", async () => {
    const { lines, restore } = captureLog()
    try {
      await runPluginsCommand(["plugins", "--json"])
    } finally {
      restore()
    }
    const doc = JSON.parse(lines.join("\n")) as {
      pluginsRoot: string
      plugins: Array<{ id: string; enabled: boolean; status: string; dimensions: Record<string, string>; declaredCommands: string[]; declaredMcpServers: string[] }>
    }
    expect(doc.pluginsRoot).toBe(join(home, "plugins"))
    const proxy = doc.plugins.find((p) => p.id === "Cmd Mkt__proxy")!
    expect(proxy.status).toBe("not-evaluated")
    expect(proxy.dimensions.mcp).toBe("not-evaluated")
    expect(proxy.declaredMcpServers).toEqual(["plugin:Cmd_Mkt__proxy:echo"])
    const off = doc.plugins.find((p) => p.id === "Cmd Mkt__off")!
    expect(off.enabled).toBe(false)
    expect(off.status).toBe("disabled")
    // Every installed plugin is listed, enabled or not.
    expect(doc.plugins.map((p) => p.id)).toEqual(["Cmd Mkt__hello", "Cmd Mkt__off", "Cmd Mkt__proxy"])
  })

  it("an unsupported frontmatter key surfaces as a diagnostic", async () => {
    const { lines, restore } = captureLog()
    try {
      await runPluginsCommand(["plugins"])
    } finally {
      restore()
    }
    // The SAME sentence run.ts warns with — a key this repo does not honour must
    // not look honoured in the listing either.
    expect(lines.join("\n")).toContain("command hello declares unsupported frontmatter: allowed-tools")
  })

  it("a fresh home with no plugins says so and stays quiet", async () => {
    // No `<home>/plugins/state.json` yet: the listing must not construct a
    // registry that announces rebuilding a state file that never existed (the
    // same defect `hooks list` fixed).
    const fresh = mkdtempSync(join(tmpdir(), "i-harness-plugins-cmd-fresh-"))
    process.env.IH_CONFIG_DIR = fresh
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { lines, restore } = captureLog()
    try {
      expect(await runPluginsCommand(["plugins"])).toBe(0)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      restore()
      warn.mockRestore()
      rmSync(fresh, { recursive: true, force: true })
    }
    expect(lines.join("\n")).toMatch(/no plugins installed/)
  })

  it("a recorded D5 conflict is a static fact this listing CAN show", async () => {
    // `hello` collides with a host command name: enable() records the blocked
    // command on the registry record (D5 — the plugin still enables). That is
    // durable state, which is why a listing with no interaction catalog of its
    // own can still report it.
    const other = mkdtempSync(join(tmpdir(), "i-harness-plugins-cmd-conflict-"))
    const conflictSrc = marketplaceWith({
      clash: (dir) => {
        mkdirSync(join(dir, "commands"), { recursive: true })
        writeFileSync(join(dir, "commands", "hello.md"), "---\ndescription: Collides\n---\n\nDo it.\n", "utf8")
      },
    })
    process.env.IH_CONFIG_DIR = other
    const registry = new PluginRegistry({ root: join(other, "plugins"), existingCommandNames: ["hello"] })
    await registry.addSource(conflictSrc)
    await registry.install("Cmd Mkt__clash")
    await registry.enable("Cmd Mkt__clash")

    const { lines, restore } = captureLog()
    try {
      expect(await runPluginsCommand(["plugins"])).toBe(0)
    } finally {
      restore()
      rmSync(other, { recursive: true, force: true })
      rmSync(conflictSrc, { recursive: true, force: true })
    }
    const out = lines.join("\n")
    expect(out).toContain("blocked: hello")
    expect(out).toContain("already registered by the host")
    // …while the dimension stays honestly not-evaluated: a known conflict does
    // not license a verdict about registration, which is still a live fact.
    expect(out).toContain("commands: not evaluated here (needs a live session)")
  })

  it("refuses a lifecycle verb loudly instead of listing", async () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")) })
    try {
      expect(await runPluginsCommand(["plugins", "enable", "Cmd Mkt__off"])).toBe(1)
    } finally {
      spy.mockRestore()
    }
    expect(errors.join("\n")).toMatch(/read-only/)
    // and nothing was enabled by a READ command
    const registry = new PluginRegistry({ root: join(home, "plugins") })
    expect((await registry.catalog()).plugins.find((p) => p.id === "Cmd Mkt__off")?.enabled).toBe(false)
  })
})
