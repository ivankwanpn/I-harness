import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { release } from "node:os"

// Case identities/outcomes transcribed from frozen actual069 raw observations.
// The metadata below is a CLI-validation fixture, not another runtime observation.
const cases = [
  ["helper-integrity-and-probe", "pass"],
  ["psec-filesystem-workspace-write", "pass"],
  ["psec-filesystem-read-only", "pass"],
  ["psec-junction-alias-reference", "pass"],
  ["unrestricted-refuses-reference-lock", "pass"],
  ["unrestricted-refuses-deny-lock", "pass"],
  ["psec-missing-LOCALAPPDATA-203", "pass"],
  ["unrestricted-node-exact-argv-cwd-env", "pass"],
  ["unrestricted-node-binary-pipes", "pass"],
  ["unrestricted-full-width-exit", "pass"],
  ["unrestricted-native-pipe-input", "pass"],
  ["unrestricted-tsx-pipe", "pass"],
  ["unrestricted-retain-descendant", "pass"],
  ["unrestricted-job-cancel-timeout", "pass"],
  ["unrestricted-job-cancel-descendant", "pass"],
  ["unrestricted-output-cancel-accounting", "pass"],
  ["unrestricted-cmd", "pass"],
  ["unrestricted-powershell", "pass"],
  ["unrestricted-git", "pass"],
  ["unrestricted-msys-bash-pipe", "pass"],
  ["psec-node-exact-argv-cwd-env", "pass"],
  ["psec-node-binary-pipes", "pass"],
  ["psec-full-width-exit", "pass"],
  ["psec-native-pipe-input", "pass"],
  ["psec-tsx-pipe", "pass"],
  ["psec-retain-descendant", "pass"],
  ["psec-job-cancel-timeout", "pass"],
  ["psec-job-cancel-descendant", "pass"],
  ["psec-output-cancel-accounting", "pass"],
  ["psec-cmd", "pass"],
  ["psec-powershell", "pass"],
  ["psec-git", "pass"],
  ["psec-msys-bash-pipe", "unsupported"],
  ["psec-msys-matrix-launcher-retain-tree", "unsupported"],
  ["psec-msys-matrix-direct-complete-tree", "unsupported"],
  ["psec-msys-matrix-direct-retain-tree", "unsupported"],
  ["psec-pty-rejected-before-workload", "pass"],
  ["unrestricted-pty-input-resize", "pass"],
  ["unrestricted-pty-retain-descendant", "pass"],
  ["unrestricted-msys-pty-absolute-runtime-input-resize", "pass"],
  ["host-loopback-positive", "pass"],
  ["psec-loopback-egress-denial", "pass"],
  ["protected-reference-content-metadata-acl", "pass"],
] as const

describe.skipIf(process.platform !== "win32")("standard qualification record owner", () => {
  const root = resolve(import.meta.dirname, "..")
  const parent = resolve(root, "../../.tmp")
  mkdirSync(parent, { recursive: true })
  const fixture = mkdtempSync(resolve(parent, "record-owner-regression-"))
  const manifest = JSON.parse(readFileSync(resolve(root, "artifacts/win32-x64/manifest.json"), "utf8"))
  const current = JSON.parse(readFileSync(resolve(root, "qualification.json"), "utf8"))
  const source = {
    platform: "win32", packageRoot: root, helper: resolve(root, "artifacts/win32-x64", manifest.helperFile),
    manifest, helperSha256: manifest.helperSha256, windowsRelease: release(), protectedUnchanged: true,
    generatedAt: current.observedAt, results: cases.map(([name, outcome]): { name: string; outcome: string } => ({ name, outcome })),
  }
  let sequence = 0
  const observations: unknown[] = []
  function run(value: typeof source, label: string) {
    const stem = `${++sequence}-${label}`
    const input = resolve(fixture, `${stem}.json`), output = resolve(fixture, `${stem}-record.json`)
    writeFileSync(input, JSON.stringify(value))
    const result = spawnSync(process.execPath, ["scripts/record-qualification.mjs", input, output],
      { cwd: root, encoding: "utf8", windowsHide: true })
    writeFileSync(resolve(fixture, `${stem}-stdout.log`), result.stdout ?? "")
    writeFileSync(resolve(fixture, `${stem}-stderr.log`), result.stderr ?? "")
    observations.push({ label, input, output, exitCode: result.status, error: result.error?.message,
      recordWritten: existsSync(output) })
    writeFileSync(resolve(fixture, "observations.json"), JSON.stringify(observations, null, 2))
    return { ...result, output }
  }
  function refused(value: typeof source, label: string) {
    const result = run(value, label)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).not.toBe(0)
    expect(existsSync(result.output), "rejected evidence must never create a record").toBe(false)
  }
  it("records the complete unchanged standard matrix with experimental incomplete labels", () => {
    console.log(`Record owner validation evidence: ${fixture}`)
    const result = run(source, "valid")
    expect(result.status, result.stderr).toBe(0)
    const record = JSON.parse(readFileSync(result.output, "utf8"))
    expect(record.observed).toEqual({ passed: 39, failed: 0, unsupported: 4 })
    expect(record.sourceFamilies).toEqual(current.sourceFamilies)
    expect(record.assurance).toBe("experimental")
    expect(record.observationScope).toBe("historical-one-host")
    expect(record.result).toBe("incomplete")
  })
  it.each(cases)("rejects a same-count substitution for %s (%s)", (name, outcome) => {
    const value = structuredClone(source)
    value.results = value.results.map(row => row.name === name ? { name: `replacement-${name}`, outcome } : row)
    refused(value, `substitute-${name}`)
  })
  it("rejects a missing critical cancellation case", () => {
    const value = structuredClone(source)
    value.results = value.results.filter(row => row.name !== "psec-job-cancel-timeout")
    refused(value, "missing-cancel")
  })
  it("rejects an extra unique passing case", () => {
    const value = structuredClone(source)
    value.results.push({ name: "extra-pass", outcome: "pass" })
    refused(value, "extra-pass")
  })
  it("rejects a duplicate critical cancellation case", () => {
    const value = structuredClone(source)
    value.results.push({ name: "psec-job-cancel-timeout", outcome: "pass" })
    refused(value, "duplicate-cancel")
  })
  it("rejects changed statuses even when the pass/unsupported totals remain unchanged", () => {
    const value = structuredClone(source)
    value.results = value.results.map(row => row.name === "psec-job-cancel-timeout" ? { ...row, outcome: "unsupported" }
      : row.name === "psec-msys-bash-pipe" ? { ...row, outcome: "pass" } : row)
    refused(value, "same-count-status-swap")
  })
})
