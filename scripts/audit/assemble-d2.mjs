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

// Appendix B: reconciliation doubts. This is the honest counterpart to the
// crosswalk -- the pairs the automated fold joined but a human should confirm,
// plus the ones it refused to join. An empty appendix would mean either that the
// seven sources name everything identically (they demonstrably do not) or that
// the fold guessed silently.
L.push("## 附錄 B — 未對帳與存疑對帳", "")
L.push(
  "本附錄列出**自動折疊做過判斷、但值得人工複核**的列。空著不代表對帳完美，而代表沒有觸發以下三種訊號。",
)
L.push("")

L.push(`### B1. 同源名稱碰撞（${collisions.length}）`, "")
if (collisions.length === 0) {
  L.push("無。沒有任一源出現「兩個命令正規化到同一 key」的情況。", "")
} else {
  L.push("同一源的兩個命令被抽取代理正規化為同一個名字。**兩者都已退回自己的命令名**，否則其中一個會靜默消失。", "")
  L.push("| 源 | 命令 A | 命令 B | 曾共同被正規化為 |")
  L.push("|---|---|---|---|")
  for (const c of collisions) {
    L.push(`| ${c.source} | \`${c.names[0]}\` | \`${c.names[1]}\` | \`${c.canonical}\` |`)
  }
  L.push("")
}

// B2: rows joined across sources where the sources disagree about the family.
// A disagreement is the clearest automatic signal that two differently-shaped
// capabilities may have been folded into one row.
const famDisagreements = allRows
  .map((r) => {
    const fams = [...new Set(Object.values(r.perSource).map((v) => v.family).filter(Boolean))]
    return { row: r, fams }
  })
  .filter((x) => x.fams.length > 1)

L.push(`### B2. 跨源家族不一致（${famDisagreements.length}）`, "")
L.push(
  "同一列在不同源被歸入不同家族。這**不一定是錯**（不少命令合理地跨家族），但它是最便宜的「這兩者真的是同一個東西嗎」訊號。",
)
L.push("")
if (famDisagreements.length === 0) {
  L.push("無。", "")
} else {
  L.push("| 命令 | 各源家族 | 參與的源 |")
  L.push("|---|---|---|")
  for (const { row, fams } of famDisagreements.slice(0, 40)) {
    const detail = Object.entries(row.perSource)
      .filter(([, v]) => v.family)
      .map(([s, v]) => `${s}=${v.family}`)
      .join(", ")
    L.push(`| \`${row.key}\` | ${fams.join(" / ")} | ${detail} |`)
  }
  if (famDisagreements.length > 40) L.push(`| … | 其餘 ${famDisagreements.length - 40} 列 | |`)
  L.push("")
}

// B3: single-source rows. These are NOT errors -- most are genuinely unique to
// one harness -- but they are the rows where a hidden synonym would be invisible,
// because there is no second source to disagree with.
const singleSource = allRows.filter((r) => Object.keys(r.perSource).length === 1)
L.push(`### B3. 單源獨有列（${singleSource.length}）`, "")
L.push(
  "只出現在一個源的命令。多數是該源真正獨有，但這也是**同義異名最難被發現的一類**——沒有第二個源可以反駁。",
)
L.push("")
const singleBySource = {}
for (const r of singleSource) {
  const s = Object.keys(r.perSource)[0]
  singleBySource[s] = (singleBySource[s] ?? 0) + 1
}
L.push(`分佈：${Object.entries(singleBySource).map(([s, n]) => `${s} ${n}`).join(" · ")}`, "")
L.push(`清單：${singleSource.map((r) => `\`${r.key}\``).join("、")}`, "")

// Appendix C: the crosswalk. Only rows where at least one source's own command
// name differs from the row key are real mappings; everything else matched by
// identical name and needs no table.
L.push("## 附錄 C — crosswalk 對照表", "")
L.push("只列出**至少一個源的命令名與本列 key 不同**的列；名字一致的列不需要對照。", "")
L.push("| 列 key | " + SOURCES.map((s) => s.label).join(" | ") + " |")
L.push("|---|" + SOURCES.map(() => "---").join("|") + "|")
let xwalk = 0
for (const r of allRows) {
  const cells = SOURCES.map(({ key }) => {
    const e = r.perSource[key]
    if (!e) return ""
    const names = [e.rawName, ...(e.aliases ?? [])].filter(Boolean)
    const differs = names.some((n) => norm(n) !== r.key)
    return differs ? names.map((n) => `\`${n}\``).join(" · ") : "="
  })
  if (!cells.some((c) => c && c !== "=")) continue
  xwalk++
  L.push(`| \`${r.key}\` | ${cells.join(" | ")} |`)
}
if (xwalk === 0) L.push(`| （無） | ${SOURCES.map(() => "").join(" | ")} |`)
L.push("")
L.push(`> \`=\` 表示該源以同名列參與此列。共 ${xwalk} 列涉及異名映射。`, "")

const body = L.join("\n")
const front = FRONT ? readFileSync(FRONT, "utf8").trimEnd() + "\n\n" : ""
writeFileSync(OUT, front + body + "\n", "utf8")

console.log(`rows: ${allRows.length}  (IH column ${ihOnly}, reference-only ${refOnly})`)
console.log(`dispositions: ${allRows.length}/${allRows.length} present`)
console.log(`wrote ${OUT} (${(Buffer.byteLength(body) / 1024).toFixed(0)} KB body)`)
