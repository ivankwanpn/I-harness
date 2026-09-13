#!/usr/bin/env node
// scripts/audit/assemble-d2.mjs
//
// Phase 3 assembly of docs/audit/2026-09-11-sevenway-command-matrix.md (D2).
//
// The strict-union matrix across seven sources, sectioned by family. Cells are
// computed from the union data, never typed by hand, so the table can be
// regenerated and diffed.
//
// Two judgement calls are deliberately NOT automated:
//   * `disposition` comes from an authored file (--dispositions). A row without
//     one FAILS the build: emitting "TBD" would breach the design's
//     no-placeholder threshold, and defaulting it would invent a recommendation
//     nobody made.
//   * `—` (that source has no such layer) vs `✗` (the source has the layer but
//     not this command) is decided by an explicit per-source rule, stated in the
//     document, because conflating them would misreport a design difference as
//     a missing feature.
//
// Usage: node scripts/audit/assemble-d2.mjs --dispositions <json> --front <md> --out <md>

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { SOURCES, buildUnion, loadSources, norm } from "./lib-union.mjs"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")
const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 ? resolve(args[i + 1]) : dflt
}
const OUT = opt("--out", join(ROOT, "docs/audit/2026-09-11-sevenway-command-matrix.md"))
const FRONT = args.includes("--front") ? opt("--front") : null
const DISP = args.includes("--dispositions") ? opt("--dispositions") : null

function readJson(p) {
  if (!p || !existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch (err) {
    console.error(`! unparseable ${p}: ${err.message}`)
    return null
  }
}

const FAMILIES = [
  ["session", "會話生命週期"],
  ["context", "上下文與壓縮"],
  ["plan", "計劃與目標"],
  ["execution", "執行控制"],
  ["model", "模型與供應商"],
  ["safety", "權限與安全"],
  ["extension", "工具與擴展"],
  ["inspect", "檢視與輸出"],
  ["interface", "介面與外觀"],
  ["collab", "協作與多智能體"],
]

/**
 * Which sources lack a comparable static registry, so an absent command means
 * "not built in" rather than "unsupported". Stated explicitly in the document.
 */
const NO_STATIC_REGISTRY = new Set(["opencode", "opencode-fork"])

// ------------------------------------------------------------- rebuild union
// Folding lives in lib-union.mjs so this script and build-matrix.mjs cannot
// drift; the rules (normalisation, per-source collision resolution, cross-source
// hints) are documented there and are what the parity cells mean.
const loaded = loadSources(DATA)
const { rows, collisions } = buildUnion(loaded)

// ------------------------------------------------------------- dispositions
const disp = readJson(DISP) ?? {}
const dispOf = (key) => disp[key] ?? disp.rows?.[key] ?? null

const DISPOSITION_VALUES = new Set(["reuse", "rewrite", "improved-writing", "已存在", "遠期", "不做", "路線差異"])

const allRows = [...rows.values()].sort((a, b) => {
  const fa = FAMILIES.findIndex(([k]) => k === a.family)
  const fb = FAMILIES.findIndex(([k]) => k === b.family)
  if (fa !== fb) return (fa < 0 ? 99 : fa) - (fb < 0 ? 99 : fb)
  return a.key.localeCompare(b.key)
})

// A disposition is required for every row: no silent defaults.
const missingDisp = allRows.filter((r) => !dispOf(r.key)).map((r) => r.key)
const badDisp = allRows.filter((r) => dispOf(r.key) && !DISPOSITION_VALUES.has(dispOf(r.key).disposition ?? dispOf(r.key)))
if (missingDisp.length || badDisp.length) {
  if (missingDisp.length) {
    console.error(`\nDISPOSITION GATE FAILED: ${missingDisp.length} rows have no disposition`)
    console.error(`  ${missingDisp.slice(0, 40).join(", ")}${missingDisp.length > 40 ? " …" : ""}`)
  }
  if (badDisp.length) {
    console.error(`\nDISPOSITION GATE FAILED: ${badDisp.length} rows use an unknown disposition value`)
    console.error(`  allowed: ${[...DISPOSITION_VALUES].join(" / ")}`)
  }
  console.error("  refusing to emit a matrix with placeholders or invented recommendations")
  process.exit(1)
}

// ------------------------------------------------------------------- emit
const L = []
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim()
const cellFor = (row, src) => {
  const e = row.perSource[src]
  if (e) return "✓"
  return NO_STATIC_REGISTRY.has(src) ? "—" : "✗"
}

let ihOnly = 0
let refOnly = 0
for (const r of allRows) (r.perSource.ih ? ihOnly++ : refOnly++)

L.push("## 圖例", "")
L.push("| 符號 | 意義 |")
L.push("|---|---|")
L.push("| `✓` | 該源有此命令，語意相同 |")
L.push("| `✗` | 該源有此命令層，但沒有這個命令 |")
L.push("| `—` | 該源的命令模型不提供靜態內建（見下），「無」不等於「不支援」 |")
L.push("")
L.push(
  `> \`—\` 只用於 **opencode / opencode-fork**：它們靜態註冊的內建命令僅 2 個（\`init\`/\`review\`），其餘命令由使用者與設定以 markdown 模板在執行期定義。` +
    `因此這兩欄的「無」是**命令模型差異**，不是功能缺口。其餘五源皆有可枚舉的靜態命令表，缺席記為 \`✗\`。`,
)
L.push("")

for (const [fam, label] of FAMILIES) {
  const inFam = allRows.filter((r) => r.family === fam)
  if (!inFam.length) continue
  L.push(`## ${label}（\`${fam}\`，${inFam.length} 列）`, "")
  L.push("| 命令 | IH | dsh | codex | opencode | ocode-fork | grok | cc-custom | 機制／出處 | disposition |")
  L.push("|---|---|---|---|---|---|---|---|---|---|")
  for (const r of inFam) {
    // mechanism: prefer the IH entry, else the first source that has it
    const mechSrc = r.perSource.ih ?? r.perSource[Object.keys(r.perSource)[0]]
    const mech = mechSrc
      ? `${mechSrc.mechanism ? esc(mechSrc.mechanism).slice(0, 200) : esc(mechSrc.summary).slice(0, 200)}${mechSrc.evidence?.length ? ` \`${esc(mechSrc.evidence[0])}\`` : ""}`
      : ""
    const d = dispOf(r.key)
    const dv = d.disposition ?? d
    const dr = d.rationale ? ` — ${esc(d.rationale).slice(0, 120)}` : ""
    L.push(
      `| \`${r.key}\` | ${cellFor(r, "ih")} | ${cellFor(r, "dsh")} | ${cellFor(r, "codex")} | ${cellFor(r, "opencode")} | ${cellFor(r, "opencode-fork")} | ${cellFor(r, "grok")} | ${cellFor(r, "cc-custom")} | ${mech} | **${dv}**${dr} |`,
    )
  }
  L.push("")
}

