import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ESCALATION_TARGETS } from "@i-harness/sandbox"
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import { createSessionAssembly } from "../src/assembly.ts"

/**
 * The tool schemas must DECLARE the arguments the denial text advertises.
 *
 * `packages/sandbox/src/denial.ts` and `escalation.ts` tell the model, in words,
 * to "retry it with sandbox_permissions set to … and a justification" — and until
 * this file, no tool schema declared either argument. A model that follows the
 * advice is sending two arguments no schema defines, which is exactly the kind of
 * advice a model cannot act on. This is the D1 finding ("the ladder has no
 * production caller") closed at the schema level.
 *
 * WHY THE SCHEMA IS READ OFF AN LLMRequest, not off a registry built by hand:
 * the defect is that the model never SEES the arguments, so the evidence must be
 * the thing the model sees. Reaching into a registry would prove the object
 * exists somewhere in the process; the request proves it crossed the seam. It
 * also keeps the nesting honest — `ToolRegistry.schemas()`
 * (`packages/core-tools/src/index.ts:199-210`) returns
 * `{ name, description, inputSchema, exposure }`, so the properties live under
 * `inputSchema.properties`, and `inputSchema` is typed `unknown` there (`:62`),
 * hence the cast. Asserting `schemas[name].properties` — the shape an earlier
 * sketch used — would be asserting on `undefined`.
 *
 * Declaring the arguments is OPT-IN and stays opt-in: a schema that made them
 * `required` would break every ordinary call, so `required` is asserted too.
 */

/** A ModelClient double that records every request and completes in one turn. */
function capturingModel(): ModelClient & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = []
  return {
    requests,
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      requests.push(request)
      yield { type: "text/chunk", text: "done" }
      yield { type: "end" }
    },
  }
}

/**
 * Every tool that runs the escalation ladder — the five Task 3 declared, plus
 * the terminal's three (Task B). The name says "declares the escalation
 * arguments" rather than "write-capable and shell" because the terminal tools
 * are neither: they are refused under a confined mode and the ladder is their
 * only way through, which is exactly the class this list must not lose.
 */
const ESCALATION_DECLARING_TOOLS = [
  "write",
  "edit",
  "apply_patch",
  "bash",
  "pwsh",
  "terminal_open",
  "process_spawn",
  "terminal_send",
] as const

/** One real turn, then the schemas the model was given on it (keyed by name). */
async function toolSchemasFor(names: readonly string[]): Promise<Record<string, { inputSchema: unknown }>> {
  const workspace = mkdtempSync(join(tmpdir(), "i-harness-escalation-schema-"))
  const model = capturingModel()
  const assembly = await createSessionAssembly({ workspace, model, sandbox: "read-only" })
  try {
    await assembly.agent.run("inspect")
    const request = model.requests[0]
    expect(request).toBeDefined()
    const out: Record<string, { inputSchema: unknown }> = {}
    for (const schema of request!.tools) {
      if (names.includes(schema.name)) out[schema.name] = schema
    }
    return out
  } finally {
    await assembly.dispose()
    rmSync(workspace, { recursive: true, force: true })
  }
}

describe("the escalation arguments the marker text advertises", () => {
  it("every write-capable and shell tool declares the escalation arguments", async () => {
    const names = [...ESCALATION_DECLARING_TOOLS]
    const schemas = await toolSchemasFor(names)
    for (const name of names) {
      const schema = schemas[name]
      expect(schema, `${name} must be registered`).toBeDefined()
      // tools.schemas() returns { name, description, inputSchema, exposure } — the
      // schema is NESTED under inputSchema, and its type is `unknown`
      // (packages/core-tools/src/index.ts:59-64), so it needs a cast.
      const props = ((schema!.inputSchema as { properties?: Record<string, unknown> }).properties) ?? {}
      expect(props.sandbox_permissions, `${name} must declare sandbox_permissions`).toBeDefined()
      expect(props.justification, `${name} must declare justification`).toBeDefined()
      // They are OPT-IN: declaring them is not the same as requiring them, and a
      // schema that made them required would break every ordinary call.
      const required = (schema!.inputSchema as { required?: string[] }).required ?? []
      expect(required).not.toContain("sandbox_permissions")
      expect(required).not.toContain("justification")
    }
  })

  it("sandbox_permissions offers exactly the escalation targets, as a closed enum", async () => {
    const schemas = await toolSchemasFor(ESCALATION_DECLARING_TOOLS)
    for (const name of ESCALATION_DECLARING_TOOLS) {
      const props = (schemas[name]!.inputSchema as { properties: Record<string, { enum?: string[]; type?: string }> }).properties
      // A free-form string would let a model ask for a mode that does not exist
      // (and `read-only` is not a wider mode — asking for it is meaningless).
      expect(props.sandbox_permissions!.enum, `${name} enum`).toEqual([...ESCALATION_TARGETS])
      expect(props.sandbox_permissions!.type, `${name} type`).toBe("string")
      expect(props.justification!.type, `${name} justification type`).toBe("string")
    }
  })

  it("the system prompt of that same request names I-harness", async () => {
    // The schema test above already drives a real turn; this pins the sibling
    // fact in the same prompt — `renderPolicyContext` ships the policy fragment
    // into IH's own system prompt, one line after the preset says "You are
    // I-harness", so it must not name another product.
    const workspace = mkdtempSync(join(tmpdir(), "i-harness-prompt-name-"))
    const model = capturingModel()
    const assembly = await createSessionAssembly({ workspace, model, sandbox: "read-only" })
    try {
      await assembly.agent.run("inspect")
      const prompt = model.requests[0]!.systemPrompt
      expect(prompt).toContain("I-harness")
      expect(prompt).not.toContain("DSH")
    } finally {
      await assembly.dispose()
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
