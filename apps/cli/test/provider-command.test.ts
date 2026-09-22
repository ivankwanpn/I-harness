import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROVIDER_PROTOCOLS, parseProviderArgs, renderProviderList, runProviderCommand } from "../src/provider.ts"
import { PROVIDER_PROTOCOLS as SETTINGS_PROTOCOLS } from "@i-harness/settings"

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

  it("the protocol list IS the settings list — one enum, not a third copy", () => {
    // Identity, not equality: two equal arrays today are two places to edit
    // tomorrow. Settings owns the closed set (settings/src/sections.ts:110);
    // the CLI validates --protocol against the same object.
    expect(PROVIDER_PROTOCOLS).toBe(SETTINGS_PROTOCOLS)
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

  it("list takes no id and no flags, and says so rather than quietly ignoring them", () => {
    // The rule this branch adopted in `models`: a flag a verb cannot READ is
    // refused, not dropped. `provider list deepseek` printed the full list and
    // exited 0, and so did `provider list --base-url X --protocol gemini`.
    expect(parseProviderArgs(["provider", "list", "gw"]).error)
      .toMatch(/list takes no arguments.*every configured route/)
    expect(parseProviderArgs(["provider", "list", "--base-url", "https://gw.example"]).error)
      .toMatch(/--base-url.*list.*every configured route/)
    expect(parseProviderArgs(["provider", "list", "--catalog", "x"]).error)
      .toMatch(/--catalog/)
    expect(parseProviderArgs(["provider", "list"]).error).toBeUndefined()
  })

  it("an empty value is refused for every flag whose field must be a non-empty string", () => {
    // The field these flags write is a non-empty string in settings; an empty
    // one normalizes AWAY (packages/settings/src/index.ts:446-449), so the
    // route lands with no base URL and the adapter falls back to its
    // hard-coded vendor endpoint. The refusal names the flag.
    expect(parseProviderArgs(["provider", "add", "gw", "--base-url", "", "--protocol", "gemini"]).error)
      .toMatch(/--base-url/)
    expect(parseProviderArgs(["provider", "add", "gw", "--base-url", "   ", "--protocol", "gemini"]).error)
      .toMatch(/--base-url/)
    expect(parseProviderArgs(["provider", "add", "gw", "--base-url", "https://gw.example", "--protocol", "gemini", "--catalog", ""]).error)
      .toMatch(/--catalog/)
    expect(parseProviderArgs(["provider", "add", "gw", "--base-url", "https://gw.example", "--protocol", "gemini", "--display-name", ""]).error)
      .toMatch(/--display-name/)
    expect(parseProviderArgs(["provider", "set", "gw", "--models-url", ""]).error)
      .toMatch(/--models-url/)
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
    // The title is a measured claim: the exit code alone would pass for any
    // failure, including one that names no verb.
    const lines: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")) })
    try {
      expect(await runProviderCommand(["provider", "add", "gw", "--base-url", "https://other.example", "--protocol", "gemini"])).toBe(1)
    } finally {
      spy.mockRestore()
    }
    expect(lines.join("\n")).toContain("i-harness provider set gw")
  })

  it("list takes no arguments at all — an id or a flag is refused, not ignored", async () => {
    await runProviderCommand(["provider", "add", "gw", "--base-url", "https://gw.example", "--protocol", "gemini"])
    expect(await runProviderCommand(["provider", "list"])).toBe(0)
    expect(await runProviderCommand(["provider", "list", "gw"])).toBe(1)
    expect(await runProviderCommand(["provider", "list", "--catalog", "x"])).toBe(1)
  })

  it("set with no flags says there was nothing to change — it is not an update", async () => {
    await runProviderCommand(["provider", "add", "gw", "--base-url", "https://gw.example", "--protocol", "gemini"])
    const lines: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")) })
    try {
      expect(await runProviderCommand(["provider", "set", "gw"])).toBe(0)
    } finally {
      spy.mockRestore()
    }
    const out = lines.join("\n")
    expect(out).toContain("nothing to change")
    expect(out).not.toContain("updated")
    // The no-op is still a no-op: the route keeps exactly what it had.
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw)
      .toEqual({ baseURL: "https://gw.example", protocol: "gemini" })
  })

  it("an empty --base-url is refused BEFORE the write — a route with no endpoint posts to a vendor", async () => {
    // Measured failure: `add gw --base-url ""` passed both guards, persisted
    // {baseURL: ""}, settings normalized it away, and it STILL printed
    // `created provider "gw"` — after which every adapter falls back to its
    // hard-coded vendor endpoint (llm-openai-compatible/src/index.ts:93) with
    // the user's prompt and stored credential.
    expect(await runProviderCommand(["provider", "add", "gw", "--base-url", "", "--protocol", "gemini"])).toBe(1)
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw).toBeUndefined()

    await runProviderCommand(["provider", "add", "gw", "--base-url", "https://gw.example", "--protocol", "gemini"])
    // `set` is the worse direction: it CLEARS a working endpoint and says
    // `updated provider "gw"`.
    expect(await runProviderCommand(["provider", "set", "gw", "--base-url", " "])).toBe(1)
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw.baseURL).toBe("https://gw.example")
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

  it("shows the row's own output cap on a model line, and nothing when the row set none", () => {
    // Same ruling as `models list` (the two listings must not disagree about
    // the same row): the card is the model's documented ceiling; the row's own
    // cap — user-written or refresh-persisted — is what a request will actually
    // carry, so the two are said separately. Absent ⇒ nothing printed: an unset
    // switch is OFF, not 0.
    const out = renderProviderList(
      [{
        id: "deepseek1", displayName: "DeepSeek", protocol: "anthropic-messages",
        configured: true, auth: { configured: true, writable: true },
        models: [{ id: "deepseek-flash", maxTokens: 409_600 }, { id: "keep-me" }],
        discovery: "available", cardFamily: "deepseek", catalog: "deepseek",
      }],
      { generatedAt: "2026-09-19", families: [{ family: "deepseek", source: "DeepSeek API docs" }] },
    )

    expect(out).toContain("      deepseek-flash  (1048576 / 384000)  set: 409600")
    // The row that never set one: its whole line is pinned, so neither a
    // `set: undefined` nor a defaulted 0 can pass as "shows the value".
    const keepLine = out.split("\n").find((line) => line.includes("keep-me")) ?? ""
    expect(keepLine).toBe("      keep-me  (no card)")
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

  const noProvenance = { generatedAt: "2026-09-19", families: [] }

  it("names a route that declares no protocol of its own — not a wire nobody declared", () => {
    // Before Task 1 this row printed [openai-completions], a wire NOBODY
    // declared; after its tail was removed it printed [undefined]. Both are
    // lies in the same shape as a success message for nothing. The line states
    // what is true of the ROUTE (and names the verb that declares one) — it
    // must NOT claim the route cannot be used: resolution tries the selection
    // and the model row before the route, so a protocol-less route still
    // resolves when either names a wire (measured in models-command.test.ts).
    const out = renderProviderList(
      [{
        id: "gateway", displayName: "Gateway", configured: true,
        auth: { configured: true, writable: true }, models: [{ id: "m" }],
        discovery: "available", cardFamily: "gateway",
      }],
      noProvenance,
    )

    expect(out).toContain("gateway")
    // NOT `not.toContain("openai-completions")`: the repair NAMES the set (a
    // metavariable, so no protocol is picked for a user who never chose one),
    // and that set's first member IS `openai-completions` — asserting the
    // string never appears would forbid the very tail the fix must print.
    // What must not appear is a WIRE in the route's own bracket. Both pre-fix
    // renderings are pinned: the defaulted tail (`gateway  [openai-completions]`)
    // and Task 1's `gateway  [undefined]`.
    expect(out).not.toContain("gateway  [openai-completions]")
    expect(out).not.toContain("gateway  [undefined]")
    expect(out).toContain("gateway  [no protocol of its own")
    // `toContain("no protocol")` still passes as a substring of the new
    // sentence — it stops guarding anything, so the exact claim is pinned and
    // the deleted verdict is pinned as absent.
    expect(out).not.toContain("cannot be used")
    expect(out).toContain("i-harness provider set gateway --protocol")
    // `toContain("i-harness provider set gateway --protocol")` passes even if
    // the tail degrades to ONE fixed protocol, which would pick a wire for a
    // user who never chose one — the metavariable's whole point. The set is
    // pinned by content (the same object the renderer reads, from ./provider.ts).
    expect(out).toContain(`<one of: ${PROVIDER_PROTOCOLS.join(" | ")}>`)
  })

  it("a route that DOES declare one still prints it, unchanged", () => {
    const out = renderProviderList(
      [{
        id: "gateway", displayName: "Gateway", protocol: "gemini", configured: true,
        auth: { configured: true, writable: true }, models: [{ id: "m" }],
        discovery: "available", cardFamily: "gateway",
      }],
      noProvenance,
    )

    expect(out).toContain("[gemini]")
  })

  it("a modelless route gets the next step that can actually run", () => {
    // Same rule as `models list`'s hint: `models probe` refuses in two states
    // — no declared protocol (nothing to shape the request with) and
    // manual-only discovery (bedrock has no discovery endpoint) — so each
    // state names the verb that can actually run instead. ALL THREE branches
    // are pinned as WHOLE lines, the unchanged `available` arm included — the
    // route line above the hint names the same command, so a substring
    // assertion would pass on that text alone, and an unpinned arm is one a
    // future edit can collapse silently.
    const protocolLess = renderProviderList(
      [{
        id: "gateway", displayName: "Gateway", configured: true,
        auth: { configured: true, writable: true }, models: [],
        discovery: "available", cardFamily: "gateway",
      }],
      noProvenance,
    )
    expect(protocolLess).toContain(`      (none — declare a protocol first: i-harness provider set gateway --protocol <one of: ${PROVIDER_PROTOCOLS.join(" | ")}>)`)
    expect(protocolLess).not.toContain("models probe gateway")

    const manualOnly = renderProviderList(
      [{
        id: "br", displayName: "Bedrock", protocol: "bedrock", configured: true,
        auth: { configured: true, writable: true }, models: [],
        discovery: "manual-only", cardFamily: "br",
      }],
      noProvenance,
    )
    expect(manualOnly).toContain("      (none — discovery is unavailable for this route; add one: i-harness models add br <id...>)")
    expect(manualOnly).not.toContain("models probe br")

    const declared = renderProviderList(
      [{
        id: "gateway", displayName: "Gateway", protocol: "gemini", configured: true,
        auth: { configured: true, writable: true }, models: [],
        discovery: "available", cardFamily: "gateway",
      }],
      noProvenance,
    )
    expect(declared).toContain("      (none — try: i-harness models probe gateway)")
  })
})
