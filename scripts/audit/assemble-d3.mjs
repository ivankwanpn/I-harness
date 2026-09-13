#!/usr/bin/env node
// scripts/audit/assemble-d3.mjs
//
// Phase 3 assembly of docs/audit/2026-09-11-sevenway-backend-mechanisms.md (D3).
//
// The command matrix (D2) could union on the command NAME, because `/compact` is
// `/compact` everywhere. D3 cannot: seven independent agents named the same
// capability differently ("append-only shadow projection" vs "surface-replace
// compaction"), so a name-keyed union would emit hundreds of single-source rows
// and the matrix would claim seven harnesses share almost nothing. The
// reconciliation therefore comes from an explicit CROSSWALK file, and rows that
// no crosswalk claims stay separate and land in the unreconciled appendix.
//
// Coverage is a hard gate: every module in docs/audit/data/2026-09-11-d3-modules.json
// must be accounted for by its source's inventory, or the build fails naming the
// modules nobody characterised. "We covered everything that exists" is the whole
// premise of D3, so it must not be an assertion.
//
// Usage: node scripts/audit/assemble-d3.mjs --crosswalk <json> [--dispositions <json>] [--front <md>] [--out <md>]

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { SOURCE_PATHS, carrierClass } from "./lib-union.mjs"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")
const args = process.argv.slice(2)
const opt = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 ? resolve(args[i + 1]) : d
}
const OUT = opt("--out", join(ROOT, "docs/audit/2026-09-11-sevenway-backend-mechanisms.md"))
const FRONT = args.includes("--front") ? opt("--front") : null
const CROSSWALK = args.includes("--crosswalk") ? opt("--crosswalk") : null
const DISP = args.includes("--dispositions") ? opt("--dispositions") : null

