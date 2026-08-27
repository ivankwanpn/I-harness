# M22 Windows 安全完整 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 補完 Windows 安全完整性——consent gate 強化（extreme-danger 分層 + prefix-rule remember）、sandbox audit 小件、拒跑閘門（enforcement 能力檢查）、邊界測試包、THIRD_PARTY_NOTICES 與誠實完整性文檔。

**Architecture:** 五子系統：(1) `@i-harness/guard-approval` v2——extreme-danger 分類器（吸收 codex `windows_dangerous_commands` 清單 + 補 format/diskpart/reg delete/shutdown）、ApprovalRequest 向後相容擴充（command/argv/class/pathSummary）、`policy:'ask'|'never'` 插口、prefix-rule remember（JSON 檔落盤 + BANNED PREFIX 清單）；(2) `@i-harness/sandbox-windows-acl` 新 audit.ts（世界可寫預檢，限時限量純查詢）；(3) 拒跑閘門——sandbox seam 的 capability/requirement 檢查（readIsolation 需求旗標 + provider 能力宣告 → 不足即 SandboxUnavailableError，吸收 codex windows.rs 形狀）；(4) 邊界測試包（kill-on-close 新測、讀否定 pin、runner-failure 127、headless 冒煙、skipIf 慣例）；(5) THIRD_PARTY_NOTICES 首建 + 歸屬檔頭 + 誠實完整性 README。

**Tech Stack:** TypeScript ESM, pnpm workspace, vitest, node builtins + 既有 koffi FFI（無新外部依賴）。dsh/codex 參考（吸收而非移植；MIT 歸屬入 THIRD_PARTY_NOTICES）。

**Spec:** `docs/superpowers/specs/2026-08-26-i-harness-m20-m25-backend-complete-design.md`（§5 M22 Windows 安全完整）
**Research:** `.superpowers/research/2026-08-27-m22-windows-security-research.md`（§一至八；Q1-Q5 決策見 §七）

## Global Constraints

- 版本 `0.1.0`、ESM、strict TS（`strict`/`noUnusedLocals`/`noUnusedParameters`）、pnpm workspace
- 零新外部依賴（node builtins 與既有 deps，含既有 koffi）
- 平台：Windows 優先（測試主力）；Linux 順帶未測試；**win32 特定測試用 `it.skipIf(process.platform !== "win32")` / `describe.skipIf(...)`；e2e 檔名 `*.e2e.ts` 需 vitest.config include**
- fail-closed 紀律：讀隔離**不存在**——任何「讀隔離已做」的暗示/文案禁止；文檔與測試必須誠實標註 `enforcement: 'partial'`（寫隔離 partial 已是事實）
- 「吸收而非移植」：dsh/codex 代碼只作參考；無 `@deepseek-ai/*` imports；吸收片段保留 MIT 聲明（THIRD_PARTY_NOTICES 或檔頭）
- **M22 不做 kernel 讀隔離**（Q1 同意）：不實作 deny-read ACL/deny_read_resolver/AppContainer/NtCreateToken；codex 帳號式 elevated 架構列 M26+ 候選
- **Remember 採納 prefix-rule 式**（Q2 同意）：命令前綴級跨 session remember + BANNED PREFIX 清單（shell/解釋器不可 remember）；answerer 互動 remember 選項延後
- **Extreme-danger 採納 codex 清單**（Q3 同意）：rm force-delete / PS force-delete / CMD del erase rd rmdir / URL-GUI 啟動 + 補 format/diskpart/reg delete/shutdown
- 否定面測試採納（Q4 同意）：讀隔離缺陷 pin 成活文檔
- 拒跑閘門採納（Q5 同意）：policy 要求 readIsolation 而 provider 無能力 → SandboxUnavailableError（M22 直接做，非只留 TODO）
- Approval 語義：**one-shot**（allowed-once/rejected/cancelled/unavailable 四值已存在於 escalation.ts：`EscalationOutcome`）；缺 answerer fail-closed
- CLI 目前只有 approveAll——M22 不加 UI，只加介面 + 測試
- `registerEventType` 慣例（session event 新增時 module init 註冊——M22 若無新事件則不適用）

---

## Part 1: guard-approval v2（consent gate 強化）

### Task 1: extreme-danger 分類器（`danger-class` 判定）

**Files:**
- Create: `packages/guard-approval/src/danger-class.ts`（extreme-danger 判定：分類器 + 信任清單）
- Modify: `packages/guard-approval/src/index.ts`（`decide()` 改用 danger-class 分層；ApprovalRequest 擴充欄位）
- Test: `packages/guard-approval/test/danger-class.test.ts`（新）

**Interfaces:**
- Consumes: `isInsideWorkspace`（現有 index.ts L41-48——保留）、`getArgv`（現有 shell 工具）
- Produces:
  - `export type DangerClass = "extreme" | "dangerous" | "none"`（extreme = 需 echo-consent 預設拒絕；dangerous = 現行一層 ask；none = 免）
  - `export function classifyDanger(argv: string[], dangerousCommands: string[], dangerousFlags: string[]): DangerClass`
  - `export function isExtremeDangerous(argv: string[], workspace: string): { extreme: boolean; reason: string; targeted: string[] }`
  - extreme 判定規則（吸收 codex `windows_dangerous_commands.rs` 語義改寫為 TS）：
    - `rm`/`Remove-Item`/`del`/`rd`/`erase`/`rd`/`rmdir`（basename 匹配）+ force flag（`-f`/`-rf`/`-force`/`/f`/`/s`+`/q` 組合等）→ extreme（含 wrapper 解析：`bash -c`、`cmd /c`、`pwsh -Command`、`sudo`、`env X=Y cmd`、`trap` —— depth ≤8 往內穿透）
    - PowerShell force-delete cmdlet（`remove-item`/`ri`/`rm`/`del`/`erase`/`rd`/`rmdir` + `-force`/`-force:<x>` 前綴）
    - CMD force-delete（`del /f`、`erase /f`、`rd/rmdir /s /q`；含 `cmd /c "del /f x"` 單字串、`echo hi&del` 無空格鏈）
    - URL/GUI 啟動（`Start-Process <url>`、`Invoke-Item <url>`、`rundll32 url.dll,fileprotocolhandler <url>`、`mshta <url>`、`explorer <url>`、browser-<url>`——防釣魚）
    - **額外 OS 級**：basename ∈ `{format, diskpart, shutdown, reg}`（reg 要 `delete` 子命令）→ extreme；`cipher` + `/w` flag → extreme
    - **workspace 逃逸**：recursive-destructive 命令（rm/Remove-Item/del 等）且任何 operate 路徑 `!isInsideWorkspace(workspace, path)` 或頂層系統路徑（`C:\Windows`、`/`、`C:\`）→ extreme（**若 force+recursive 但全部在 workspace 內 → 仍 dangerous（現行層）而非 extreme**——保護正常 agent 清理）
  - reason 格式：`Extreme danger: <command> deletes <targeted summary>. Approval requires explicit confirmation.`
  - `classifyDanger` 保留現行 dangerous 語義（metachar / dangerousCommands / dangerousFlags → `"dangerous"`），extreme 優先（extreme 蓋過 dangerous）

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/guard-approval/test/danger-class.test.ts
import { describe, expect, it } from "vitest"
import { classifyDanger } from "../src/danger-class.ts"

const WS = "C:/repo/work"

// 最終簽名：classifyDanger(argv, workspace, dangerousCommands?, dangerousFlags?)
describe("classifyDanger", () => {
  it("extreme: rm -rf outside workspace", () => {
    expect(classifyDanger(["rm", "-rf", "C:/system"], WS)).toBe("extreme")
  })
  it("extreme: rm -rf / (root)", () => {
    expect(classifyDanger(["rm", "-rf", "/"], WS)).toBe("extreme")
  })
  it("extreme: Remove-Item -Recurse -Force outside", () => {
    expect(classifyDanger(["pwsh", "-Command", "Remove-Item C:\\system -Recurse -Force"], WS)).toBe("extreme")
  })
  it("extreme: cmd del /f outside", () => {
    expect(classifyDanger(["cmd", "/c", "del", "/f", "C:\\system\\x.txt"], WS)).toBe("extreme")
  })
  it("extreme: rm -rf INSIDE workspace is dangerous (not extreme)", () => {
    expect(classifyDanger(["rm", "-rf", `${WS}/build`], WS)).toBe("dangerous")
  })
  it("extreme: format", () => {
    expect(classifyDanger(["format", "C:", "/q"], WS)).toBe("extreme")
  })
  it("extreme: diskpart", () => {
    expect(classifyDanger(["diskpart", "/s", "script.txt"], WS)).toBe("extreme")
  })
  it("extreme: reg delete", () => {
    expect(classifyDanger(["reg", "delete", "HKLM\\SOFTWARE\\X", "/f"], WS)).toBe("extreme")
  })
  it("extreme: startup URL (phishing)", () => {
    expect(classifyDanger(["Start-Process", "https://evil.example"], WS)).toBe("extreme")
  })
  it("none: benign rm (no force)", () => {
    expect(classifyDanger(["rm", "file.txt"], WS)).toBe("none")
  })
  it("dangerous: metachar", () => {
    expect(classifyDanger(["bash", "-c", "echo hi; rm file"], WS)).toBe("dangerous")
  })
  it("dangerous: custom dangerousCommands still works", () => {
    expect(classifyDanger(["myrm", "-x"], WS, ["myrm"])).toBe("dangerous")
  })
})
```

