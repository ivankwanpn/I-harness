#!/usr/bin/env node
// scripts/audit/assemble-d1.mjs
//
// Phase 3 assembly of docs/audit/2026-09-11-ih-backend-inventory.md (D1).
//
// Mechanical structure, authored judgement. The script emits the package-by-
// package body from the extraction agents' JSON so that no package can be
// silently omitted (design §8 threshold 1 = 65/65), the coverage table is
// derived rather than asserted, and every claim keeps its file:line citation.
// The framing sections around the body are authored by hand and passed in via
// --front, because a generator has no business writing judgement.
//
// It FAILS LOUDLY if the package set does not exactly match the in-scope set
// from ih-surface.json: a mismatch means either a missing agent group or a
// package that drifted out of scope, and either way the inventory would be
// lying about its own coverage.
//
// Usage: node scripts/audit/assemble-d1.mjs --front <md> --out <md>

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")
const args = process.argv.slice(2)
const outIdx = args.indexOf("--out")
const frontIdx = args.indexOf("--front")
const OUT = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(ROOT, "docs/audit/2026-09-11-ih-backend-inventory.md")
const FRONT = frontIdx >= 0 ? resolve(args[frontIdx + 1]) : null

function readJson(p) {
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch (err) {
    console.error(`! unparseable ${p}: ${err.message}`)
    return null
  }
}

// ------------------------------------------------------------------ load

const surface = readJson(join(DATA, "2026-09-11-ih-surface.json"))
if (!surface) {
  console.error("! missing 2026-09-11-ih-surface.json -- run extract-ih-surface.mjs first")
  process.exit(1)
}
const inScope = new Set(surface.packages.map((p) => p.name))

const GROUPS = [
  { file: "2026-09-11-ih-backend-engine.json", title: "引擎與會話核心", key: "engine" },
  { file: "2026-09-11-ih-backend-tools.json", title: "工具與執行面", key: "tools" },
  { file: "2026-09-11-ih-backend-safety-model.json", title: "沙箱、守衛與模型面", key: "safety-model" },
  { file: "2026-09-11-ih-backend-service.json", title: "服務面、生態與多智能體", key: "service" },
]

const groups = []
const seen = new Map()
for (const g of GROUPS) {
  const data = readJson(join(DATA, g.file))
  if (!data) {
    console.error(`! MISSING GROUP FILE ${g.file}`)
    continue
  }
  for (const p of data.packages) {
    if (seen.has(p.name)) console.error(`! package ${p.name} appears in two groups`)
    seen.set(p.name, g.key)
  }
  groups.push({ ...g, data })
}

// ------------------------------------------------------- coverage gate

const missing = [...inScope].filter((n) => !seen.has(n)).sort()
const extra = [...seen.keys()].filter((n) => !inScope.has(n)).sort()
if (missing.length || extra.length) {
  console.error(`\nCOVERAGE GATE FAILED`)
  if (missing.length) console.error(`  in scope but uncharacterised (${missing.length}): ${missing.join(", ")}`)
  if (extra.length) console.error(`  characterised but out of scope (${extra.length}): ${extra.join(", ")}`)
  console.error(`  coverage would be ${seen.size - extra.length}/${inScope.size}; refusing to write a document that overstates it`)
  process.exit(1)
}

// ------------------------------------------------------------------ emit

const L = []
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim()

// coverage table
L.push(`## 覆蓋率總表（${inScope.size}/${inScope.size} 包）`, "")
L.push("| 包 | 分組 | 職責（截斷） | 設計決策 | 缺口 | 引註 |")
L.push("|---|---|---|---|---|---|")
const surfaceByName = new Map(surface.packages.map((p) => [p.name, p]))
let totalEvidence = 0
let totalDecisions = 0
let packagesWithGaps = 0
for (const g of groups) {
  for (const p of g.data.packages) {
    const ev = (p.evidence?.length ?? 0) + (p.designDecisions ?? []).reduce((a, d) => a + (d.evidence?.length ?? 0), 0)
    totalEvidence += ev
    totalDecisions += (p.designDecisions ?? []).length
    if ((p.gaps ?? []).length) packagesWithGaps++
    L.push(`| \`${p.name}\` | ${g.key} | ${esc(p.responsibility).slice(0, 90)}… | ${(p.designDecisions ?? []).length} | ${(p.gaps ?? []).length} | ${ev} |`)
  }
}
L.push("")
L.push(
  `合計 **${inScope.size}** 包、**${totalDecisions}** 條設計決策、**${totalEvidence}** 條引註；` +
    `**${packagesWithGaps}** 包有原始碼內標記的已知缺口。`,
)
L.push("")

