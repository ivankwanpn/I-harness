import { describe, expect, it } from "vitest"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { createContext } from "@i-harness/core-plugin"
import type { ApprovalAuthorityProvider, Tool } from "@i-harness/core-tools"
import { createApprovalRulesAdapter } from "../src/approval-rules.ts"

function fixture(identityAvailable = true) {
  const ctx = createContext()
  const tool = { name: "read", description: "read", inputSchema: { type: "object" } } as unknown as Tool
  const registry = { get: (name: string) => (name === "read" ? tool : undefined) } as never
  const adapter = createApprovalRulesAdapter({ filePath: join(tmpdir(), `ih-owned-rules-${randomUUID()}.json`), policyIdentity: () => undefined, ownedPolicyIdentity: () => identityAvailable ? { workspaceId: "workspace", revision: "revision" } : undefined })
  adapter.attachOwned({ ctx, sessionId: "root", tools: registry })
  const authority = ctx.services.get<ApprovalAuthorityProvider>("approval/authority")
  return { tool, registry, authority }
}

describe("owned approval authority", () => {
  it("validates an unchanged child call through its registry binding", () => {
    const { tool, registry, authority } = fixture()
    const validate = authority({ tool, registry, call: { name: "read", args: {} }, sessionId: "child", validateBinding: () => true })
    expect(validate()).toBe(true)
  })

  it("rejects a stale binding, a replaced tool or a missing registry", () => {
    const { tool, registry, authority } = fixture()
    expect(authority({ tool, registry, call: { name: "read", args: {} }, sessionId: "child", validateBinding: () => false })()).toBe(false)
    const replacement = { ...tool } as Tool
    expect(authority({ tool: replacement, registry, call: { name: "read", args: {} }, sessionId: "child", validateBinding: () => true })()).toBe(false)
    expect(authority({ tool, registry: undefined, call: { name: "read", args: {} }, sessionId: "child", validateBinding: () => true })()).toBe(false)
  })

  it("fails closed when the policy identity is unavailable", () => {
    const { tool, registry, authority } = fixture(false)
    expect(authority({ tool, registry, call: { name: "read", args: {} }, sessionId: "root" })()).toBe(false)
    expect(authority({ tool, registry, call: { name: "read", args: {} }, sessionId: "child", validateBinding: () => true })()).toBe(false)
  })

  it("still requires the exact root registry", () => {
    const { tool, registry, authority } = fixture()
    expect(authority({ tool, registry, call: { name: "read", args: {} }, sessionId: "root" })()).toBe(true)
    expect(authority({ tool, registry: { get: () => undefined } as never, call: { name: "read", args: {} }, sessionId: "root" })()).toBe(false)
  })
})