const unclassified = allRows.filter((r) => !r.family)
if (unclassified.length) {
  L.push(`## 未分類（${unclassified.length} 列）`, "")
  L.push("| 命令 | IH | dsh | codex | opencode | ocode-fork | grok | cc-custom | disposition |")
  L.push("|---|---|---|---|---|---|---|---|---|")
  for (const r of unclassified) {
    const d = dispOf(r.key)
    L.push(
      `| \`${r.key}\` | ${cellFor(r, "ih")} | ${cellFor(r, "dsh")} | ${cellFor(r, "codex")} | ${cellFor(r, "opencode")} | ${cellFor(r, "opencode-fork")} | ${cellFor(r, "grok")} | ${cellFor(r, "cc-custom")} | **${d.disposition ?? d}** |`,
    )
  }
  L.push("")
}

// Appendix A: each source's own list, verbatim
L.push("## 附錄 A — 各源自身命令清單（原樣抽出，不合併）", "")
for (const { key, label } of SOURCES) {
  const b = loaded[key]
  if (!b) continue
  const list = [...(b.enriched?.commands ?? b.raw?.commands ?? [])]
  for (const a of b.enriched?.added ?? []) {
    if (typeof a === "string") list.push({ rawName: a })
    else if (a && typeof a === "object") list.push(a)
  }
  L.push(`### ${label}（${list.length}）`, "")
  L.push(list.map((c) => `\`${c.rawName ?? c.canonical}\``).join("、"))
  L.push("")
}

const body = L.join("\n")
const front = FRONT ? readFileSync(FRONT, "utf8").trimEnd() + "\n\n" : ""
writeFileSync(OUT, front + body + "\n", "utf8")

console.log(`rows: ${allRows.length}  (IH column ${ihOnly}, reference-only ${refOnly})`)
console.log(`dispositions: ${allRows.length}/${allRows.length} present`)
console.log(`wrote ${OUT} (${(Buffer.byteLength(body) / 1024).toFixed(0)} KB body)`)
