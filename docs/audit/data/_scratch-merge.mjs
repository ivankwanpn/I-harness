import fs from "node:fs"
import path from "node:path"

const DATA = "D:/I-harness-main/docs/audit/data"
const modulesDoc = JSON.parse(fs.readFileSync(path.join(DATA, "2026-09-11-d3-modules.json"), "utf8"))

const mineUp = JSON.parse(fs.readFileSync(path.join(DATA, "_scratch-mine-upstream.json"), "utf8"))
const mineFork = JSON.parse(fs.readFileSync(path.join(DATA, "_scratch-mine-fork.json"), "utf8"))
const perUp = JSON.parse(fs.readFileSync(path.join(DATA, "_scratch-upstream-peripheral.json"), "utf8"))
const perFork = JSON.parse(fs.readFileSync(path.join(DATA, "_scratch-fork-peripheral.json"), "utf8"))

const DOMAINS = ["loop", "session", "context", "tools", "subagent", "safety", "model", "extension", "service", "retrieval", "ops", "interface"]
const KEEP = ["name", "what", "invariants", "failurePolicy", "constants", "evidence", "modules", "verified"]

const clean = (m) => {
  const out = {}
  for (const k of KEEP) out[k] = m[k]
  return out
}

function mergeDomains(parts) {
  const out = {}
  for (const d of DOMAINS) {
    const list = []
    const seen = new Set()
    for (const p of parts) {
      for (const m of p.domains[d] ?? []) {
        if (seen.has(m.name)) continue
        seen.add(m.name)
        list.push(clean(m))
      }
    }
    out[d] = list
  }
  return out
}

const upstreamDomains = mergeDomains([mineUp, perUp])
const forkDomains = mergeDomains([mineFork, perFork])

// ---- module coverage via longest-prefix ownership -------------------------
function coverage(sourceKey, domains) {
  const mods = modulesDoc.sources[sourceKey].modules
  const nameToPath = new Map(mods.map((m) => [m.name, m.path]))
  const norm = (v) => nameToPath.get(v) ?? v
  const sorted = [...mods].sort((a, b) => b.path.length - a.path.length)
  const buckets = new Map(mods.map((m) => [m.name, new Set()]))
  for (const d of DOMAINS) {
    for (const mech of domains[d]) {
      const owners = new Set()
      for (const raw of mech.modules ?? []) {
        const p = norm(raw)
        for (const cand of sorted) {
          if (p === cand.path || p.startsWith(cand.path + "/")) {
            owners.add(cand.name)
            break
          }
        }
      }
      for (const o of owners) buckets.get(o).add(mech.name)
    }
  }
  const uncovered = []
  const out = {}
  for (const m of mods) {
    const b = buckets.get(m.name)
    if (b.size === 0) uncovered.push({ name: m.name, path: m.path, domain: m.domain, files: m.files })
    else out[m.name] = [...b].sort()
  }
  return { out, uncovered, byDomain: modulesDoc.sources[sourceKey].byDomain, count: mods.length }
}

const upCov = coverage("opencode", upstreamDomains)
const forkCov = coverage("opencode-fork", forkDomains)

const counts = (domains) => Object.fromEntries(DOMAINS.map((d) => [d, domains[d].length]))
console.log("upstream mechanism counts:", JSON.stringify(counts(upstreamDomains)))
console.log("upstream total:", DOMAINS.reduce((a, d) => a + upstreamDomains[d].length, 0), "modules:", upCov.count)
console.log("fork mechanism counts:", JSON.stringify(counts(forkDomains)))
console.log("fork total:", DOMAINS.reduce((a, d) => a + forkDomains[d].length, 0), "modules:", forkCov.count)

console.log("\nUPSTREAM uncovered modules (" + upCov.uncovered.length + "):")
for (const u of upCov.uncovered) console.log(` - ${u.name} | ${u.path} | hint=${u.domain} | files=${u.files}`)
console.log("\nFORK uncovered modules (" + forkCov.uncovered.length + "):")
for (const u of forkCov.uncovered) console.log(` - ${u.name} | ${u.path} | hint=${u.domain} | files=${u.files}`)

fs.writeFileSync(
  path.join(DATA, "_scratch-merged-preview.json"),
  JSON.stringify({ upstreamDomains, forkDomains, upCov: upCov.out, forkCov: forkCov.out }, null, 2),
)
console.log("\nwrote _scratch-merged-preview.json")