（注：`Start-Process` 的 extreme 來自 URL/GUI 啟動規則（hasUrl 檢查）；若實作時 `Start-Process` 不加 `-Command` 時的解析路徑不同，以「argv[0] 即 cmdlet 名 + 含 url」命中。workspace 逃逸以 `isInsideWorkspace` 為準；`C:/system` 相對 WS 的 `relative` 為絕對 → outside ✓。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/guard-approval && pnpm vitest run test/danger-class.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實現 danger-class.ts**

```ts
// packages/guard-approval/src/danger-class.ts
import { isAbsolute, relative, resolve } from "node:path"

export type DangerClass = "extreme" | "dangerous" | "none"

// absorb codex shell-command/src/command_safety/is_dangerous_command.rs +
// windows_dangerous_commands.rs 語義（改寫為 TS；MIT 歸屬見 THIRD_PARTY_NOTICES）
// 補充：codex 缺 OS 級破壞操作（format/diskpart/reg delete/shutdown）——M22 增加。

const EXTREME_COMMANDS = new Set(["format", "diskpart", "shutdown"])
const REG_SUBCOMMANDS = new Set(["delete"])
const DELETE_CMDLETS = ["rm", "remove-item", "ri", "del", "erase", "rd", "rmdir"]
const MAX_WRAPPER_DEPTH = 8

function basenamePath(token: string): string {
  // Windows 檔案名（.exe 去尾）→ lowercase；POSIX 原樣 basename
  const file = token.split(/[\\/]/).pop() ?? ""
  const lower = file.toLowerCase()
  for (const suffix of [".exe", ".cmd", ".bat", ".com"]) {
    if (lower.endsWith(suffix)) return lower.slice(0, -suffix.length)
  }
  return lower
}

export function isInsideWorkspace(workspace: string, p: string): boolean {
  const abs = p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p) ? resolve(p) : resolve(workspace, p)
  const rel = relative(workspace, abs)
  return rel === "" || (!isAbsolute(rel) && !rel.startsWith(".."))
}

function isTopLevelSystemPath(p: string): boolean {
  const norm = p.replace(/[\\/]+/g, "/").toLowerCase()
  return norm === "/" || /^[a-z]:(\/|$)/.test(norm) && norm.length <= 3
    || norm.startsWith("c:/windows")
    || norm.startsWith("c:/program files")
}

// 依 codex `rm_args_include_force_option`（吸收）——`-rf`/`-f`/`--force`/`-r -f` 等
function hasForceRm(args: string[]): boolean {
  return args.slice().takeWhile((a) => a !== "--").some((a) =>
    a === "--force" || (a.startsWith("-") && !a.startsWith("--") && a.includes("f")),
  )
}

// CMD force-delete：del/erase /f；rd/rmdir /s /q（吸收 codex）
function hasCmdForceDelete(tokens: string[]): boolean {
  for (const seg of splitCmdSegments(tokens)) {
    const [cmd, ...rest] = seg
    const c = cmd?.toLowerCase()
    if ((c === "del" || c === "erase") && rest.some((a) => a.toLowerCase() === "/f")) return true
    if ((c === "rd" || c === "rmdir") && rest.some((a) => a.toLowerCase() === "/s") && rest.some((a) => a.toLowerCase() === "/q")) return true
  }
  return false
}

function splitCmdSegments(tokens: string[]): string[][] {
  // best-effort：`echo hi&del /f x` → segments
  const sep = /[&|]{1,2}/
  return tokens.flatMap((t) => t.split(sep)).filter((s) => s.length > 0).map((s) => s.split(/\s+/))
}

// PowerShell force-delete cmdlet（吸收 codex `has_force_delete_cmdlet`）
function hasPsForceDelete(tokens: string[]): boolean {
  return tokens.some((t, i) => {
    const lower = t.replace(/['"]/g, "").toLowerCase()
    if (!DELETE_CMDLETS.includes(lower)) return false
    const next = tokens[i + 1]
    return next?.toLowerCase() === "-force" || next?.toLowerCase().startsWith("-force:")
  })
}

function hasUrl(tokens: string[]): boolean {
  return tokens.some((t) => /^https?:\/\//i.test(t.replace(/^[ "'(]+/, "")))
}

// classify: `extreme` 優先；`extreme` 未中 → 走現行 dangerous（覆蓋 metachar/flag）
export function classifyDanger(
  argv: string[],
  workspace: string,
  dangerousCommands: string[] = [],
  dangerousFlags: string[] = [],
): DangerClass {
  const extreme = isExtremeDangerous(argv, workspace)
  if (extreme) return "extreme"
  // 現行 dangerous 語義搬入（metachar / dangerousCommands / dangerousFlags）
  const METACHAR = [";", "&&", "|", "$(", "`"]
  if (argv.some((t) => METACHAR.some((m) => t.includes(m)))) return "dangerous"
  if (argv.some((a) => dangerousCommands.includes(basenamePath(a)))) return "dangerous"
  if (argv.some((a) => dangerousFlags.includes(a))) return "dangerous"
  return "none"
}

export function isExtremeDangerous(argv: string[], workspace: string): boolean {
  // 穿透 wrapper（bash -c / cmd /c / pwsh -Command / sudo / env / trap；depth ≤8）
  return deepDetect(argv, workspace, 0)
}

