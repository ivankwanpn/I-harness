import { describe, expect, it } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import {
  createPromptCommand,
  listCommandNames,
  listCommands,
  registerCommand,
  registerPromptCommand,
  runCommand,
} from "../src/index.ts"

function makeCtx(): PluginContext {
  return createContext()
}

// The format gap, 2026-09-17 spec §1.2: `runCommand` returned a bare string, so
// "hand this text to the model" and "show this text to the user" were the same
// value. The outcome is now explicit, and these tests pin the distinction.
describe("prompt-expanded commands (the format gap)", () => {
  it("a handler command's outcome is a reply", async () => {
    const ctx = makeCtx()
    registerCommand(ctx, { name: "theme", execute: async () => "theme set" })
    expect(await runCommand(ctx, "theme", "dark")).toEqual({ kind: "reply", text: "theme set" })
  })

  it("a prompt command's outcome is a prompt — the text is for the model, not the user", async () => {
    const ctx = makeCtx()
    registerPromptCommand(ctx, { name: "review", expand: () => "## Your Task\nReview the diff." })
    expect(await runCommand(ctx, "review", "")).toEqual({
      kind: "prompt",
      text: "## Your Task\nReview the diff.",
    })
  })

  it("both kinds are discoverable, and a descriptor carries no handler and no body", () => {
    const ctx = makeCtx()
    registerCommand(ctx, { name: "theme", description: "Set the theme", execute: async () => "x" })
    registerPromptCommand(ctx, { name: "review", description: "Review", expand: () => "body" })
    expect(listCommands(ctx)).toEqual([
      { name: "review", description: "Review" },
      { name: "theme", description: "Set the theme" },
    ])
    expect(listCommandNames(ctx)).toEqual(["review", "theme"])
  })

  it("registerPromptCommand rejects a name the parser could never dispatch", () => {
    const ctx = makeCtx()
    expect(() => registerPromptCommand(ctx, { name: "Review", expand: () => "x" })).toThrow(TypeError)
  })

  it("an unknown name is fail-loud for both kinds", async () => {
    const ctx = makeCtx()
    await expect(runCommand(ctx, "nope", "")).rejects.toThrow(/unknown command/i)
  })

  it("a prompt command with the same name replaces a handler command (one registry)", async () => {
    const ctx = makeCtx()
    registerCommand(ctx, { name: "x", execute: async () => "handler" })
    registerPromptCommand(ctx, { name: "x", expand: () => "prompt" })
    expect(await runCommand(ctx, "x", "")).toEqual({ kind: "prompt", text: "prompt" })
    expect(listCommandNames(ctx)).toEqual(["x"])
  })
})

describe("createPromptCommand — $ARGUMENTS substitution (spec §2.3)", () => {
  it("replaces $ARGUMENTS with the invocation input", () => {
    const cmd = createPromptCommand({ name: "review", body: "Review $ARGUMENTS carefully." })
    expect(cmd.expand("the diff", {} as PluginContext)).toBe("Review the diff carefully.")
  })

  it("replaces every occurrence", () => {
    const cmd = createPromptCommand({ name: "x", body: "$ARGUMENTS then $ARGUMENTS" })
    expect(cmd.expand("a", {} as PluginContext)).toBe("a then a")
  })

  it("leaves the body untouched when there is no $ARGUMENTS — the input is then unused", () => {
    const cmd = createPromptCommand({ name: "plan", body: "## Your Task\nPlan it." })
    expect(cmd.expand("ignored", {} as PluginContext)).toBe("## Your Task\nPlan it.")
  })

  it("carries description and argumentHints through to the command", () => {
    const cmd = createPromptCommand({
      name: "review",
      description: "Review a change",
      argumentHints: "[path]",
      body: "Review $ARGUMENTS",
    })
    expect(cmd.name).toBe("review")
    expect(cmd.description).toBe("Review a change")
    expect(cmd.argumentHints).toBe("[path]")
  })

  it("an empty input is a legal substitution (not a missing one)", () => {
    const cmd = createPromptCommand({ name: "x", body: "Review $ARGUMENTS now" })
    expect(cmd.expand("", {} as PluginContext)).toBe("Review  now")
  })
})
