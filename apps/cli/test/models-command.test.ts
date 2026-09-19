import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseModelsArgs, parseTokenValue, probeRequestFor, renderModels, runModelsCommand } from "../src/models.ts"

describe("parseTokenValue", () => {
  it("reads plain integers, k/m suffixes, and `auto`", () => {
    expect(parseTokenValue("131072")).toEqual({ kind: "value", value: 131_072 })
    expect(parseTokenValue("128k")).toEqual({ kind: "value", value: 131_072 })
    expect(parseTokenValue("1m")).toEqual({ kind: "value", value: 1_000_000 })
    expect(parseTokenValue("auto")).toEqual({ kind: "clear" })
  })

  it("refuses anything else rather than guessing", () => {
    expect(parseTokenValue("128kb").kind).toBe("error")
    expect(parseTokenValue("0").kind).toBe("error")
    expect(parseTokenValue("-1").kind).toBe("error")
    expect(parseTokenValue("").kind).toBe("error")
  })
})

describe("parseModelsArgs", () => {
  it("reads the subcommands", () => {
    expect(parseModelsArgs(["models"])).toEqual({ subcommand: "list", ids: [], values: {} })
    expect(parseModelsArgs(["models", "probe", "gw"])).toEqual({ subcommand: "probe", route: "gw", ids: [], values: {} })
    expect(parseModelsArgs(["models", "add", "gw", "a", "b", "--context-window", "1m"]))
      .toEqual({ subcommand: "add", route: "gw", ids: ["a", "b"], values: { contextWindow: { kind: "value", value: 1_000_000 } } })
    expect(parseModelsArgs(["models", "set", "gw", "a", "--max-tokens", "auto"]))
      .toEqual({ subcommand: "set", route: "gw", ids: ["a"], values: { maxTokens: { kind: "clear" } } })
  })

  it("a bad value is an error, not a silent skip", () => {
    expect(parseModelsArgs(["models", "set", "gw", "a", "--context-window", "1_000_000"]).values.contextWindow)
      .toEqual({ kind: "value", value: 1_000_000 })
    expect(parseModelsArgs(["models", "set", "gw", "a", "--context-window", "huge"]).error).toMatch(/huge/)
  })

  it("a bare first token is a ROUTE, not an unknown subcommand", () => {
    // `models myroute` is the list-one-route form, so a bare token cannot be
    // diagnosed as an unknown subcommand — it IS a route until a second one
    // proves otherwise, and that second one is the error.
    expect(parseModelsArgs(["models", "myroute"]))
      .toEqual({ subcommand: "list", route: "myroute", ids: [], values: {} })
    expect(parseModelsArgs(["models", "discovr", "gw"]).error).toMatch(/unexpected extra argument/)
  })

  it("missing arguments are reported", () => {
    expect(parseModelsArgs(["models", "add", "gw"]).error).toMatch(/at least one model id/)
    expect(parseModelsArgs(["models", "rm", "gw", "a", "b"]).error).toMatch(/exactly one model id/)
  })

  it("--protocol takes one of the five, or `auto` — never a guess", () => {
    expect(parseModelsArgs(["models", "set", "gw", "a", "--protocol", "anthropic-messages"]).values.protocol)
      .toBe("anthropic-messages")
    expect(parseModelsArgs(["models", "set", "gw", "a", "--protocol", "auto"]).values.protocol).toBeNull()
    expect(parseModelsArgs(["models", "set", "gw", "a", "--protocol", "grpc"]).error).toMatch(/grpc/)
    expect(parseModelsArgs(["models", "probe", "gw", "--protocol", "gemini"]).values.protocol).toBe("gemini")
  })

  it("a flag the verb cannot use is refused, not silently dropped", () => {
    // Same class as the probe override: the flag used to be parsed for EVERY
    // verb and ignored by the ones with no reader for it.
    expect(parseModelsArgs(["models", "rm", "gw", "a", "--protocol", "gemini"]).error)
      .toMatch(/--protocol is not a flag of "rm".*probe, add, set/)
    expect(parseModelsArgs(["models", "list", "--context-window", "1m"]).error)
      .toMatch(/--context-window is not a flag of "list"/)
    expect(parseModelsArgs(["models", "use", "gw:deepseek-flash", "--context-window", "1m"]).error)
      .toMatch(/--context-window/)
    // The legal homes still accept them, wherever the flag sits.
    expect(parseModelsArgs(["models", "probe", "gw", "--protocol", "gemini"]).error).toBeUndefined()
    expect(parseModelsArgs(["models", "--protocol", "gemini", "probe", "gw"]).error).toBeUndefined()
    expect(parseModelsArgs(["models", "add", "gw", "a", "--context-window", "1m"]).error).toBeUndefined()
  })

  it("use trims both halves before the empty check", () => {
    // `use "gw: "` passed the exact-empty guard and wrote a one-space model id.
    expect(parseModelsArgs(["models", "use", "gw: "]).error).toMatch(/BOTH a provider and a model/)
    expect(parseModelsArgs(["models", "use", " :deepseek-flash"]).error).toMatch(/BOTH a provider and a model/)
    // Whitespace around the halves is not part of either name.
    expect(parseModelsArgs(["models", "use", " gw : deepseek-flash "]))
      .toEqual({ subcommand: "use", route: "gw:deepseek-flash", ids: [], values: {} })
  })

  it("probe's --protocol is a one-off request parameter, and `auto` means the route's", () => {
    expect(probeRequestFor({ protocol: "gemini" })).toEqual({ protocol: "gemini" })
    // On a request that writes nothing, "the route decides" and "no override"
    // are the same sentence — so `auto` is the default, not a refusal.
    expect(probeRequestFor({ protocol: null })).toEqual({})
    expect(probeRequestFor({})).toEqual({})
  })
})

