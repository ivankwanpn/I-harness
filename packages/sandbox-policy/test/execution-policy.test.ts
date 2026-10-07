import { describe, expect, it } from "vitest"
import { resolve, normalize } from "node:path"
import { compileExecutionPolicy, assertExecutionAuthority } from "@i-harness/sandbox-policy"
import type { AuthorityState, CompiledSandboxPolicy, SandboxMode } from "@i-harness/sandbox"

const primary = resolve("authority-fixtures/primary")
const secondary = resolve("authority-fixtures/secondary")
const reference = resolve("authority-fixtures/reference")
const owner = { sessionId: "session", parentSessionId: "parent" }
const authority: AuthorityState = { kind: "bound", revision: "r1", primaryRoot: primary, roots: [secondary], references: [reference] }
const compile = (state: AuthorityState = authority, mode: SandboxMode = "workspace-write") => compileExecutionPolicy({ mode, owner, authority: state })
const spelling = (path: string) => process.platform === "win32" ? normalize(path).toLowerCase() : normalize(path)

describe("execution authority snapshots", () => {
  it.each(["revoked", "unavailable"] as const)("refuses %s authority", kind => {
    expect(() => compile({ kind, revision: "r2", reason: "removed" })).toThrow(new RegExp(kind))
  })
  it("grants an unbound workspace explicitly", () => {
    const policy = compile({ kind: "unbound", revision: "r1", workspaceRoot: primary })
    expect(policy.authorityKind).toBe("unbound")
    expect(policy.primaryRoot).toBe(spelling(primary))
    expect(policy.writeRoots).toEqual([spelling(primary)])
    expect(policy.authorityRoots).toEqual([spelling(primary)])
    expect(policy.referenceRoots).toEqual([])
  })
  it("retains a bound primary root and keeps references separate", () => {
    const policy = compile()
    expect(policy.primaryRoot).toBe(spelling(primary))
    expect(policy.writeRoots).toEqual([spelling(primary), spelling(secondary)])
    expect(policy.authorityRoots).toEqual([spelling(primary), spelling(secondary)])
    expect(policy.referenceRoots).toEqual([spelling(reference)])
    expect(policy.readable).toBe("caller")
  })
  it("read-only grants no writes", () => expect(compile(authority, "read-only").writeRoots).toEqual([]))
  it("full access retains its explicit unrestricted mode", () => {
    const policy = compile(authority, "danger-full-access")
    expect(policy.mode).toBe("danger-full-access")
    expect(policy.writeRoots).toEqual([])
    expect(policy.referenceRoots).toEqual([spelling(reference)])
  })
  it.each([primary, resolve(primary, "child"), resolve(primary, "..")])("rejects writable/reference overlap %s", root => {
    expect(() => compile({ ...authority, references: [root] } as AuthorityState)).toThrow(/overlap/i)
  })
  it("detaches and freezes all nested public values", () => {
    const input = { mode: "workspace-write" as const, owner: { ...owner }, authority: { kind: "bound" as const, revision: "r1", primaryRoot: primary, roots: [secondary], references: [reference] } }
    const policy = compileExecutionPolicy(input)
    input.owner.sessionId = "changed"; input.authority.roots.push(reference); input.authority.references.length = 0
    expect(policy.owner.sessionId).toBe("session")
    expect(policy.writeRoots).toEqual([spelling(primary), spelling(secondary)])
    expect(policy.referenceRoots).toEqual([spelling(reference)])
    expect(policy.authorityRoots).toEqual([spelling(primary), spelling(secondary)])
    for (const value of [policy, policy.owner, policy.authorityRoots, policy.writeRoots, policy.referenceRoots]) expect(Object.isFrozen(value)).toBe(true)
  })
  it("canonicalizes ordering, duplicates and lexical spellings", () => {
    const before = compile()
    const after = compile({ ...authority, roots: [secondary, primary, secondary, resolve(secondary, "child", "..")], references: [reference, reference] } as AuthorityState)
    expect(after.fingerprint).toBe(before.fingerprint)
    expect(() => assertExecutionAuthority(before, after)).not.toThrow()
  })
  it("uses native platform case semantics", () => {
    const a = compile({ kind: "unbound", revision: "r1", workspaceRoot: primary })
    const b = compile({ kind: "unbound", revision: "r1", workspaceRoot: primary.toUpperCase() })
    expect(a.fingerprint === b.fingerprint).toBe(process.platform === "win32")
  })
  it.each([
    { mode: "unknown" }, { owner: null }, { owner: { sessionId: " " } },
    { owner: { sessionId: "s", parentSessionId: "" } }, { authority: null },
    { authority: { kind: "missing", revision: "r1" } },
    { authority: { ...authority, revision: " " } },
    { authority: { ...authority, roots: "bad" } }, { authority: { ...authority, references: null } },
    { authority: { kind: "unbound", revision: "r1", workspaceRoot: "relative" } },
    { authority: { ...authority, primaryRoot: primary + "\0" } },
    { authority: { ...authority, roots: ["relative"] } }, { authority: { ...authority, references: [42] } },
    { authority: { ...authority, roots: Array(1) } },
  ])("refuses malformed runtime inputs %#", patch => {
    expect(() => compileExecutionPolicy({ mode: "workspace-write", owner, authority, ...patch } as Parameters<typeof compileExecutionPolicy>[0])).toThrow()
  })
  it.each([
    { owner: { sessionId: "other", parentSessionId: "parent" } },
    { owner: { sessionId: "session", parentSessionId: "other" } },
    { authorityRevision: "r2" }, { authorityKind: "unbound" }, { primaryRoot: secondary },
    { mode: "read-only" }, { authorityRoots: [primary] }, { writeRoots: [primary] }, { referenceRoots: [] }, { readable: "all" },
  ])("rejects changed content despite a copied fingerprint %#", patch => {
    const before = compile()
    expect(() => assertExecutionAuthority(before, { ...before, ...patch } as CompiledSandboxPolicy)).toThrow(/authority/i)
  })
  it("rejects changed independently compiled authority", () => {
    expect(() => assertExecutionAuthority(compile(), compile({ ...authority, revision: "r2" } as AuthorityState))).toThrow(/authority/i)
  })
  it.each(["read-only", "danger-full-access"] as const)("retains root authority and rejects same-revision root changes in %s", mode => {
    const before = compile(authority, mode)
    const after = compile({ ...authority, roots: [] } as AuthorityState, mode)
    expect(before.authorityRoots).toEqual([spelling(primary), spelling(secondary)])
    expect(before.writeRoots).toEqual([])
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(() => assertExecutionAuthority(before, after)).toThrow(/authority/i)
  })
  it("rejects malformed prepared policy content", () => {
    const before = compile()
    expect(() => assertExecutionAuthority({ ...before, authorityRoots: null } as unknown as CompiledSandboxPolicy, before)).toThrow(/authority/i)
  })
  it("recomputes both fingerprints", () => {
    const before = compile()
    const forged = { ...before, fingerprint: "forged" }
    expect(() => assertExecutionAuthority(forged, forged)).toThrow(/authority/i)
    expect(() => assertExecutionAuthority(before, forged)).toThrow(/authority/i)
    expect(() => assertExecutionAuthority({ ...before, owner: { sessionId: "other" } }, before)).toThrow(/authority/i)
  })
})
