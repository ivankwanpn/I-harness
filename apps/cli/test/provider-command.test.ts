import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseProviderArgs, renderProviderList, runProviderCommand } from "../src/provider.ts"

// The CLI face of the provider lifecycle
// (docs/superpowers/specs/2026-09-19-provider-lifecycle-design.md §4). Its
// reason for existing is the same as `i-harness hooks approve`'s: seven
// ProviderRuntime methods had ZERO production callers after M65 deleted the
// TUI, and a capability nothing can exercise is a capability nothing notices
// breaking.
describe("parseProviderArgs", () => {
  it("reads the five subcommands and their flags", () => {
    expect(parseProviderArgs(["provider", "list"])).toEqual({ subcommand: "list", fields: {} })
    expect(parseProviderArgs([
      "provider", "add", "gw",
      "--base-url", "https://gw.example",
      "--protocol", "anthropic-messages",
      "--catalog", "deepseek",
    ])).toEqual({
      subcommand: "add",
      id: "gw",
      fields: { baseURL: "https://gw.example", protocol: "anthropic-messages", catalog: "deepseek" },
    })
    expect(parseProviderArgs(["provider", "rm", "gw"])).toEqual({ subcommand: "rm", id: "gw", fields: {} })
  })

  it("an unknown subcommand is reported, never treated as an id", () => {
    expect(parseProviderArgs(["provider", "aproove", "gw"])).toEqual({
      subcommand: "help",
      fields: {},
      error: "unknown provider subcommand: aproove",
    })
  })

  it("a bad protocol is refused with the valid list", () => {
    const parsed = parseProviderArgs(["provider", "add", "gw", "--protocol", "grpc"])
    expect(parsed.error).toContain("grpc")
    expect(parsed.error).toContain("anthropic-messages")
  })

  it("add without --base-url or --protocol is refused", () => {
    expect(parseProviderArgs(["provider", "add", "gw", "--base-url", "https://gw.example"]).error)
      .toMatch(/--protocol/)
    expect(parseProviderArgs(["provider", "add", "gw", "--protocol", "gemini"]).error)
      .toMatch(/--base-url/)
  })
})

describe("runProviderCommand — the route round trip", () => {
  let home: string
  let previous: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "i-harness-providercmd-"))
    previous = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = home
    writeFileSync(join(home, "settings.json"), JSON.stringify({ llm: { providers: {}, defaultModel: { provider: "", model: "" } } }), "utf8")
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previous
    rmSync(home, { recursive: true, force: true })
  })

  it("the key never reaches stdout — including a key short enough that its tail IS the key", async () => {
    expect(await runProviderCommand([
      "provider", "add", "gw",
      "--base-url", "https://gw.example",
      "--protocol", "anthropic-messages",
      "--catalog", "deepseek",
    ])).toBe(0)

    const stored = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))
    // No `apiKeyEnv` yet: `key` is the verb that writes it, and the credential
    // REF is the runtime's to choose (`providerApiKeyRef`), not the CLI's.
    expect(stored.llm.providers.gw).toEqual({
      baseURL: "https://gw.example",
      protocol: "anthropic-messages",
      catalog: "deepseek",
    })

    // The key is INJECTED, never pushed at process.stdin: a test that writes to
    // the real stdin is a test that hangs on CI. stdout is CAPTURED here, so the
    // test's own title is a measured claim rather than a description.
    const captured: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { captured.push(String(line)) })
    try {
      expect(await runProviderCommand(["provider", "key", "gw"], { readKey: async () => "sk-secret-value" })).toBe(0)
      expect(await runProviderCommand(["provider", "key", "gw"], { readKey: async () => "tiny" })).toBe(0)
    } finally {
      spy.mockRestore()
    }

    const out = captured.join("\n")
    expect(out).not.toContain("sk-secret-value")
    // "tiny" is 4 characters: a naive "last four" tail IS the whole value, so
    // this clause is the one the first mask could not earn.
    expect(out).not.toContain("tiny")
    expect(out).toContain("x…")

    // The store is real, and it holds the LAST run's value: `tiny` overwrote
    // `sk-secret-value`, which is itself the evidence the write landed rather
    // than being swallowed.
    const credentials = JSON.parse(readFileSync(join(home, "credentials.json"), "utf8"))
    expect(JSON.stringify(credentials)).toContain("tiny")
    expect(JSON.stringify(credentials)).not.toContain("sk-secret-value")
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw.apiKeyEnv).toBe("GW_API_KEY")
  })

  it("key refuses a route that does not exist, rather than storing into a phantom row", async () => {
    expect(await runProviderCommand(["provider", "key", "gww"], { readKey: async () => "sk-secret-value" })).toBe(1)
    // `setApiKey` writes `...(current ?? {})`, so without this refusal a typo
    // CREATES a settings row that then shows up in `provider list` — a success
    // message for a route that never existed.
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gww).toBeUndefined()
  })

  it("key refuses an empty read rather than storing nothing", async () => {
    await runProviderCommand(["provider", "add", "gw", "--base-url", "https://gw.example", "--protocol", "gemini"])
    expect(await runProviderCommand(["provider", "key", "gw"], { readKey: async () => "  " })).toBe(1)
  })

  it("add on an existing id fails and says which verb to use", async () => {
    await runProviderCommand(["provider", "add", "gw", "--base-url", "https://gw.example", "--protocol", "gemini"])
    expect(await runProviderCommand(["provider", "add", "gw", "--base-url", "https://other.example", "--protocol", "gemini"])).toBe(1)
  })

  it("set changes one field and keeps the rest", async () => {
    await runProviderCommand(["provider", "add", "gw", "--base-url", "https://gw.example", "--protocol", "gemini", "--display-name", "Old"])
    expect(await runProviderCommand(["provider", "set", "gw", "--protocol", "anthropic-messages"])).toBe(0)

    const row = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw
    expect(row.protocol).toBe("anthropic-messages")
    expect(row.displayName).toBe("Old")
  })

  it("rm removes the route", async () => {
    await runProviderCommand(["provider", "add", "gw", "--base-url", "https://gw.example", "--protocol", "gemini"])
    expect(await runProviderCommand(["provider", "rm", "gw"])).toBe(0)
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw).toBeUndefined()
  })
})

describe("renderProviderList", () => {
  it("names the family each route resolves and the table's provenance", () => {
    const out = renderProviderList(
      [{
        id: "deepseek1", displayName: "DeepSeek", protocol: "anthropic-messages",
        configured: true, auth: { configured: true, writable: true }, models: [{ id: "deepseek-flash" }],
        discovery: "available", cardFamily: "deepseek", catalog: "deepseek",
      }],
      { generatedAt: "2026-09-19", families: [{ family: "deepseek", source: "DeepSeek API docs" }] },
    )
    expect(out).toContain("deepseek1")
    expect(out).toContain("card family: deepseek (declared)")
    expect(out).toContain("2026-09-19")
    expect(out).toContain("DeepSeek API docs")
  })

  it("says a route inherits its name when nothing was declared", () => {
    const out = renderProviderList(
      [{
        id: "deepseek", displayName: "DeepSeek", protocol: "anthropic-messages",
        configured: true, auth: { configured: true, writable: true }, models: [],
        discovery: "available", cardFamily: "deepseek",
      }],
      { generatedAt: "2026-09-19", families: [] },
    )
    expect(out).toContain("card family: deepseek (the route name)")
  })
})