describe("renderModels", () => {
  it("shows each model's card, its retired names, and flags a route with no card at all", () => {
    const out = renderModels([
      {
        id: "deepseek1", cardFamily: "deepseek", declared: true, protocol: "anthropic-messages", discovery: "available",
        models: [{ id: "deepseek-flash", card: { contextWindow: 1_048_576, maxOutputTokens: 384_000 }, aliases: ["deepseek-v4-flash"] }],
      },
      {
        id: "gw", cardFamily: "gw", declared: false, protocol: "openai-completions", discovery: "available",
        models: [{ id: "mystery", card: undefined, aliases: [] }],
      },
    ])
    expect(out).toContain("deepseek1")
    expect(out).toContain("1048576 / 384000")
    expect(out).toContain("deepseek-v4-flash")
    // The D1/D2 diagnosis, stated where a human will see it.
    expect(out).toContain("no card resolves for: gw")
  })

  it("names a row's own protocol when it differs from the route's, and the route's discovery", () => {
    // Spec §4: this read shows 每顆模型命中哪張卡、實際協議、能不能 discovery.
    // Before this, the row printed the ROUTE's protocol once and no discovery
    // indicator, so a `models set --protocol` override was invisible in every
    // read verb — the write landed and nothing could show it.
    const out = renderModels([
      {
        id: "gw", cardFamily: "gw", declared: false, protocol: "openai-completions", discovery: "available",
        models: [
          { id: "anthropic-row", card: undefined, aliases: [], protocol: "anthropic-messages" },
          { id: "plain-row", card: undefined, aliases: [] },
        ],
      },
      {
        id: "br", cardFamily: "br", declared: false, protocol: "bedrock", discovery: "manual-only",
        models: [],
      },
    ])
    expect(out).toContain("discovery: available")
    expect(out).toContain("discovery: manual-only")
    expect(out).toContain("anthropic-row  (no card)  protocol: anthropic-messages")
    // Absent means the route's decision — a row that overrode nothing adds no line.
    expect(out).not.toContain("plain-row  (no card)  protocol:")
  })
})

