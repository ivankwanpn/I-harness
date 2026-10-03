import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { Tool } from "@i-harness/core-tools"
import { createApprovalRuleStore, prepareApprovalEvidence } from "../src/active-rules.ts"
import { nativeExecutableFixture } from "./native-executable-fixture.ts"

const io = vi.hoisted(() => ({ executable: "", afterRead: undefined as (() => void) | undefined }))
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (args[0] === io.executable) throw new Error("executable must not be allocated as a whole file")
      return actual.readFileSync(...args)
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      if (args[1].byteLength > 1024 * 1024) throw new Error("executable read exceeds bounded buffer")
      const count = actual.readSync(...args)
      if (args[1].byteLength === 1024 * 1024 && io.afterRead) {
        const callback = io.afterRead; io.afterRead = undefined; callback()
      }
      return count
    },
  }
})

const directories: string[] = []
afterEach(() => {
  io.executable = ""; io.afterRead = undefined
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture(size = 1024) {
  const directory = mkdtempSync(join(tmpdir(), "ih-packaged-identity-")); directories.push(directory)
  const executable = join(directory, "fixture.exe")
  const fd = openSync(executable, "w")
  try { writeSync(fd, nativeExecutableFixture()); ftruncateSync(fd, size) } finally { closeSync(fd) }
  io.executable = executable
  const tool: Tool = { name: "native", description: "", inputSchema: {}, execute: async () => "body",
    approvalIdentity: () => ({ binding: "native-v1", executablePaths: [executable] }) }
  const prepare = () => prepareApprovalEvidence({ tool, call: { name: "native", args: { path: "approval.txt" } }, workspaceId: "w", policyRevision: "p" })
  return { directory, executable, prepare, tool }
}

it("hashes the whole shipped-size image in bounded memory and reuses its unchanged identity across rule-store restart", () => {
  const { directory, executable, prepare } = fixture(246032896)
  const first = prepare()
  expect(first.reason).toBeUndefined(); expect(first.evidence).toBeDefined()
  const storePath = join(directory, "rules.json")
  createApprovalRuleStore(storePath, () => 1000).add(first.evidence!, { kind: "workspace" }, 2000)
  utimesSync(executable, new Date(0), new Date(0))
  const unchanged = prepare().evidence!
  expect(unchanged).toEqual(first.evidence)
  expect(createApprovalRuleStore(storePath, () => 1000).matches(unchanged)).toBe(true)
  const fd = openSync(executable, "r+")
  try { writeSync(fd, Buffer.from([37]), 0, 1, 246032895) } finally { closeSync(fd) }
  const changed = prepare().evidence!
  expect(changed.executableDigest).not.toBe(first.evidence!.executableDigest)
  expect(createApprovalRuleStore(storePath, () => 1000).matches(changed)).toBe(false)
})

for (const change of ["mutate", "mutate-with-reader", "replace"] as const) {
  it(`refuses evidence if the executable ${change} happens while hashing`, () => {
    const { directory, executable, prepare } = fixture(2 * 1024 * 1024)
    const reader = change === "mutate-with-reader" ? openSync(executable, "r") : undefined
    io.afterRead = () => {
      if (change !== "replace") {
        const fd = openSync(executable, "r+")
        try { writeSync(fd, Buffer.from([99]), 0, 1, 512) } finally { closeSync(fd) }
      } else {
        renameSync(executable, join(directory, "old.exe")); writeFileSync(executable, nativeExecutableFixture())
      }
    }
    try {
      const result = prepare()
      expect(result.evidence).toBeUndefined(); expect(result.reason).toMatch(/changed|replaced/)
    } finally { if (reader !== undefined) closeSync(reader) }
  })
}

it("keeps unsupported formats, scripts and images beyond the bounded I/O budget one-time", () => {
  const { executable, prepare } = fixture(512 * 1024 * 1024 + 1)
  expect(prepare().reason).toMatch(/fingerprint limit/)
  for (const bytes of [Buffer.from("opaque image"), Buffer.from("#!/bin/sh\necho x")]) {
    writeFileSync(executable, bytes)
    expect(prepare().evidence).toBeUndefined()
    expect(prepare().reason).toMatch(/unsupported executable|scripts/)
  }
})

it("retains the complete ELF content identity", () => {
  const { executable, prepare } = fixture()
  writeFileSync(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]))
  const before = prepare().evidence!
  expect(before).toBeDefined()
  writeFileSync(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 4]))
  expect(prepare().evidence!.executableDigest).not.toBe(before.executableDigest)
})

it("supports a stable executable alias but refuses a redirected link during hashing", () => {
  const { directory, prepare, tool } = fixture(2 * 1024 * 1024)
  const linkedDirectory = join(directory, "linked"), alternative = join(directory, "alternative")
  mkdirSync(alternative); writeFileSync(join(alternative, "fixture.exe"), nativeExecutableFixture(2))
  symlinkSync(directory, linkedDirectory, process.platform === "win32" ? "junction" : "dir")
  const original = prepare().evidence!
  tool.approvalIdentity = () => ({ binding: "native-v1", executablePaths: [join(linkedDirectory, "fixture.exe")] })
  expect(prepare().evidence).toEqual(original)
  io.afterRead = () => {
    rmSync(linkedDirectory); symlinkSync(alternative, linkedDirectory, process.platform === "win32" ? "junction" : "dir")
  }
  expect(prepare().evidence).toBeUndefined()
})