// per group
for (const g of groups) {
  L.push(`## ${g.title}`, "")
  for (const p of g.data.packages) {
    const s = surfaceByName.get(p.name)
    L.push(`### \`${p.name}\``, "")
    L.push(esc(p.responsibility), "")
    if (s) {
      const bits = []
      if (s.packageName) bits.push(`npm \`${s.packageName}\``)
      if (s.entry) bits.push(`入口 \`${s.entry}\``)
      bits.push(`${s.srcFiles} 個原始檔`)
      bits.push(`${s.exportCount} 個匯出符號`)
      L.push(`> ${bits.join(" · ")}`, "")
    }
    if (p.publicSurface?.length) {
      L.push(`**公開介面**：${p.publicSurface.map((x) => `\`${x}\``).join("、")}`, "")
    }
    if (p.designDecisions?.length) {
      L.push(`**關鍵設計決策**`, "")
      p.designDecisions.forEach((d, i) => {
        L.push(`${i + 1}. **${esc(d.decision)}**`)
        if (d.rationale) L.push(`   - 理由：${esc(d.rationale)}`)
        if (d.evidence?.length) L.push(`   - 出處：${d.evidence.map((e) => `\`${e}\``).join("、")}`)
      })
      L.push("")
    }
    if (p.failurePolicy) L.push(`**失敗策略**：${esc(p.failurePolicy)}`, "")
    if (p.events?.length) L.push(`**事件**：${p.events.map((e) => `\`${e}\``).join("、")}`, "")
    if (p.keyConstants?.length) {
      L.push(`**關鍵常數**`, "")
      L.push("| 名稱 | 值 | 出處 |")
      L.push("|---|---|---|")
      for (const k of p.keyConstants) L.push(`| \`${esc(k.name)}\` | ${esc(k.value)} | \`${esc(k.evidence)}\` |`)
      L.push("")
    }
    if (p.gaps?.length) {
      L.push(`**已知缺口（原始碼內標記）**`, "")
      for (const gp of p.gaps) L.push(`- ${esc(gp)}`)
      L.push("")
    }
    L.push("---", "")
  }
}

// command surface + CLI hosts
const cmds = readJson(join(DATA, "2026-09-11-ih-commands-enriched.json"))
if (cmds) {
  L.push("## 命令面（50 個 slash 命令的端到端後端路徑）", "")
  L.push(esc(cmds.commandModelNote ?? ""), "")
  const byStatus = {}
  for (const c of cmds.commands) {
    const k = c.backendStatus ?? "(unset)"
    byStatus[k] = (byStatus[k] ?? 0) + 1
  }
  L.push(`**後端狀態分佈**：${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(" · ")}`, "")
  L.push("| 命令 | 家族 | 閘 | 後端模組 | 狀態 | 機制 |")
  L.push("|---|---|---|---|---|---|")
  for (const c of [...cmds.commands].sort((a, b) => a.rawName.localeCompare(b.rawName))) {
    L.push(
      `| \`/${c.rawName}\`${c.aliases?.length ? ` (${c.aliases.map((a) => "/" + a).join(", ")})` : ""} | ${c.family ?? ""} | ${esc(c.gate).slice(0, 60)} | \`${esc(c.backendModule)}\` | ${c.backendStatus ?? ""} | ${esc(c.mechanism).slice(0, 260)} |`,
    )
  }
  L.push("")
  if (cmds.cliHosts?.length) {
    L.push("## CLI 宿主面", "")
    for (const h of cmds.cliHosts) {
      L.push(`### \`i-harness ${h.host}\``, "")
      if (h.behaviour || h.note) L.push(esc(h.behaviour ?? h.note), "")
      if (h.flags?.length) {
        L.push("| 旗標 | 行為 | 驗證 | 出處 |")
        L.push("|---|---|---|---|")
        for (const f of h.flags) {
          L.push(`| \`${esc(f.flag)}\` | ${esc(f.behaviour)} | ${esc(f.validation)} | \`${esc(f.evidence)}\` |`)
        }
        L.push("")
      }
    }
  }
}

const body = L.join("\n")
const front = FRONT ? readFileSync(FRONT, "utf8").trimEnd() : ""
writeFileSync(OUT, (front ? front + "\n\n" : "") + body + "\n", "utf8")

console.log(`coverage gate PASSED: ${inScope.size}/${inScope.size} packages`)
console.log(`groups: ${groups.map((g) => `${g.key}=${g.data.packages.length}`).join(" ")}`)
console.log(`decisions: ${totalDecisions}  citations: ${totalEvidence}`)
console.log(`wrote ${OUT} (${(Buffer.byteLength(body) / 1024).toFixed(0)} KB body)`)
