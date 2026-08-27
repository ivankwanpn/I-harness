// 吸收 codex windows-sandbox-rs/src/audit.rs 之世界可寫掃描（限時限量 gather、
// cwd 先行）——改寫為 I-harness 版：node + koffi、純查詢回報、**不自動 deny**。
// （我方 WRITE_RESTRICTED 基座無 deny-anchor principal——研究 A.2；僅回報供
// consent/文檔使用。）MIT 歸屬：THIRD_PARTY_NOTICES（OpenAI codex-rs）。
//
// Scope note (M22 決定)：現有 acl.ts 的 readCurrentDacl 未 export 且無 ACE
// 枚舉（GetAce/GetExplicitEntriesFromAclW 未綁定）；本模組以「掃描驅動 +
// 注入式 DACL probe」交付——probe 注入補全時（未來里程碑）即得真 ACL 判定。
import { readdirSync } from "node:fs"
import { join } from "node:path"

export interface WorldWritableFinding {
  path: string
  // future probe may return the granting principal; today only "Everyone" is
  // reported（注入式 probe 尚無 principal 溝通能力——先行假設最廣）。
  who: "Everyone" | "Authenticated-Users"
}

export interface ScanOptions {
  maxItemsPerDir?: number // 預設 500
  totalBudgetMs?: number // 預設 2000
}

// DACL 能力檢查的注入面：回傳 null 表示「無法判定/不支援」——findings 不含它，
// 但掃描仍可枚舉（誠實：unverified entries 不報為 finding）。
export type DaclWriteProbe = (path: string) => "world-writable" | "safe" | "unknown"

const DEFAULT_MAX_ITEMS = 500
const DEFAULT_BUDGET_MS = 2000

export async function scanWorldWritable(
  dirs: readonly string[],
  opts: ScanOptions & { probe?: DaclWriteProbe } = {},
): Promise<WorldWritableFinding[]> {
  const maxItems = opts.maxItemsPerDir ?? DEFAULT_MAX_ITEMS
  const deadline = Date.now() + (opts.totalBudgetMs ?? DEFAULT_BUDGET_MS)
  const probe = opts.probe ?? (() => "unknown" as const)
  const findings: WorldWritableFinding[] = []
  for (const dir of dirs) {
    if (Date.now() > deadline) break
    try {
      let seen = 0
      // 非遞迴列舉：seed 目錄平鋪掃描，深度由 caller 控制（dirs 傳入哪些就掃哪些）
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (Date.now() > deadline || ++seen > maxItems) break
        const child = join(dir, entry.name)
        const verdict = probe(child)
        if (verdict === "world-writable") {
          findings.push({ path: child, who: "Everyone" })
        }
        // verdict === "unknown"：不判定——由呼叫端（文檔/未來）決定可擴充
      }
    } catch {
      // unreadable dir → skip（fail-open 到「此 dir 無發現」——audit 是監視非 enforcement）
    }
  }
  return findings
}