describe("runModelsCommand", () => {
  let home: string
  let previous: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "i-harness-modelscmd-"))
    previous = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = home
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      llm: {
        providers: {
          gw: { baseURL: "https://gw.example", protocol: "openai-completions", apiKeyEnv: "GW_API_KEY", catalog: "deepseek", models: [{ id: "keep-me" }] },
        },
        defaultModel: { provider: "", model: "" },
      },
    }), "utf8")
    writeFileSync(join(home, "credentials.json"), JSON.stringify({ GW_API_KEY: "fixture-key" }), "utf8")
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previous
    rmSync(home, { recursive: true, force: true })
  })

  it("add writes only the ids given, with the numbers given", async () => {
    expect(await runModelsCommand(["models", "add", "gw", "deepseek-flash", "--context-window", "128k"])).toBe(0)

    const models = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw.models
    expect(models).toEqual([{ id: "keep-me" }, { id: "deepseek-flash", contextWindow: 131_072 }])
  })

  it("set changes one row; `auto` clears the override back to the card", async () => {
    await runModelsCommand(["models", "add", "gw", "deepseek-flash", "--context-window", "128k"])
    expect(await runModelsCommand(["models", "set", "gw", "deepseek-flash", "--context-window", "auto"])).toBe(0)

    const models = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw.models
    expect(models).toEqual([{ id: "keep-me" }, { id: "deepseek-flash" }])
  })

  it("a --max-tokens above the card's maxOutputTokens warns on stderr and does NOT block", async () => {
    // Spec §5: 警告，不阻擋，exit 0. The card is documentation, not a wall —
    // the standing stance is no clamping (fail loud at the model end instead).
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")) })
    try {
      // deepseek-flash's card caps output at 384,000; 400k = 409,600.
      expect(await runModelsCommand(["models", "add", "gw", "deepseek-flash", "--max-tokens", "400k"])).toBe(0)
    } finally {
      spy.mockRestore()
    }
    expect(errors.join("\n")).toContain("deepseek-flash")
    expect(errors.join("\n")).toMatch(/409600/)
    expect(errors.join("\n")).toMatch(/384000/)
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw.models)
      .toContainEqual({ id: "deepseek-flash", maxTokens: 409_600 })

    // `set` is the same check, and the boundary is "above", not "at".
    const atCap: string[] = []
    const spy2 = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { atCap.push(args.join(" ")) })
    try {
      expect(await runModelsCommand(["models", "set", "gw", "deepseek-flash", "--max-tokens", "384000"])).toBe(0)
    } finally {
      spy2.mockRestore()
    }
    expect(atCap.join("\n")).toBe("")
    const overCap: string[] = []
    const spy3 = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { overCap.push(args.join(" ")) })
    try {
      expect(await runModelsCommand(["models", "set", "gw", "deepseek-flash", "--max-tokens", "400k"])).toBe(0)
    } finally {
      spy3.mockRestore()
    }
    expect(overCap.join("\n")).toContain("409600")
  })

  it("set with no flags says there was nothing to change", async () => {
    await runModelsCommand(["models", "add", "gw", "deepseek-flash"])
    const lines: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")) })
    try {
      expect(await runModelsCommand(["models", "set", "gw", "deepseek-flash"])).toBe(0)
    } finally {
      spy.mockRestore()
    }
    expect(lines.join("\n")).toContain("nothing to change")
    expect(lines.join("\n")).not.toContain("updated")
  })

  it("a route that does not exist is named, not reported as an empty config", async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")) })
    try {
      expect(await runModelsCommand(["models", "gww"])).toBe(0)
    } finally {
      spy.mockRestore()
    }
    const out = lines.join("\n")
    expect(out).toContain('no route "gww"')
    expect(out).toContain("gw")
    expect(out).not.toContain("no provider routes configured")
  })

  it("the genuinely-empty case still says no routes are configured", async () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      llm: { providers: {}, defaultModel: { provider: "", model: "" } },
    }), "utf8")
    const lines: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")) })
    try {
      expect(await runModelsCommand(["models", "gww"])).toBe(0)
    } finally {
      spy.mockRestore()
    }
    expect(lines.join("\n")).toContain("no provider routes configured")
  })

  it("rm takes a row out; an absent row is a failure, not a shrug", async () => {
    expect(await runModelsCommand(["models", "rm", "gw", "keep-me"])).toBe(0)
    expect(await runModelsCommand(["models", "rm", "gw", "keep-me"])).toBe(1)
  })

  it("the read path shows the row protocol written by `models set --protocol`", async () => {
    await runModelsCommand(["models", "add", "gw", "deepseek-flash"])
    expect(await runModelsCommand(["models", "set", "gw", "deepseek-flash", "--protocol", "anthropic-messages"])).toBe(0)

    const lines: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")) })
    try {
      expect(await runModelsCommand(["models", "list", "gw"])).toBe(0)
    } finally {
      spy.mockRestore()
    }

    const out = lines.join("\n")
    // The route line carries the discovery answer; the row line carries the
    // override the write verb landed.
    expect(out).toContain("discovery: available")
    expect(out).toContain("deepseek-flash  (1048576 / 384000)  protocol: anthropic-messages")
  })

  it("set can declare a per-model protocol, and `auto` clears it back to the route's", async () => {
    await runModelsCommand(["models", "add", "gw", "deepseek-flash"])

    expect(await runModelsCommand(["models", "set", "gw", "deepseek-flash", "--protocol", "anthropic-messages"])).toBe(0)
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw.models)
      .toEqual([{ id: "keep-me" }, { id: "deepseek-flash", protocol: "anthropic-messages" }])

    expect(await runModelsCommand(["models", "set", "gw", "deepseek-flash", "--protocol", "auto"])).toBe(0)
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw.models)
      .toEqual([{ id: "keep-me" }, { id: "deepseek-flash" }])
  })

  it("use writes llm.defaultModel", async () => {
    expect(await runModelsCommand(["models", "use", "gw:deepseek-flash"])).toBe(0)
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.defaultModel)
      .toEqual({ provider: "gw", model: "deepseek-flash" })
  })

  it("use carries --reasoning-effort into llm.defaultModel", async () => {
    expect(await runModelsCommand(["models", "use", "gw:deepseek-flash", "--reasoning-effort", "high"])).toBe(0)
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.defaultModel)
      .toEqual({ provider: "gw", model: "deepseek-flash", reasoningEffort: "high" })
  })

  it("use always prints the resulting reasoning effort, and `use` replaces the WHOLE selection", async () => {
    // setDefaultModel replaces defaultModel wholesale, so re-running
    // `models use gw:deepseek-flash` to change the model DROPS an effort set
    // earlier. That is this verb's documented rule (unlike `models set`, where
    // an omitted flag leaves the field alone) — and the ruling is to make the
    // replacement VISIBLE rather than to add a getter: the printed line states
    // the resulting effort, including when there is none.
    const lines: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")) })
    try {
      expect(await runModelsCommand(["models", "use", "gw:deepseek-flash", "--reasoning-effort", "high"])).toBe(0)
      expect(await runModelsCommand(["models", "use", "gw:deepseek-flash"])).toBe(0)
    } finally {
      spy.mockRestore()
    }

    const out = lines.join("\n")
    expect(out).toContain("default model: gw:deepseek-flash (reasoning effort: high)")
    expect(out).toContain("default model: gw:deepseek-flash (reasoning effort: none)")
    // The read-back: the second run really did clear the field.
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.defaultModel)
      .toEqual({ provider: "gw", model: "deepseek-flash" })
  })

  it("the usage line says `use` replaces the whole default selection", async () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")) })
    try {
      // `models help` is not a verb (a bare token is a ROUTE); the usage text
      // reaches stderr on any refusal, which is where this claim must hold.
      expect(await runModelsCommand(["models", "--help"])).toBe(1)
    } finally {
      spy.mockRestore()
    }
    expect(errors.join("\n")).toMatch(/use <route>:<model>.*replaces the whole default selection/)
  })

  it("use refuses an empty half — a typo must not unset a working default", async () => {
    // The failure mode: `use gw:` (or a script's unset $MODEL) wrote
    // { provider: "gw", model: "" }, printed success, and the next run said
    // "No model configured" — a working default destroyed by a typo.
    expect(await runModelsCommand(["models", "use", "gw:deepseek-flash"])).toBe(0)
    expect(await runModelsCommand(["models", "use", "gw:"])).toBe(1)
    expect(await runModelsCommand(["models", "use", ":deepseek-flash"])).toBe(1)

    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.defaultModel)
      .toEqual({ provider: "gw", model: "deepseek-flash" })
  })

  it("add says what it actually does to a BARE existing row: the flags fill the gaps", async () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      llm: {
        providers: {
          gw: { baseURL: "https://gw.example", protocol: "openai-completions", catalog: "deepseek", models: [{ id: "bare" }] },
        },
        defaultModel: { provider: "", model: "" },
      },
    }), "utf8")
    const lines: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")) })
    try {
      expect(await runModelsCommand(["models", "add", "gw", "bare", "--context-window", "128k"])).toBe(0)
    } finally {
      spy.mockRestore()
    }

    // The row had no contextWindow, so the flag FILLS it — "left alone" was false.
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw.models)
      .toEqual([{ id: "bare", contextWindow: 131_072 }])
    expect(lines.join("\n")).not.toContain("left alone")
    expect(lines.join("\n")).toContain("fill only the gaps")
  })

  it("a route that cannot be probed fails loudly (bedrock is manual-only)", async () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      llm: { providers: { br: { baseURL: "https://br.example", protocol: "bedrock", models: [] } }, defaultModel: { provider: "", model: "" } },
    }), "utf8")
    expect(await runModelsCommand(["models", "probe", "br"])).toBe(1)
    // The one-off override shapes a REQUEST; it cannot give the route a
    // discovery endpoint it does not have.
    expect(await runModelsCommand(["models", "probe", "br", "--protocol", "openai-completions"])).toBe(1)
  })
})