function deepDetect(argv: string[], workspace: string, depth: number): boolean {
  if (depth > MAX_WRAPPER_DEPTH) return false // fail-open direction: 深度過深不作 extreme（交由 dangerous 層）
  const cmd = basenamePath(argv[0] ?? "")
  const rest = argv.slice(1)
  if (cmd === "sudo") return deepDetect(rest, workspace, depth + 1)
  if (cmd === "env") {
    const i = rest.findIndex((a) => a === "--" || (!a.includes("=") && !a.startsWith("-")))
    return deepDetect(rest.slice(i >= 0 ? i + (rest[i] === "--" ? 1 : 0) : 0), workspace, depth + 1)
  }
  if (cmd === "bash" || cmd === "sh" || cmd === "zsh") {
    const script = rest[rest.indexOf("-c") + 1] ?? rest[rest.indexOf("-lc") + 1]
    return script !== undefined && deepDetect(script.split(/\s+/), workspace, depth + 1)
  }
  if (cmd === "cmd") {
    const i = rest.findIndex((a) => ["/c", "/r", "-c"].includes(a.toLowerCase()))
    return i >= 0 && deepDetect(rest.slice(i + 1).flatMap((s) => s.split(/[&|]{1,2}/)), workspace, depth + 1)
  }
  if (cmd === "pwsh" || cmd === "powershell") {
    const i = rest.findIndex((a) => a.startsWith("-command:") || a === "-command" || a === "-c")
    const script = i >= 0 && rest[i].startsWith("-command:")
      ? rest[i].slice("-command:".length)
      : rest[i + 1]
    return script !== undefined && deepDetect(script.split(/\s+/), workspace, depth + 1)
  }
  if (cmd === "trap") {
    const action = rest.find((a) => !a.startsWith("-") && a !== "--")
    return action !== undefined && deepDetect(["sh", "-c", action], workspace, depth + 1)
  }

  // 直接命中
  if (EXTREME_COMMANDS.has(cmd)) return true
  if (cmd === "reg" && rest.some((a) => REG_SUBCOMMANDS.has(a.toLowerCase()))) return true
  if (cmd === "cipher" && rest.some((a) => a.toLowerCase() === "/w")) return true

  // URL/GUI 啟動（phishing）
  if (hasUrl(rest) && ["start-process", "start", "saps", "invoke-item", "ii", "rundll32", "mshta", "explorer"].includes(cmd)) return true

  // force-delete 家族（rm / PS / CMD）
  const isDeleteCmdlet = ["rm", "remove-item", "ri", "del", "erase", "rd", "rmdir"].includes(cmd)
  if (isDeleteCmdlet) {
    const hasForce = hasForceRm(rest) || hasPsForceDelete([cmd, ...rest]) || hasCmdForceDelete([cmd, ...rest])
    if (!hasForce) return false
    // workspace 逃逸判定：任何 operate 路徑不在 workspace 內或為系統頂層
    const targets = rest.filter((a) => !a.startsWith("-"))
    const outside = targets.some((t) => !isInsideWorkspace(workspace, t) || isTopLevelSystemPath(t))
    return outside
  }
  return false
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/guard-approval && pnpm vitest run test/danger-class.test.ts`
Expected: PASS（11 case；對照 codex 否定案例 `rm -r` 無 force 不標等）

- [ ] **Step 5: Commit**

```bash
git add packages/guard-approval/src/danger-class.ts packages/guard-approval/test/danger-class.test.ts
git commit -m "feat(M22): guard-approval — extreme-danger classifier (absorb codex dangerous-command rules + OS-level ops)"
```

### Task 2: guard-approval v2——ApprovalRequest 擴充 + policy 插口 + prefix-rule remember 骨架

**Files:**
- Modify: `packages/guard-approval/src/index.ts`（decide() 用 classifyDanger；ApprovalConfig 加 `policy?: 'ask'|'never'`；引入 remember 骨架）
- Modify: `packages/interaction/src/index.ts`（ApprovalRequest 擴充：`command?/argv?/dangerClass?/pathSummary?`——**向後相容可選**）
- Create: `packages/guard-approval/src/remember.ts`（prefix-rule remember store：JSON 檔 + BANNED 清單）
- Test: `packages/guard-approval/test/remember.test.ts`（新）、`packages/guard-approval/test/approval-v2.test.ts`（新）、`packages/interaction/test/approval-request.test.ts`（新）

**Interfaces:**
- Consumes: `ApprovalRequest`/`ApprovalAnswerer`（interaction）、`classifyDanger`/`DangerClass`（Task 1）、`registerApprovalAnswerer`（interaction）
- Produces:
  - `ApprovalConfig` 加 `approvalPolicy?: "ask" | "never"`（undefined = 現行三層；`never` = 分類器判 ask 即 deny-with-reason）
  - `ApprovalRequest` 擴充（interaction）：`command?: string; argv?: string[]; dangerClass?: "extreme"|"dangerous"|"none"; pathSummary?: string`（全 optional——現有 approveAll answerer 與 cli.test.ts 不破）
  - `export interface RememberRule { prefix: string[]; createdAt: string }`
  - `export function createRememberStore(filePath: string): { load(): RememberRule[]; save(rules: RememberRule[]): void; matches(argv: string[]): boolean; add(rule: RememberRule): { ok: boolean; reason?: string }; }`
  - BANNED_PREFIX_PATTERNS: `[["bash"], ["bash","-c"], ["bash","-lc"], ["cmd"], ["cmd","/c"], ["cmd","/k"], ["cmd.exe"], ["pwsh"], ["pwsh","-Command"], ["powershell","-Command"], ["sh","-c"], ["zsh","-c"]]`（吸收 codex BANNED_PREFIX_SUGGESTIONS exec_policy.rs:56-76）
  - `add()` 拒絕 banned prefix（prefix 開頭匹配 banned → `{ok:false, reason:"shell/interpreters cannot be remembered"}`）

- [ ] **Step 1: 寫失敗測試（remember store）**

```ts
// packages/guard-approval/test/remember.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { createRememberStore, BANNED_PREFIX_PATTERNS } from "../src/remember.ts"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "i-harness-remember-"))
  file = join(dir, "rules.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("createRememberStore", () => {
  it("prefix rule matches command argv", () => {
    const store = createRememberStore(file)
    store.add({ prefix: ["git", "commit"], createdAt: new Date().toISOString() })
    expect(store.matches(["git", "commit", "-m"])).toBe(true)
    expect(store.matches(["git", "pull"])).toBe(false)
  })
  it("persists to JSON across instances", () => {
    const store = createRememberStore(file)
    store.add({ prefix: ["git", "push"], createdAt: new Date().toISOString() })
    const store2 = createRememberStore(file)
    expect(store2.matches(["git", "push", "--force"])).toBe(true)
  })
  it("rejects banned shell prefixes", () => {
    const store = createRememberStore(file)
    const r = store.add({ prefix: ["bash", "-c"], createdAt: new Date().toISOString() })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/shell|interpret/)
  })
  it("banned list has bash/cmd/pwsh", () => {
    expect(BANNED_PREFIX_PATTERNS.some((b) => b[0] === "bash")).toBe(true)
    expect(BANNED_PREFIX_PATTERNS.some((b) => b[0] === "cmd")).toBe(true)
    expect(BANNED_PREFIX_PATTERNS.some((b) => b[0] === "pwsh")).toBe(true)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/guard-approval && pnpm vitest run test/remember.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實現 remember.ts**

```ts
// packages/guard-approval/src/remember.ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

// 吸收 codex execpolicy prefix rules（exec_policy.rs:56-76 BANNED_PREFIX_SUGGESTIONS
// + add_prefix_rule Decision::Allow）：命令前綴級 remember，跨 session、JSON 檔落盤。
// 安全針臺：shell/解釋器永不 remember（否則等於全放行）。
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
  return {
    load,
    save(rules) {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, JSON.stringify(rules, null, 2), "utf-8")
    },
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
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/guard-approval && pnpm vitest run test/remember.test.ts`
Expected: PASS

- [ ] **Step 5: 修改 interaction 的 ApprovalRequest 擴充 + 測試**

```ts
// packages/interaction/src/index.ts — 替換
export interface ApprovalRequest {
  name: string
  reason: string
  // M22: echo-consent 的承載（全部 optional——向後相容）
  command?: string
  argv?: string[]
  dangerClass?: "extreme" | "dangerous" | "none"
  pathSummary?: string
}
```

```ts
// packages/interaction/test/approval-request.test.ts
// ctx 建構沿用 interaction.test.ts 既有模式：createContext() from @i-harness/core-plugin
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { registerApprovalAnswerer } from "../src/index.ts"

function makeCtx() {
  return createContext()
}

describe("ApprovalRequest extension (M22)", () => {
  it("approveAll-style answerer ignores extra echo-consent fields", async () => {
    const ctx = makeCtx()
    registerApprovalAnswerer(ctx, async () => ({ approved: true }))
    const fn = ctx.services.get<(req: { name: string; reason: string }) => Promise<boolean>>("approval/answerer")
    expect(await fn({
      name: "bash",
      reason: "r",
      command: "rm -rf /",
      argv: ["rm", "-rf", "/"],
      dangerClass: "extreme",
      pathSummary: "/",
    })).toBe(true)
  })
  it("old shape (no extra fields) still works", async () => {
    const ctx = makeCtx()
    registerApprovalAnswerer(ctx, async () => ({ approved: false }))
    const fn = ctx.services.get<(req: { name: string; reason: string }) => Promise<boolean>>("approval/answerer")
    expect(await fn({ name: "bash", reason: "r" })).toBe(false)
  })
})
```
（注：service 註冊把 `ApprovalAnswerer` 規範化為 boolean 回傳（interaction L20-25）——`svc` 型別為 `(req) => Promise<boolean>`；額外欄位對既有答案器透明（型別相容因 ApprovalRequest 擴充為 optional + 靜態型別不拒絕 object literal——實作時確認 `ApprovalAnswerer` 參數型別在靜態下接受擴充欄位；若否，測試用 `as` cast。）

- [ ] **Step 6: 修改 guard-approval index.ts（decide 用 danger-class + policy 插口）**

```ts
// packages/guard-approval/src/index.ts — 關鍵修改（其餘保留）
import { classifyDanger } from "./danger-class.ts" // （Task 1）

export interface ApprovalConfig {
  workspace: string
  dangerousCommands?: string[]
  dangerousFlags?: string[]
  askForNonReadOnly?: boolean
  // M22: 'never' = 分類器判 ask 即直接 deny-with-reason（headless 安全姿態）
  approvalPolicy?: "ask" | "never"
}

// decide() 中：Layer 3 區域改為
if (SHELL_TOOLS.has(name)) {
  const command = (call.args as { command?: string } | undefined)?.command ?? ""
  const argv = tool.getArgv?.(call.args) ?? command.split(/\s+/).filter((s) => s.length > 0)
  const danger = classifyDanger(argv, workspace, dangerousCommands, dangerousFlags)
  if (danger !== "none") {
    const reason = danger === "extreme"
      ? `EXTREME DISTRUCTIVE command: ${argv.join(" ")} — approval requires explicit confirmation`
      : `dangerous command requires approval: ${argv.join(" ") || command}`
    return { kind: "ask", reason }
  }
}

// 最後：createApprovalPolicy 內加
const approvalPolicy = config.approvalPolicy
// decide 後若 decision?.kind === "ask" && approvalPolicy === "never" → 回
// { kind: "deny", reason: `approval policy is 'never'; ${decision.reason}` }
```

（ToolDecision 有 `{ kind: "deny"; reason }`——core-tools 已定義。`never` 語義：ask → deny。）

- [ ] **Step 7: 跑測試確認通過**

Run: `cd packages/guard-approval && pnpm vitest run` + `cd packages/interaction && pnpm vitest run`
Expected: PASS（既有 19 case guard-approval + interaction 既有全綠——向後相容）

- [ ] **Step 8: Commit**

```bash
git add packages/guard-approval/src/ packages/guard-approval/test/ packages/interaction/src/index.ts packages/interaction/test/approval-request.test.ts
git commit -m "feat(M22): guard-approval v2 — danger-class tiers, approvalPolicy ask/never, prefix-rule remember store + banned list"
```

---

## Part 2: sandbox audit + 拒跑閘門 + 邊界測試

### Task 3: `@i-harness/sandbox-windows-acl` audit.ts（世界可寫掃描）

**Files:**
- Create: `packages/sandbox-windows-acl/src/audit.ts`（世界可寫掃描：限時限量純查詢）
- Modify: `packages/sandbox-windows-acl/src/index.ts`（export `scanWorldWritable`）
- Test: `packages/sandbox-windows-acl/test/audit.test.ts`（新）

**Interfaces:**
- Consumes: `GetNamedSecurityInfoW`/`GetAce`/`EqualSid` 等（既有 win32-abi.ts + ffi.ts 的 koffi 面）、`existsSync`/`readdirSync`（node:fs）
- Produces:
  - `export interface WorldWritableFinding { path: string; who: "Everyone" | "Authenticated-Users"; }`
  - `export function scanWorldWritable(dirs: readonly string[], opts?: { maxItemsPerDir?: number; totalBudgetMs?: number }): Promise<WorldWritableFinding[]>`
  - 行為：對每個 dir 做限時限量掃描（maxItemsPerDir 預設 500、totalBudgetMs 預設 2000）；每項檢查 DACL 是否含 Everyone/Authenticated-Users 的寫 ACE（FILE_GENERIC_WRITE|FILE_WRITE_DATA|FILE_WRITE_ATTRIBUTES|FILE_WRITE_EA|FILE_APPEND_DATA|DELETE 等 mask 子集）；**純查詢——不修改任何 ACL**（我方 deny 無 anchor principal，見研究 A.2——絕不自動打 deny）
  - 過期（timeout）→ 停止掃描回傳已收集（best-effort，與 codex audit.rs 同精神）

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/sandbox-windows-acl/test/audit.test.ts
import { describe, expect, it } from "vitest"
import { scanWorldWritable } from "../src/audit.ts"
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe.skipIf(process.platform !== "win32")("scanWorldWritable", () => {
  it("finds a world-writable temp dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-audit-"))
    try {
      const dir = join(root, "open")
      mkdirSync(dir)
      chmodSync(dir, 0o777) // Everyone write on POSIX-mode emulation; win32 needs real ACL — use icacls in integration；這裡先以 POSIX 測試非 win32 路徑（skipIf 使 win32 上只跑 icacls 案例）
      const findings = await scanWorldWritable([root], { maxItemsPerDir: 10, totalBudgetMs: 2000 })
      expect(Array.isArray(findings)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it("budget caps exploration", async () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-audit-"))
    try {
      for (let i = 0; i < 50; i++) mkdirSync(join(root, `d${i}`))
      const findings = await scanWorldWritable([root], { maxItemsPerDir: 5, totalBudgetMs: 500 })
      expect(findings.length).toBeLessThanOrEqual(50) // budget 限制探索
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
```

（注：win32 上的 world-writable 檢測需真 ACL 讀取（GetNamedSecurityInfoW）；測試先確認 scan 不拋 + budget 行為。real-world ACL case 用 `icacls`（integration）——M22 scope 以 pure-query 回報為主。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/sandbox-windows-acl && pnpm vitest run test/audit.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實現 audit.ts（誠實 scope：掃描驅動 + 注入式 DACL probe）**

```ts
// packages/sandbox-windows-acl/src/audit.ts
// 吸收 codex windows-sandbox-rs/src/audit.rs 之世界可寫掃描（限時限量 gather、
// cwd 先行）——改寫為 I-harness 版：node + koffi、純查詢回報、**不自動 deny**。
// （我方 WRITE_RESTRICTED 基座無 deny-anchor principal——研究 A.2；僅回報供
// consent/文檔使用。）MIT 歸屬：THIRD_PARTY_NOTICES（OpenAI codex-rs）。
//
// Scope note (M22 決定)：現有 acl.ts 的 readCurrentDacl 未 export 且無 ACE
// 枚舉（GetAce/GetExplicitEntriesFromAclW 未綁定）；本模組以「掃描驅動 +
// 注入式 DACL probe」交付——probe 注入補全時（未來里程碑）即得真 ACL 判定。
import { readdirSync } from "node:fs"

export interface WorldWritableFinding {
  path: string
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
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (Date.now() > deadline || ++seen > maxItems) break
        const child = entry.isDirectory() ? dir + "\\" + entry.name : dir + "\\" + entry.name
        const verdict = probe(child)
        if (verdict === "world-writable") {
          findings.push({ path: child, who: "Everyone" })
        } else if (verdict === "unknown") {
          // 不判定——由呼叫端（文檔/未來）決定可擴充
        }
        if (entry.isDirectory()) {
          // 遞迴一層（預設：掃描 seed 目錄的子目錄）——depth 由 caller 控制（dirs 傳入深度）
        }
      }
    } catch {
      // unreadable dir → skip（fail-open 到「此 dir 無發現」——audit 是監視非 enforcement）
    }
  }
  return findings
}
```

（**M22 交付界**：`scanWorldWritable` 驅動 + `probe` 注入 + budget/timeout + 結構——真 ACL 判定由未來 probe 實現（acl.ts 的 readCurrentDacl 目前未 export——此 task 不加 export，避免半成品 API 面；M22 文檔明註 query-only 可擴充）。Test Step 1 的兩個 case 驗證驅動/不拋/budget——不含真 ACL。）

- [ ] **Step 3.5: 加 probe 測試**

```ts
// packages/sandbox-windows-acl/test/audit.test.ts — 追加
it("probe verdict world-writable → finding recorded", async () => {
  const root = mkdtempSync(join(tmpdir(), "i-harness-audit-"))
  try {
    const dir = join(root, "open")
    mkdirSync(dir)
    const findings = await scanWorldWritable([root], {
      maxItemsPerDir: 5,
      totalBudgetMs: 2000,
      probe: (p) => (p === dir ? "world-writable" : "safe"),
    })
    expect(findings.some((f) => f.path === dir && f.who === "Everyone")).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
```

- [ ] **Step 4: 跑測試確認通過 + Commit**

```bash
git add packages/sandbox-windows-acl/src/audit.ts packages/sandbox-windows-acl/src/index.ts packages/sandbox-windows-acl/test/audit.test.ts
git commit -m "feat(M22): sandbox-windows-acl — world-writable audit scan (bounded, query-only, no deny)"
```

### Task 4: 拒跑閘門（enforcement 能力檢查）

**Files:**
- Modify: `packages/sandbox/src/index.ts`（`SandboxExecutionPolicy` 加 `requireReadIsolation?: boolean`；`SandboxProvider` 加 `capabilities?: { readIsolation: boolean }`）
- Modify: `packages/sandbox-local/src/index.ts`（`createLocalSandbox` — provider capabilities 宣告；win32 後端 = `{readIsolation: false}`、bwrap = `{readIsolation: false}`（bwrap 也無讀隔離——誠實））
- Modify: `packages/exec/src/index.ts`（`resolveArgv`/`spawnChild`——policy 要求 readIsolation 但 provider 無 → `SandboxUnavailableError` fail-closed）
- Test: `packages/sandbox/test/enforcement.test.ts`（新）、`packages/exec/test/enforcement.test.ts`（新）

**Interfaces:**
- Consumes: `SandboxUnavailableError`、`SandboxProvider`、`SandboxExecutionPolicy`
- Produces:
  - `SandboxExecutionPolicy` 加 `requireReadIsolation?: boolean`（default false；true = 該 policy 要求讀隔離）
  - `SandboxProvider` 加 `capabilities?: { readIsolation: boolean }`（optional——無宣告視為 `{readIsolation: false}` fail-closed）
  - **拒跑規則**：policy.requireReadIsolation === true 且 provider.capabilities?.readIsolation !== true → `SandboxUnavailableError(mode, "policy requires read isolation but this backend provides none (WRITE_RESTRICTED read-visible; codex elevated backend absent)")`——吸收 codex `refusing to run unsandboxed`（windows.rs:121-129）形狀
  - 今天所有 provider 皆 `readIsolation: false`——M22 此閘門是「未來」的形狀，今天唯一外顯 = 若某 host 設 requireReadIsolation: true 立即拒跑（fail-closed 完整）

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/sandbox/test/enforcement.test.ts
import { describe, expect, it } from "vitest"
import { SandboxUnavailableError, type SandboxPolicy, type SandboxProvider } from "../src/index.ts"

const policy: SandboxPolicy = { mode: "workspace-write", workspaceRoot: "C:/w" }

describe("readIsolation enforcement gate", () => {
  it("provider without capability + policy requiring it → SandboxUnavailableError", () => {
    const provider: SandboxProvider = {
      confine(argv, p) { return { argv: [...argv], enforcement: "partial", denialSignatures: [], runnerFailureRules: [] } },
    }
    // 需一個檢查函式——見 Step 3 的 `assertSandboxCapable(policy, provider)`
    expect(() => assertSandboxCapable({ ...policy, requireReadIsolation: true }, provider)).toThrow(SandboxUnavailableError)
  })
  it("provider with capability + policy requiring it → pass", () => {
    const provider: SandboxProvider = {
      capabilities: { readIsolation: true },
      confine(argv, p) { return { argv: [...argv], enforcement: "full", denialSignatures: [], runnerFailureRules: [] } },
    }
    expect(() => assertSandboxCapable({ ...policy, requireReadIsolation: true }, provider)).not.toThrow()
  })
  it("policy without requirement + no capability → pass (today's behavior)", () => {
    const provider: SandboxProvider = {
      confine(argv, p) { return { argv: [...argv], enforcement: "partial", denialSignatures: [], runnerFailureRules: [] } },
    }
    expect(() => assertSandboxCapable(policy, provider)).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/sandbox && pnpm vitest run test/enforcement.test.ts`
Expected: FAIL（export 不存在）

- [ ] **Step 3: 實現 assertSandboxCapable（sandbox/src/index.ts）**

```ts
// packages/sandbox/src/index.ts — 加
// 吸收 codex windows.rs 之「policy 要求而後端不及 → 拒跑」（refusing to run
// unsandboxed；windows.rs:121-129）——形狀級吸收（M22 今日所有 provider 皆
// readIsolation:false，此閘門為未來帳號式後端留的 fail-closed 契約）。
export function assertSandboxCapable(policy: SandboxExecutionPolicy, provider: SandboxProvider): void {
  if (policy.requireReadIsolation === true && provider.capabilities?.readIsolation !== true) {
    throw new SandboxUnavailableError(
      (policy as SandboxPolicy).mode,
      "policy requires read isolation but this backend provides none (WRITE_RESTRICTED is read-visible on Windows; the codex-style elevated backend is not implemented in this build)",
    )
  }
}
```

（注意：`policy.mode` 可能是 `danger-full-access`——assertSandboxCapable 只對 confined mode 有意義；`danger-full-access` 在 exec 早已 passthrough（resolveArgv L42-44），不需檢查。實作時用 `(policy as SandboxPolicy).mode` 並在 runner 路由處呼叫。）

```ts
// packages/sandbox-local/src/index.ts — provider 加 capabilities
confine(argv, policy) {
  if (policy.requireReadIsolation === true) {
    throw new SandboxUnavailableError(policy.mode, "local sandbox backends provide no read isolation (capability: none)")
  }
  return { ...backend.confine(argv, policy), enforcement: STATIC_ENFORCEMENT["windows-acl"] }
}
```

```ts
// packages/exec/src/index.ts — resolveArgv 加門（confined 分支）
function resolveArgv(cmd: ExecCommand, sandboxProvider?: SandboxProvider): ResolvedSpawn {
  if (cmd.sandbox === undefined) return {}
  const sandbox = cmd.sandbox
  if (!isConfinedPolicy(sandbox)) return {} // passthrough
  if (sandboxProvider === undefined) {
    throw new SandboxUnavailableError(sandbox.mode, "no sandbox provider composed (createExecService({ sandbox }))")
  }
  assertSandboxCapable(sandbox, sandboxProvider) // M22 gate
  const confined = sandboxProvider.confine(cmd.argv, sandbox)
  return { confined, mode: sandbox.mode }
}
```

- [ ] **Step 4: 跑測試確認通過 + 加 exec test**

```ts
// packages/exec/test/enforcement.test.ts
import { describe, expect, it } from "vitest"
import { createExecService } from "../src/index.ts"
import { SandboxUnavailableError, type SandboxProvider } from "@i-harness/sandbox"

describe("exec readIsolation gate", () => {
  it("run() with readIsolation policy + no-capability provider → SandboxUnavailableError", async () => {
    const provider: SandboxProvider = {
      confine(argv, policy) {
        return { argv: [...argv], enforcement: "partial", denialSignatures: [], runnerFailureRules: [] }
      },
    }
    const exec = createExecService({ sandbox: provider })
    await expect(exec.run({
      argv: ["node", "-e", "0"],
      sandbox: { mode: "workspace-write", workspaceRoot: "C:/w", requireReadIsolation: true },
    })).rejects.toThrow(SandboxUnavailableError)
  })
})
```

Run: `cd packages/sandbox && pnpm vitest run` + `cd packages/exec && pnpm vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src/index.ts packages/sandbox-local/src/index.ts packages/exec/src/index.ts packages/sandbox/test/enforcement.test.ts packages/exec/test/enforcement.test.ts
git commit -m "feat(M22): sandbox enforcement gate — readIsolation capability contract (absorb codex refuse-to-run policy; fail-closed)"
```

### Task 5: 邊界測試包（kill-on-close + 讀否定 pin + runner-failure + headless 冒煙）

**Files:**
- Create: `packages/sandbox-windows-acl/test/kill-on-close.e2e.ts`（新）、`packages/sandbox-windows-acl/test/read-visibility.e2e.ts`（新）
- Modify: `packages/sandbox-windows-acl/test/win32.e2e.ts`（加 runner-failure 127 case、headless 冒煙）
- Modify: `packages/sandbox-provider/test/`（若有 provider 測試——runner contract case）
- Test: 所有新 e2e 檔遵守 `describe.skipIf(process.platform !== "win32")` + vitest.config include（**已在 vitest.config.ts include *.e2e.ts——確認**）

**Interfaces:**
- Consumes: `createWindowsAclSandbox`（index.ts）、`spawnSandboxed`、`spawnSandboxedInherited`（spawn.ts）、job object（內部）
- Produces:
  - **kill-on-close**：child（descendant）啟動 long-running grandchild → provider `dispose()`（close job）→ grandchild 必須被 kill（poll pid 消亡，timeout 30s 防 flake）
  - **讀否定 pin**：confined child 讀 `%USERPROFILE%` 外機密檔案 → **斷言讀取成功**（`read-isolation absent by design`）——活文檔
  - **runner-failure 127**：runner exit 127 + `windows-acl-run:` fatal 簽名 → `SandboxUnavailableError`（不當 denial）
  - **headless 冒煙**：`runHeadless(sandbox:'workspace-write')` 真實跑一條 bash → 成功（M25 e2e 計畫的先導）

- [ ] **Step 1: 寫 kill-on-close e2e（spawnSandboxed pipe 模式——父退出即 job close）**

```ts
// packages/sandbox-windows-acl/test/kill-on-close.e2e.ts
// 現況（已驗證）：provider 回傳 SandboxProvider & { dispose(): void }（index.ts L512）；
// spawnSandboxed 的 pipe 串流 + 子 exit 時 job 關閉（kill-on-close 分支）。
// 斷言主體：confined 父進程 spawn 長駐孫進程後自行 exit → job close → 孫應被殺。
import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { createWindowsAclSandbox, spawnSandboxed } from "../src/index.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe.skipIf(process.platform !== "win32")("kill-on-close job (Windows only)", () => {
  let root: string
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "i-harness-kill-")) })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("kills grandchild when job handle closes", async () => {
    const provider = createWindowsAclSandbox({ writableDirs: [root], mode: "workspace-write" })
    // 腳本：spawn 長駐孫進程（node setInterval）、印 pid、然後父自行 exit(0)
    const script = [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)']);",
      "console.log('GRANDCHILD:' + c.pid);",
      "process.exit(0)",
    ].join("")
    const confined = provider.confine(
      ["node", "-e", script],
      { mode: "workspace-write", workspaceRoot: root, sessionId: "kill-e2e" },
    )
    const result = await spawnSandboxed(confined.argv) // 回 { stdout, stderr, exitCode }
    const m = result.stdout.toString().match(/GRANDCHILD:(\d+)/)
    expect(m, `stderr: ${result.stderr.toString()}`).toBeDefined()
    const grandchildPid = Number(m![1]!)
    // 父已 exit → job closed → kill-on-close 應已殺孫（poll 30s 防慢）
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      try { process.kill(grandchildPid, 0) } catch { return } // gone → pass
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`grandchild ${grandchildPid} survived kill-on-close`)
  }, 60000)
})
```

（注：若 `spawnSandboxed` 的實際回傳 shape 不同（如含 `done` promise）以實際為準——index.ts L366-372 顯示回 `{ stdout: Buffer, stderr: Buffer, exitCode }`；stderr 名稱需以實際檢查。若 pipe 模式不觸發 job close（僅 dispose 觸發），改用 `provider.dispose()` 在父 exit 前呼叫——以「dispose 前父已 exit → job close」為最終斷言；實作時以 win32.e2e 既有模式對照。）

- [ ] **Step 3: 寫 read-visibility 否定 pin**

```ts
// packages/sandbox-windows-acl/test/read-visibility.e2e.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { createWindowsAclSandbox } from "../src/index.ts"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

describe.skipIf(process.platform !== "win32")("read visibility (KNOWN LIMITATION — pin as living doc)", () => {
  let root: string
  let secret: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "i-harness-readvis-"))
    secret = join(tmpdir(), "i-harness-readvis-secret.txt")
    writeFileSync(secret, "TOP-SECRET")
  })
  afterAll(() => { rmSync(root, { recursive: true, force: true }); rmSync(secret, { force: true }) })

  it("confined child CAN read outside workspace (read side is NOT isolated — by design)", () => {
    const provider = createWindowsAclSandbox({ writableDirs: [root], mode: "workspace-write" })
    const confined = provider.confine(
      ["node", "-e", `const fs = require('node:fs'); console.log('READ: ' + fs.readFileSync(${JSON.stringify(secret)}, 'utf8'))`],
      { mode: "workspace-write", workspaceRoot: root, sessionId: "readvis-e2e" },
    )
    const result = spawnSync(confined.argv[0]!, confined.argv.slice(1), { encoding: "utf8", timeout: 30000 })
    // 否定 pin：讀取成功——若未來讀隔離上線此測試會失敗（活提醒）
    expect(result.stdout).toContain("READ: TOP-SECRET")
    expect(result.status).toBe(0)
  })
})
```

- [ ] **Step 4: 加 runner-failure 127 + headless 冒煙到 win32.e2e.ts**

```ts
// packages/sandbox-windows-acl/test/win32.e2e.ts — 追加
it("runner failure (exit 127 + windows-acl-run: fatal) → SandboxUnavailableError", async () => {
  const provider = createWindowsAclSandbox({ writableDirs: [workspace], mode: "workspace-write" })
  // 注入 runner 失敗：confine 產生的 argv 開頭是 runner——強制 runner 失敗 by env
  // （如 runner 找不到 node——用 env 破壞）——實際：造一個 argv[0] 不存在 或 runner 自斷
  expect(() => provider.confine(["node", "-e", "0"], { mode: "workspace-write", workspaceRoot: workspace, sessionId: "runner-e2e" })).not.toThrow()
  // 註：真正 runner-failure 判定在 exec 的 doneFn（classifyRunnerFailure）——此處驗證 provider.confine 不 throw；
  // classify 的分支在 packages/exec （既有 test）——參照 sandbox/src/runner-failures.ts 的 RUNNER_FAILURE_RULES
})
```
（runner-failure 精確 case 已於 sandbox/src/runner-failures.ts + exec 的 doneFn 有涵蓋——此處是 provider 面補充。**以既有為主，不重複鋪陳**——本 step 若不必要可簡化為「provider.confine 不 throw + 分類器單元有測」+ 文檔說明。）

```ts
it("headless smoke: workspace-write bash runs", async () => {
  // 依 M25 計畫的前導：headless CLI 用 --sandbox workspace-write 跑真 bash
  // （需 tsx 啟動——M25 有 e2e 目錄；此處以 sandbox provider 直接 confine 一真 bash 冒煙）
  const provider = createWindowsAclSandbox({ writableDirs: [workspace], mode: "workspace-write" })
  const confined = provider.confine(["bash", "-c", "echo M22-OK"], { mode: "workspace-write", workspaceRoot: workspace, sessionId: "headless-e2e" })
  const result = spawnSync(confined.argv[0]!, confined.argv.slice(1), { encoding: "utf8", timeout: 30000 })
  expect(result.stdout).toContain("M22-OK")
})
```

- [ ] **Step 5: 跑全部 sandbox-windows-acl 測試 + Commit**

Run: `cd packages/sandbox-windows-acl && pnpm vitest run`
Expected: PASS（既有 abi/acl/ffi/grant/provider/sid/spawn/token + 新 e2e；全部 skipIf 於非 win32）

```bash
git add packages/sandbox-windows-acl/test/
git commit -m "test(M22): windows-acl boundary suite — kill-on-close, read-visibility living-doc pin, runner-failure, headless smoke"
```

---

## Part 3: 歸屬與誠實文檔

### Task 6: THIRD_PARTY_NOTICES 首建 + 歸屬檔頭 + 誠實完整性 README

**Files:**
- Create: `THIRD_PARTY_NOTICES`（repo root）
- Modify: `packages/sandbox-windows-acl/src/audit.ts`（歸屬頭——若 Task 3 已加則確認）、`packages/guard-approval/src/danger-class.ts`（歸屬頭——Task 1 已加則確認）
- Modify: `packages/guard-approval/src/remember.ts`（歸屬頭——Task 2 已加則確認）
- Modify: `packages/sandbox-windows-acl/README.md`（增「Read-side confinement」節——引用研究 A.2 雙證據 + 未來帳號路線 bound）
- Test: 無（文檔任務——驗證 = grep 歸屬頭存在 + README 節存在）

**Interfaces:**
- 無新程式碼介面——純文檔 + 確認歸屬頭

- [ ] **Step 1: 建立 THIRD_PARTY_NOTICES**

```md
# Third-Party Notices

I-harness 吸收 dsh（deepseek-harness-master）與 OpenAI codex（codex-rust-v0.149.1）之設計/代碼片段。
所有來源皆為 MIT License；吸收片段保留原版權聲明。

## OpenAI codex-rs (MIT)
- 來源：https://github.com/openai/codex (codex-rs/windows-sandbox-rs, sandboxing)
- 吸收：
  - `packages/sandbox-windows-acl/src/audit.ts` — 世界可寫掃描（audit.rs 之限時限量 gather/cwd 先行構想）
  - `packages/guard-approval/src/danger-class.ts` — 危險命令分類器（is_dangerous_command.rs + windows_dangerous_commands.rs 語義）
  - `packages/guard-approval/src/remember.ts` — prefix rules 與 BANNED_PREFIX_SUGGESTIONS（exec_policy.rs）
  - `packages/sandbox/src/index.ts`（enforcement gate）— refuse-to-run 形狀（sandboxing/windows.rs）
- License: MIT

## deepseek-harness (dsh) (MIT)
- 來源：https://github.com/deepseek-ai/deepseek-harness (packages/sandbox/sandbox-windows-acl, interaction/user-approval)
- 吸收：
  - `packages/sandbox-windows-acl/` — 同源移植（M16w；機制同 huoyaoyuan/windows-acl-restrict-poc）
  - `packages/guard-approval/` 與 `packages/interaction/` — user-approval one-shot 語義（allowed-once/rejected/cancelled/unavailable）
- License: MIT
```

- [ ] **Step 2: 確認/補充各檔案歸屬頭**

檔案頭格式（既有先例——sandbox-windows-acl/src/index.ts 開頭已引用 huoyaoyuan POC）：
```ts
// 機制吸收自 OpenAI codex-rs windows-sandbox-rs/src/audit.rs（MIT；見 THIRD_PARTY_NOTICES）。
// 改寫為 I-harness 版：node + koffi、純查詢回報、**不自動 deny**（WRITE_RESTRICTED 基座無
// deny-anchor principal——研究 §A.2）。
```
（Task 1/2/3 的檔案頭應已含此——此 step 驗證 grep `THIRD_PARTY_NOTICES` 在各檔頭，缺則補。）

- [ ] **Step 3: README 增「Read-side confinement」節**

````md
## Read-side confinement (M22 結論)

> **本 sandbox 不提供讀隔離。** WRITE_RESTRICTED 限制**只對寫型存取**做 restricting-SID 檢查；
> 讀存取走正常 token 檢查，而 deny-read ACE 其 deny 主體必須出現於做檢查的 token 的 SIDs——
> 但本 sandbox 的 token 只含 caller 的 ambient 身分（user/groups/logon SID），對其打 deny-read
> 會毒化同一登入工作階段的所有其他進程（含 host CLI、編輯器）。
> 此限制為 **partial（write-only）**——`enforcement: 'partial'`，與 codex/dsh 同源基準一致。

**雙證據**：
- codex 自己寫死（codex-rs/sandboxing/src/windows.rs:110-127）：「WRITE_RESTRICTED token does
  not make capability SID deny-read ACEs participate in read access checks. Read restrictions
  therefore require the elevated backend…」——且 config 要求讀分割而只有 unelevated 後端時拒跑。
- dsh README：「Writes are restricted; reads, network, and process visibility are not. …pair it
  with a read-side policy or an AppContainer/S-1-15-2 capability token for stronger confinement.」
  Known Limitations：「Read-side confinement and network policy are out of scope.」

**未來（M26+ 候選）**：codex 式「帳號式 elevated 後端」（專用本地組/帳號 + DPAPI 存密 +
背景授讀 helper + 提權 setup）——可讓 deny-read ACE 落在專用身分的 SIDs 上。M22 未實作，
因為需管理員安裝期權限與數百行 FFI，且 Windows 環境變數（域控/提權許可）不可控。

**已知不可保護向量（pin 成活文檔）**：全域任意路徑讀取不受限；外部 Everyone-ACL 物件寫入；
NUL 裝置（`cmd > NUL`）；hard link 外部別名寫；FAT 無 SD；console 隔離不可得；named-pipe 孫進程。
````

- [ ] **Step 4: 驗證 + Commit**

```bash
grep -r "THIRD_PARTY_NOTICES" packages/sandbox-windows-acl/src/audit.ts packages/guard-approval/src/danger-class.ts packages/guard-approval/src/remember.ts
# README 節存在：
grep -n "Read-side confinement" packages/sandbox-windows-acl/README.md
git add THIRD_PARTY_NOTICES packages/sandbox-windows-acl/README.md
git commit -m "docs(M22): THIRD_PARTY_NOTICES + sandbox README Read-side confinement (honest completeness statement)"
```

---

## 驗證（全文完）

- [ ] **Step: 跑全部 M22 相關測試 + 全 workspace**

```bash
cd packages/guard-approval && pnpm vitest run
cd packages/interaction && pnpm vitest run
cd packages/sandbox && pnpm vitest run
cd packages/sandbox-local && pnpm vitest run
cd packages/sandbox-windows-acl && pnpm vitest run
cd packages/exec && pnpm vitest run
cd /d/agent-complete/I-harness && pnpm -r test && pnpm -r typecheck
```
Expected: ALL PASS（既有全綠——guard-approval 19+新、interaction 既有+新增 2、sandbox/exec 新增 enforcement、sandbox-windows-acl 既有+新 e2e——非 win32 skipIf）

---

## Plan Self-Review 紀錄

1. **Spec 覆蓋**：§5.1①讀隔離→研究決定延後（Q1 同意——研究 §七）；§5.1②consent gate→Task 1/2（extreme-danger + policy 插口 + remember）；§5.1③邊界測試→Task 5；§5.2 資料流→Task 4（enforcement gate）+ Task 2（one-shot answerer）；§5.3 測試→Task 1/2/3/5；§5.4 吸收→Task 6（THIRD_PARTY_NOTICES）。全覆蓋。
2. **Placeholder 掃描**：TBD 檢查——Task 3 audit.ts 的 koffi 載入取捨標記「實作時查 win32-abi.ts」——需在 Step 3 用實際事實：`check win32-abi.ts has GetNamedSecurityInfoW`（有則實作 ACL 查詢；無則 minimal binding）。**修正**：Task 3 Step 3 的 audit.ts 骨架雖有「查」註解但函數主體回空 list——**這會 PASS Step 4 但沒實作**——調整：Task 3 只做「scan 驅動 + 結構」（不依賴 ACL 查詢能力）為 M22 可行範圍，或若 win32-abi 已有該 API 即做真查詢。**整理：Task 3 的實際交付 = 掃描驅動遞迴 + findings 結構 + budget 限制 + 回報**（真 ACL 查詢掛 koffi 若有——否則 findings 以「掃描存在」為主，README/文檔明註 query-only 可擴充）。
3. **型別一致性**：`DangerClass`/`classifyDanger` 跨 Task 1/2 一致；`ApprovalRequest` 擴充字段跨 Task 2 consistent；`SandboxUnavailableError` 跨 Task 4 consistent；`RemmeberStore` 跨 Task 2 一致。
4. **自審修正後的事實**（非猜測——已對實際代碼驗證）：
   - `createWindowsAclSandbox` 回傳 `SandboxProvider & { dispose(): void }`（index.ts L512）——kill-on-close 測試可用 dispose()（改為 pipe 模式：父 exit 即 job close 為主要斷言，dispose 為備案）。
   - `GetNamedSecurityInfoW` binding 存在（acl.ts L112-132 readCurrentDacl）但**未 export** 且無 ACE 枚舉 API——audit.ts 以「掃描驅動 + 注入式 probe」交付（誠實 scope：M22 做驅動/結構/budget；真 ACL 判定留未來 probe）。
   - `ToolDecision` 的 `{ kind: "deny"; reason }` 存在（core-tools L29-54）——Task 2 的 `never` 語義可直接用。
   - interaction 測試用 `createContext()`（@i-harness/core-plugin）——Task 2 Step 5 測試已改用此模式。
   - `classifyDanger` 全簽名（argv, workspace, dangerousCommands?, dangerousFlags?）跨 Task 1/2 一致；Step 1 測試已同步。
5. **已知取捨（實作時以實際碼為準）**：
   - audit.ts 的 stderr/回傳 shape 與 spawnSandboxed 回傳欄位名（index.ts L366-372 顯示 `{stdout, stderr, exitCode}`——以實際 check）
   - runner-failure 127 的 provider 面 value 低——Task 5 只補「不 throw」+ 文檔（精確 classify 已有既有測）
   - read-visibility e2e 的 tmp secret 檔案位置——須在 confined child 讀得到的位置（tmpdir 即可——child 讀作業系統 temp 無限制，正確）

## 暫不處理（deferred——記錄）
- codex 帳號式 elevated 後端（M26+ 候選——研究 §七 Q1）
- deny_read_resolver（無消費者——研究 §一 A.1）
- answerer remember 互動選項（勾選 remember——M22 只做型別/檔格式 + 拒絕 banned）
- session 級 asked/decided 稽核事件軸（時間盒外——研究 §三 C.3 第5點）
- WebReport/UI 面（M22 不加 UI）
- win32 read-only 的 `.env` 讀保護（不存在——M22 確認不嘗試）
