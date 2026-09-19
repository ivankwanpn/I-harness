import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseModelsArgs, parseTokenValue, renderModels, runModelsCommand } from "../src/models.ts"

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
  })
})

describe("renderModels", () => {
  it("shows each model's card, its retired names, and flags a route with no card at all", () => {
    const out = renderModels([
      {
        id: "deepseek1", cardFamily: "deepseek", declared: true, protocol: "anthropic-messages",
        models: [{ id: "deepseek-flash", card: { contextWindow: 1_048_576, maxOutputTokens: 384_000 }, aliases: ["deepseek-v4-flash"] }],
      },
      {
        id: "gw", cardFamily: "gw", declared: false, protocol: "openai-completions",
        models: [{ id: "mystery", card: undefined, aliases: [] }],
      },
    ])
    expect(out).toContain("deepseek1")
    expect(out).toContain("1048576 / 384000")
    expect(out).toContain("deepseek-v4-flash")
    // The D1/D2 diagnosis, stated where a human will see it.
    expect(out).toContain("no card resolves for: gw")
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

  it("rm takes a row out; an absent row is a failure, not a shrug", async () => {
    expect(await runModelsCommand(["models", "rm", "gw", "keep-me"])).toBe(0)
    expect(await runModelsCommand(["models", "rm", "gw", "keep-me"])).toBe(1)
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

  it("a route that cannot be probed fails loudly (bedrock is manual-only)", async () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      llm: { providers: { br: { baseURL: "https://br.example", protocol: "bedrock", models: [] } }, defaultModel: { provider: "", model: "" } },
    }), "utf8")
    expect(await runModelsCommand(["models", "probe", "br"])).toBe(1)
  })
})
