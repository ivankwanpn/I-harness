// packages/guard-approval/src/remember.ts
// 吸收 codex execpolicy prefix rules（exec_policy.rs:56-76 BANNED_PREFIX_SUGGESTIONS
// + add_prefix_rule Decision::Allow）：命令前綴級 remember，跨 session、JSON 檔落盤。
// 安全針臺：shell/解釋器永不 remember（否則等於全放行）。
// MIT 歸屬：見 THIRD_PARTY_NOTICES（OpenAI codex-rs）。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export interface RememberRule {
  prefix: string[]
  createdAt: string
}

export const BANNED_PREFIX_PATTERNS: readonly string[][] = [
  ["bash"], ["bash", "-c"], ["bash", "-lc"],
  ["cmd"], ["cmd", "/c"], ["cmd", "/k"], ["cmd.exe"],
  ["pwsh"], ["pwsh", "-Command"], ["powershell"], ["powershell", "-Command"],
  ["sh"], ["sh", "-c"], ["zsh"], ["zsh", "-c"],
  ["node", "-e"], ["bun", "-e"],
]

export interface RememberStore {
  load(): RememberRule[]
  save(rules: RememberRule[]): void
  matches(argv: string[]): boolean
  add(rule: RememberRule): { ok: boolean; reason?: string }
}

export function createRememberStore(filePath: string): RememberStore {
  const load = (): RememberRule[] => {
    try {
      return JSON.parse(readFileSync(filePath, "utf-8")) as RememberRule[]
    } catch {
      return []
    }
  }
  const save = (rules: RememberRule[]): void => {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(rules, null, 2), "utf-8")
  }
  return {
    load,
    save,
    matches(argv) {
      return load().some((r) => r.prefix.every((p, i) => argv[i]?.toLowerCase() === p.toLowerCase()))
    },
    add(rule) {
      const banned = BANNED_PREFIX_PATTERNS.some((b) =>
        rule.prefix.slice(0, b.length).every((p, i) => p.toLowerCase() === b[i]!.toLowerCase()),
      )
      if (banned) return { ok: false, reason: "shell/interpreters cannot be remembered (would approve everything)" }
      const rules = load()
      if (rules.some((r) => r.prefix.length === rule.prefix.length && r.prefix.every((p, i) => p.toLowerCase() === rule.prefix[i]!.toLowerCase()))) {
        return { ok: false, reason: "rule already exists" }
      }
      rules.push(rule)
      save(rules)
      return { ok: true }
    },
  }
}
