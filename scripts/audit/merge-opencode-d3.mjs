#!/usr/bin/env node
// scripts/audit/merge-opencode-d3.mjs
//
// Assemble the opencode/fork D3 inventory from the merge preview an agent left
// behind, and complete the module coverage.
//
// Why this is a script and not another agent task: THREE agents failed at this
// exact step. The material was never the problem -- the preview already holds
// 94 upstream and 97 fork mechanisms plus the fork deltas. What kept failing was
// the final combine-and-write, which is deterministic work, so it belongs here.
//
// Coverage honesty: the preview covers 55 of 97 and 42 of 99 modules
// individually. The remainder are filled with PER-MODULE entries derived from
// the Phase 0 classifier's domain hint, and every such entry is prefixed
// "UNREVIEWED" so the document can state plainly which sources have
// agent-verified coverage and which were completed mechanically. Silently
// pattern-covering them would claim a review that did not happen.

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null)

const preview = readJson(join(DATA, "_scratch-merged-preview.json"))
if (!preview) {
  console.error("! _scratch-merged-preview.json missing -- cannot assemble")
  process.exit(1)
}
const modules = readJson(join(DATA, "2026-09-11-d3-modules.json"))
const existing = readJson(join(DATA, "2026-09-11-d3-opencode.json"))

// The current file may hold better forkDeltas / corrections than the preview.
const previewForkHasDeltas = Array.isArray(preview.forkDeltas)

const upCov = { ...(preview.upCov ?? {}) }
const forkCov = { ...(preview.forkCov ?? {}) }

/** Complete a coverage map from the Phase 0 classifier, labelling every fill. */
function completeCoverage(cov, key) {
  const expected = (modules.sources[key]?.modules ?? [])
  const hintOf = new Map(expected.map((m) => [m.name, m.domain]))
  let filled = 0
  for (const m of expected) {
    if (m.name in cov) continue
    const hint = hintOf.get(m.name) ?? "unmapped"
    cov[m.name] =
      hint === "infra"
        ? "UNREVIEWED (Phase 0 classified this as infrastructure/tooling; not individually reviewed by an agent)"
        : `UNREVIEWED (Phase 0 hinted domain '${hint}'; no agent individually reviewed this module)`
    filled++
  }
  return { expected: expected.length, filled }
}

const upStats = completeCoverage(upCov, "opencode")
const forkStats = completeCoverage(forkCov, "opencode-fork")

const out = {
  upstream: {
    source: "opencode",
    version: "1.18.30",
    moduleCount: 97,
    domains: preview.upstreamDomains ?? {},
    moduleCoverage: upCov,
    hintCorrections: existing?.upstream?.hintCorrections ?? [],
    domainsAbsent: existing?.upstream?.domainsAbsent ?? [],
  },
  fork: {
    source: "opencode-fork",
    dirName: "opencode-fork-private-999.0.15",
    version: "999.0.19",
    moduleCount: 99,
    domains: preview.forkDomains ?? {},
    moduleCoverage: forkCov,
    hintCorrections: existing?.fork?.hintCorrections ?? [],
    domainsAbsent: existing?.fork?.domainsAbsent ?? [],
  },
  forkDeltas: preview.forkDeltas ?? existing?.forkDeltas ?? [],
  _assembledBy: "scripts/audit/merge-opencode-d3.mjs from _scratch-merged-preview.json after three agent attempts failed at this step",
  _coverageNote: `upstream ${upStats.filled}/${upStats.expected} entries are mechanically filled and labelled UNREVIEWED; fork ${forkStats.filled}/${forkStats.expected} likewise. Agent-verified coverage exists only for the entries without that prefix.`,
}

// Sanity: every mechanism must carry evidence, or the gate will reject it anyway.
let noEv = 0
let mech = 0
for (const body of [out.upstream, out.fork]) {
  for (const list of Object.values(body.domains)) {
    for (const m of list) {
      mech++
      if (!m.evidence || m.evidence.length === 0) noEv++
    }
  }
}

writeFileSync(join(DATA, "2026-09-11-d3-opencode.json"), JSON.stringify(out, null, 2) + "\n", "utf8")

console.log(`mechanisms: ${mech} (upstream ${Object.values(out.upstream.domains).reduce((a, v) => a + v.length, 0)}, fork ${Object.values(out.fork.domains).reduce((a, v) => a + v.length, 0)})`)
console.log(`without evidence: ${noEv}   <- must be 0`)
console.log(`coverage: upstream ${upStats.expected - upStats.filled} agent-reviewed + ${upStats.filled} UNREVIEWED-filled = ${upStats.expected}`)
console.log(`          fork     ${forkStats.expected - forkStats.filled} agent-reviewed + ${forkStats.filled} UNREVIEWED-filled = ${forkStats.expected}`)
console.log(`forkDeltas: ${out.forkDeltas.length}`)
console.log(`domains: upstream ${Object.keys(out.upstream.domains).length}/12, fork ${Object.keys(out.fork.domains).length}/12`)
console.log(`wrote docs/audit/data/2026-09-11-d3-opencode.json`)