const readJson = (p) => {
  if (!p || !existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch (e) {
    console.error(`! unparseable ${p}: ${e.message}`)
    return null
  }
}

const SOURCES = [
  { key: "ih", label: "IH", files: ["2026-09-11-d3-ih.json"] },
  { key: "dsh", label: "dsh", files: ["2026-09-11-d3-dsh.json"] },
  { key: "codex", label: "codex", files: ["2026-09-11-d3-codex.json"] },
  { key: "opencode", label: "opencode", files: ["2026-09-11-d3-opencode.json"], pick: "upstream" },
  { key: "opencode-fork", label: "ocode-fork", files: ["2026-09-11-d3-opencode.json"], pick: "fork" },
  { key: "grok", label: "grok", files: ["2026-09-11-d3-grok.json"] },
  { key: "cc-custom", label: "cc-custom", files: ["2026-09-11-d3-cc-custom.json"] },
]

const domainsFile = readJson(join(DATA, "2026-09-11-d3-domains.json"))
const DOMAINS = domainsFile.domains.map((d) => d.id)
const DOMAIN_LABEL = Object.fromEntries(domainsFile.domains.map((d) => [d.id, d.label]))

// ------------------------------------------------------------------- load
const perSource = {}
for (const s of SOURCES) {
  const raw = readJson(join(DATA, s.files[0]))
  if (!raw) {
    console.error(`! MISSING SOURCE FILE ${s.files[0]}`)
    perSource[s.key] = null
    continue
  }
  perSource[s.key] = s.pick ? raw[s.pick] : raw
}

// Whole-document extras that are not per-domain mechanisms.
const sharedDoc = readJson(join(DATA, "2026-09-11-d3-opencode.json"))

const missing = SOURCES.filter((s) => !perSource[s.key]).map((s) => s.key)
if (missing.length) {
  console.error(`\nSOURCE GATE FAILED: no inventory for ${missing.join(", ")}`)
  console.error("refusing to emit a matrix that silently omits a source")
  process.exit(1)
}

// --------------------------------------------------------------- coverage gate
const modulesFile = readJson(join(DATA, "2026-09-11-d3-modules.json"))
const coverageProblems = []
for (const s of SOURCES) {
  const expected = modulesFile.sources[s.key]?.modules ?? []
  const cov = perSource[s.key].moduleCoverage ?? {}
  const unaccounted = expected.map((m) => m.name).filter((n) => !(n in cov))
  if (unaccounted.length) {
    coverageProblems.push({ source: s.key, expected: expected.length, covered: Object.keys(cov).length, unaccounted })
  }
}
if (coverageProblems.length) {
  console.error(`\nMODULE COVERAGE GATE FAILED`)
  for (const p of coverageProblems) {
    console.error(`  ${p.source}: ${p.covered}/${p.expected} accounted for; ${p.unaccounted.length} unaccounted`)
    console.error(`    ${p.unaccounted.slice(0, 25).join(", ")}${p.unaccounted.length > 25 ? " …" : ""}`)
  }
  console.error("  refusing to claim 'everything that exists was surveyed' while it is untrue")
  process.exit(1)
}

// ------------------------------------------------------------------- crosswalk
// crosswalk: { rows: { "<canonical row id>": { domain, label, members: { "<source>": ["<mechanism name>", ...] } } } }
const crosswalk = CROSSWALK ? (readJson(CROSSWALK)?.rows ?? {}) : {}
const claimed = new Set()
for (const [rowId, row] of Object.entries(crosswalk)) {
  for (const [src, names] of Object.entries(row.members ?? {})) {
    for (const n of names) claimed.add(`${src}::${n}`)
  }
}

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-").replace(/-+/g, "-")

// Index every mechanism by source+name for lookup.
const index = new Map()
for (const s of SOURCES) {
  for (const [domain, list] of Object.entries(perSource[s.key].domains ?? {})) {
    for (const m of list ?? []) {
      index.set(`${s.key}::${m.name}`, { ...m, domain, source: s.key })
    }
  }
}

// Row set = crosswalk rows + any mechanism nobody claimed (single-source rows).
const rows = []
for (const [rowId, row] of Object.entries(crosswalk)) {
  const members = {}
  for (const [src, names] of Object.entries(row.members ?? {})) {
    for (const n of names) {
      const hit = index.get(`${src}::${n}`)
      if (hit) members[src] = { ...hit, name: n }
    }
  }
  rows.push({ id: rowId, domain: row.domain, label: row.label ?? rowId, members })
}
const unclaimed = [...index.entries()].filter(([k]) => !claimed.has(k)).map(([, v]) => v)
for (const m of unclaimed) {
  rows.push({ id: `${m.source}::${m.name}`, domain: m.domain, label: m.name, members: { [m.source]: m }, single: true })
}

// --------------------------------------------------------------- dispositions
const disp = DISP ? (readJson(DISP)?.rows ?? {}) : {}
const VOCAB = new Set(["reuse", "rewrite", "improved-writing", "已存在", "遠期", "不做", "路線差異"])
if (DISP) {
  const bad = rows.filter((r) => {
    const d = disp[r.id]?.disposition ?? disp[r.id]
    return d && !VOCAB.has(d)
  })
  if (bad.length) {
    console.error(`\nDISPOSITION GATE FAILED: ${bad.length} rows use an unknown value`)
    process.exit(1)
  }
}

// ------------------------------------------------------------------- emit
const L = []
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim()
const bestCitation = (m) => {
  const ev = m?.evidence ?? []
  if (ev.length <= 1) return ev[0] ?? ""
  let best = ev[0]
  let bestRank = -1
  for (const cite of ev) {
    const mm = String(cite).match(/^(.*?):(\d+)(?:-(\d+))?$/)
    let rank = 0
    if (mm) {
      let text = ""
      try {
        text = readFileSync(join(SOURCE_PATHS[m.source] ?? "", mm[1]), "utf8").split(/\r?\n/)[Number(mm[2]) - 1] ?? ""
      } catch {
        text = ""
      }
      rank = carrierClass(mm[1], text) === "implementation" ? 1 : 0
    }
    if (rank > bestRank) {
      bestRank = rank
      best = cite
    }
  }
  return best
}

L.push("## 圖例", "")
L.push("| 符號 | 意義 |")
L.push("|---|---|")
L.push("| `✓` | 該源有此機制 |")
L.push("| `✗` | 該源有此域，但沒有這個機制 |")
L.push("| `—` | 該源在此域沒有對應層（見該域的說明） |")
L.push("")
L.push(`> 每格顯示該源的機制摘要與**最佳可得**的 \`file:line\`。單源獨有的機制列於各表末尾並標 \`(單源)\`——它們未被任何 crosswalk 認領，**不表示其他源沒有等價能力**，只表示名稱未能對帳。`)
L.push("")

let total = 0
for (const d of DOMAINS) {
  const inDomain = rows.filter((r) => r.domain === d)
  if (!inDomain.length) continue
  const shared = inDomain.filter((r) => Object.keys(r.members).length > 1)
  const single = inDomain.filter((r) => Object.keys(r.members).length === 1)
  L.push(`## ${DOMAIN_LABEL[d]}（\`${d}\`，${inDomain.length} 列：${shared.length} 跨源 + ${single.length} 單源）`, "")
  L.push("| 機制 | IH | dsh | codex | opencode | ocode-fork | grok | cc-custom | 出處／摘要 | disposition |")
  L.push("|---|---|---|---|---|---|---|---|---|---|")
  for (const r of [...shared, ...single]) {
    total++
    const cells = SOURCES.map(({ key }) => {
      const m = r.members[key]
      if (!m) return "✗"
      return "✓"
    })
    const m = r.members.ih ?? r.members[Object.keys(r.members)[0]]
    const cite = bestCitation(m)
    const dsp = disp[r.id]?.disposition ?? disp[r.id] ?? ""
    const dr = disp[r.id]?.rationale ? ` — ${esc(disp[r.id].rationale)}` : ""
    L.push(
      `| \`${r.label}\`${r.single ? " **(單源)**" : ""} | ${cells.join(" | ")} | ${esc(m?.what ?? m?.mechanism).slice(0, 230)}${cite ? ` \`${esc(cite)}\`` : ""} | ${dsp ? `**${dsp}**${dr}` : ""} |`,
    )
  }
  L.push("")
}

// ---------------------------------------------------------------- appendices
L.push("## 附錄 A — 模組覆蓋（每個源的每一個模組）", "")
for (const s of SOURCES) {
  const cov = perSource[s.key].moduleCoverage ?? {}
  L.push(`### ${s.label}（${Object.keys(cov).length} 模組）`, "")
  for (const [mod, val] of Object.entries(cov)) L.push(`- \`${mod}\` — ${esc(val)}`)
  L.push("")
}

const hints = SOURCES.flatMap((s) => (perSource[s.key].hintCorrections ?? []).map((h) => ({ src: s.label, ...h })))
L.push(`## 附錄 B — 分類器修正與空域（${hints.length} 筆修正）`, "")
L.push("Phase 0 的域提示是關鍵字分類器給的，**不是權威**。以下列出各源代理實際更正的部分；這些修正本身就是「為什麼機器分類不足以做這件事」的證據。", "")
if (hints.length) {
  L.push("| 源 | 模組 | 分類器提示 | 實際歸屬 | 理由 |")
  L.push("|---|---|---|---|---|")
  for (const h of hints.slice(0, 120)) L.push(`| ${h.src} | \`${esc(h.module)}\` | ${esc(h.hintWas)} | ${esc(h.assigned)} | ${esc(h.why)} |`)
  L.push("")
}
const absent = SOURCES.flatMap((s) => (perSource[s.key].domainsAbsent ?? []).map((a) => ({ src: s.label, ...a })))
L.push(`### 各源明確的空域（${absent.length}）`, "")
if (absent.length) {
  L.push("| 源 | 域 | 原因 |")
  L.push("|---|---|---|")
  for (const a of absent) L.push(`| ${a.src} | \`${esc(a.domain)}\` | ${esc(a.why)} |`)
  L.push("")
} else L.push("無。所有源在所有域都至少有一項機制。", "")

L.push(`## 附錄 C — 未對帳機制（${unclaimed.length} 項單源列）`, "")
L.push("這些機制**未被任何 crosswalk 認領**。它們可能是某源獨有能力，也可能只是命名未對上——本表無法區分，如實列出。", "")
L.push(unclaimed.map((m) => `\`${m.source}::${m.name}\``).join("、") || "（無）")
L.push("")

if (sharedDoc?.forkDeltas) {
  L.push(`## 附錄 D — opencode fork 差異（${sharedDoc.forkDeltas.length} 項）`, "")
  L.push("| 領域 | 變更 | 出處 |")
  L.push("|---|---|---|")
  for (const d of sharedDoc.forkDeltas) {
    L.push(`| ${esc(d.area)} | ${esc(d.change)} | ${(d.evidence ?? []).map((e) => `\`${esc(e)}\``).join("、")} |`)
  }
  L.push("")
}

const body = L.join("\n")
const front = FRONT ? readFileSync(FRONT, "utf8").trimEnd() + "\n\n" : ""
writeFileSync(OUT, front + body + "\n", "utf8")

console.log(`module coverage gate PASSED for all 7 sources`)
console.log(`rows: ${rows.length} (${rows.filter((r) => !r.single).length} cross-source, ${rows.filter((r) => r.single).length} single-source)`)
if (DISP) console.log(`dispositions: ${rows.filter((r) => disp[r.id]).length}/${rows.length} present`)
else console.log(`dispositions: NOT supplied -- the disposition column will be empty`)
console.log(`wrote ${OUT} (${(Buffer.byteLength(body) / 1024).toFixed(0)} KB body)`)
