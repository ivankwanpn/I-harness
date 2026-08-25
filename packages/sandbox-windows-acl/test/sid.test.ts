import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { workspaceWriteSid, tempWriteSid } from "../src/workspace-sid.ts"
import { assertTempRootOutsideWorkspace } from "../src/path-boundary.ts"

describe("workspaceWriteSid / tempWriteSid", () => {
  it("is deterministic and distinct between workspace and temp", () => {
    const ws = "C:\\work\\proj"
    const sid1 = workspaceWriteSid(ws)
    const sid2 = workspaceWriteSid("C:\\work\\proj")
    expect(sid1).toBe(sid2)
    expect(sid1).toMatch(/^S-1-4-\d+-\d+$/)
    const tempSid = tempWriteSid("C:\\Users\\x\\AppData\\Local\\Temp\\m16-temp")
    expect(tempSid).toMatch(/^S-1-4-\d+-\d+-1$/)
    expect(workspaceWriteSid("C:\\other")).not.toBe(sid1)
  })

  it("derives different SIDs for different roots", () => {
    expect(workspaceWriteSid("C:\\a")).not.toBe(workspaceWriteSid("C:\\b"))
  })

  it("is byte-sensitive: the canonical path is the caller's contract", () => {
    // The ported derivation hashes the path bytes verbatim; the caller must
    // pass the canonical path (see the module doc).
    expect(workspaceWriteSid("C:\\Repo")).not.toBe(workspaceWriteSid("c:\\repo"))
    expect(workspaceWriteSid("C:\\Repo\\")).not.toBe(workspaceWriteSid("C:\\Repo"))
  })

  it("temp SID is domain-separated from every workspace SID", () => {
    const temp = tempWriteSid("C:\\Users\\x\\AppData\\Local\\Temp\\m16-temp")
    expect(temp).not.toBe(workspaceWriteSid("C:\\Users\\x\\AppData\\Local\\Temp\\m16-temp"))
    expect(temp).not.toMatch(/^S-1-4-\d+-\d+$/)
  })
})

describe("assertTempRootOutsideWorkspace", () => {
  const scratchDirs: string[] = []
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-acl-boundary-"))
    scratchDirs.push(dir)
    return dir
  }

  it("throws when temp is inside workspace", () => {
    const ws = scratch()
    const temp = join(ws, "temp-123")
    mkdirSync(temp)
    expect(() => assertTempRootOutsideWorkspace(ws, temp)).toThrow(/outside|workspace/i)
  })

  it("throws when temp equals the workspace", () => {
    const ws = scratch()
    expect(() => assertTempRootOutsideWorkspace(ws, ws)).toThrow(/outside|workspace/i)
  })

  it("passes when temp is elsewhere", () => {
    const ws = scratch()
    const temp = scratch()
    expect(() => assertTempRootOutsideWorkspace(ws, temp)).not.toThrow()
  })

  it("passes when temp is a sibling with a shared prefix", () => {
    // The boundary check is directory-relative, not string-prefix-based:
    // a sibling `...\proj2` must not be treated as inside `...\proj`.
    const root = scratch()
    const ws = join(root, "proj")
    const sibling = join(root, "proj2")
    mkdirSync(ws)
    mkdirSync(sibling)
    expect(() => assertTempRootOutsideWorkspace(ws, sibling)).not.toThrow()
  })

  it("passes when temp is a parent of the workspace (fresh child is a sibling)", () => {
    const tempRoot = scratch()
    const ws = join(tempRoot, "workspace")
    mkdirSync(ws)
    expect(() => assertTempRootOutsideWorkspace(ws, tempRoot)).not.toThrow()
  })
})
