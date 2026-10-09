import { describe, expect, it } from "vitest"
import { checkBackendRequirements, type BackendProbe, type BackendRequirements } from "@i-harness/sandbox"

const probe: BackendProbe = {
  id: "qualified", availability: "available", assurance: "verified",
  features: { writeIsolation: true, readIsolation: true, denyPaths: true, pipes: true, pty: true, retainedTree: true },
}
const requirements: BackendRequirements = {
  writeIsolation: true, readIsolation: true, denyPaths: true,
  transport: "pipe", lifetime: "retain-tree", minimumAssurance: "verified",
}

describe("package-root backend negotiation", () => {
  it("accepts reference protection separately from general deny paths, with legacy compatibility", () => {
    const references = { ...requirements, denyPaths: false, referenceProtection: true }
    expect(checkBackendRequirements({ ...probe, features: { ...probe.features, denyPaths: false, referenceProtection: true } }, references)).toEqual({ ok: true })
    expect(checkBackendRequirements(probe, references)).toEqual({ ok: true })
    expect(checkBackendRequirements({ ...probe, features: { ...probe.features, denyPaths: false } }, references)).toEqual({ ok: false, missing: ["reference-protection"] })
  })
  it("accepts fully satisfied requirements", () => {
    expect(checkBackendRequirements(probe, requirements)).toEqual({ ok: true })
  })
  it("refuses an unavailable backend", () => {
    expect(checkBackendRequirements({ ...probe, availability: "unavailable" }, requirements))
      .toEqual({ ok: false, missing: ["availability"] })
  })
  it.each([
    ["writeIsolation", "write-isolation"], ["readIsolation", "read-isolation"],
    ["denyPaths", "deny-paths"], ["pipes", "pipe"], ["retainedTree", "retained-tree"],
  ] as const)("refuses missing %s", (feature, missing) => {
    expect(checkBackendRequirements({ ...probe, features: { ...probe.features, [feature]: false } }, requirements))
      .toEqual({ ok: false, missing: [missing] })
  })
  it("refuses missing PTY support", () => {
    expect(checkBackendRequirements({ ...probe, features: { ...probe.features, pty: false } }, { ...requirements, transport: "pty" }))
      .toEqual({ ok: false, missing: ["pty"] })
  })
  it("does not demand optional isolation or unused transport and lifetime", () => {
    expect(checkBackendRequirements({ ...probe, features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: false, pty: true, retainedTree: false } },
      { ...requirements, writeIsolation: false, readIsolation: false, denyPaths: false, transport: "pty", lifetime: "complete-tree" }))
      .toEqual({ ok: true })
  })
  it.each([
    ["verified", "verified", true], ["verified", "experimental", true], ["verified", "unverified", true],
    ["experimental", "verified", false], ["experimental", "experimental", true], ["experimental", "unverified", true],
    ["unverified", "verified", false], ["unverified", "experimental", false], ["unverified", "unverified", true],
  ] as const)("ranks %s against required %s", (assurance, minimumAssurance, ok) => {
    expect(checkBackendRequirements({ ...probe, assurance }, { ...requirements, minimumAssurance }))
      .toEqual(ok ? { ok: true } : { ok: false, missing: ["assurance"] })
  })
  it("reports all unmet requirements once in stable order", () => {
    expect(checkBackendRequirements({ ...probe, availability: "unavailable", assurance: "unverified", features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: false, pty: false, retainedTree: false } }, requirements))
      .toEqual({ ok: false, missing: ["availability", "write-isolation", "read-isolation", "deny-paths", "pipe", "retained-tree", "assurance"] })
  })
  it.each([null, undefined, {}, [], { ...probe, availability: "discovered" }, { ...probe, assurance: "toString" },
    { ...probe, id: 7 }, { ...probe, detail: false }, { ...probe, features: null },
    ...Object.keys(probe.features).flatMap(key => ["true", 1, undefined].map(value => ({ ...probe, features: { ...probe.features, [key]: value } }))),
  ])("refuses malformed runtime probe %#", malformed => {
    expect(checkBackendRequirements(malformed as BackendProbe, requirements)).toEqual({ ok: false, missing: ["invalid-contract"] })
  })
  it.each([null, undefined, {}, [], { ...requirements, transport: "socket" }, { ...requirements, lifetime: "forever" },
    { ...requirements, minimumAssurance: "constructor" },
    ...["writeIsolation", "readIsolation", "denyPaths"].flatMap(key => ["false", 0, undefined].map(value => ({ ...requirements, [key]: value }))),
  ])("refuses malformed runtime requirements %#", malformed => {
    expect(checkBackendRequirements(probe, malformed as BackendRequirements)).toEqual({ ok: false, missing: ["invalid-contract"] })
  })
})
