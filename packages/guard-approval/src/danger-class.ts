import { isAbsolute, relative, resolve } from "node:path"

export type DangerClass = "extreme" | "dangerous" | "none"

// absorb codex shell-command/src/command_safety/is_dangerous_command.rs +
// windows_dangerous_commands.rs 語義（改寫為 TS；MIT 歸屬見 THIRD_PARTY_NOTICES）。
// 補充：codex 缺 OS 級破壞操作（format/diskpart/reg delete/shutdown/cipher /w）
// 與 workspace 逃逸分層——M22 增加。
//
// 分層（extreme 優先，蓋過 dangerous）：
//   extreme   — OS 級破壞 / force-delete 逃出 workspace 或命中系統頂層路徑 /
//               URL-GUI 啟動（防釣魚）。需 echo-consent 預設拒絕。
//   dangerous — metachar / custom dangerousCommands/Flags、或 force-delete
//               全部落在 workspace 內（現行一層 ask；保護正常 agent 清理）。
//   none      — 免。

const EXTREME_COMMANDS = new Set(["format", "diskpart", "shutdown"])
const REG_SUBCOMMANDS = new Set(["delete"])
const DELETE_CMDLETS = ["rm", "remove-item", "ri", "del", "erase", "rd", "rmdir"]
const URL_LAUNCHERS = ["start-process", "start", "saps", "invoke-item", "ii", "rundll32", "mshta", "explorer"]
const POSIX_SHELLS = new Set(["bash", "sh", "zsh"])
const MAX_WRAPPER_DEPTH = 8

// Scan verdict ranks: null < "force" (force-delete, all targets inside the
// workspace) < "extreme" (force-delete escaping workspace, OS-level op,
// or URL/GUI launch).
type Verdict = "extreme" | "force" | null

const STATEMENT_SEPARATORS = /[;&|\n]/

function basenamePath(token: string): string {
  // Windows 檔案名（.exe/.cmd/.bat/.com 去尾）→ lowercase；POSIX 原樣 basename
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
  if (norm === "/") return true
  if (/^[a-z]:(\/|$)/.test(norm) && norm.length <= 3) return true
  if (norm.startsWith("c:/windows") || norm.startsWith("c:/program files")) return true
  return false
}

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0]
    const last = token[token.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return token.slice(1, -1)
  }
  return token
}

// 清掉殘留的孤立引號（`cmd /c "del /f x"` 拆詞後 'del 片段只剩單邊引號），
// 讓 target 路徑能被 resolve 正確處理。
function cleanToken(token: string): string {
  let out = stripQuotes(token)
  if (out.startsWith('"') || out.startsWith("'")) out = out.slice(1)
  if (out.endsWith('"') || out.endsWith("'")) out = out.slice(0, -1)
  return out
}

function pushWords(text: string, sink: string[]): void {
  for (const w of text.split(/\s+/)) {
    if (w.length > 0) sink.push(w)
  }
}

// 依 codex `rm_args_include_force_option`（吸收）——`-rf`/`-f`/`--force`/`-fr` 等。
// Windows-style `/f` 由 hasCmdForceDelete / PowerShell `-Force` 由 cmdlet 相鄰規則補上。
function hasForceRm(args: string[]): boolean {
  for (const a of args) {
    if (a === "--") break // end-of-options：之後全是 operand
    const low = a.toLowerCase()
    if (low === "--force") return true
    // 大小寫不敏感：POSIX 短旗標（-rf / -f）與 PowerShell（-Force）都命中
    if (low.startsWith("-") && !low.startsWith("--") && low.includes("f")) return true
  }
  return false
}

// CMD force-delete（吸收 codex）：del/erase + /f；rd/rmdir + /s + /q。
// tokens 可能來自 argv 切片（["del","/f","x.txt"]）或整串腳本（["echo hi&del /f x"]
// 含無空格鏈）——先 join 再切段，兩種形態都命中。
function splitCmdSegments(line: string): string[][] {
  return line
    .split(/[&|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.split(/\s+/))
}

function hasCmdForceDelete(tokens: string[]): boolean {
  const line = tokens.join(" ")
  for (const seg of splitCmdSegments(line)) {
    const head = seg[0]?.toLowerCase() ?? ""
    const rest = seg.slice(1)
    const lowerRest = rest.map((a) => a.toLowerCase())
    if ((head === "del" || head === "erase") && lowerRest.includes("/f")) return true
    if (
      (head === "rd" || head === "rmdir") &&
      lowerRest.includes("/s") &&
      lowerRest.includes("/q")
    ) {
      return true
    }
  }
  return false
}

// PowerShell force-delete cmdlet（吸收 codex `has_force_delete_cmdlet`）：
// remove-item/ri/rm/del/erase/rd/rmdir 的下一個 token 是 -force 或 -force:<x>。
// cmd.exe 刪除家族的斜線開關字母（依命令精確列舉）。刻意不用 `/^\/[a-z]{1,3}$/`
// 通配——那會把 /tmp、/etc 等單層 POSIX 頂層路徑誤濾成旗標（fail-open 方向，
// 比現況更糟）；逐字元比對實際支援的開關字母才不漏真路徑。
const CMD_SWITCH_LETTERS: Record<string, Set<string>> = {
  del: new Set(["f", "p", "s", "q", "a"]),
  erase: new Set(["f", "p", "s", "q", "a"]),
  rd: new Set(["s", "q"]),
  rmdir: new Set(["s", "q"]),
}

// `/f` `/s` `/q` 是開關而非 operand；`/a:<attrs>` 的值也是開關參數而非路徑。
// 合併形態（`del /fs`）逐字元比對；大小寫不敏感（cmd 開關不分大小寫）。
function isCmdSwitch(token: string, head: string): boolean {
  const letters = CMD_SWITCH_LETTERS[head]
  if (letters === undefined) return false
  const m = /^\/([a-z]+)(?::.*)?$/i.exec(token)
  return m !== null && m[1].toLowerCase().split("").every((ch) => letters.has(ch))
}

function hasPsForceDelete(tokens: string[]): boolean {
  return tokens.some((t, i) => {
    const lower = t.replace(/['"]/g, "").toLowerCase()
    if (!DELETE_CMDLETS.includes(lower)) return false
    const next = tokens[i + 1]
    if (next === undefined) return false
    const n = next.toLowerCase()
    return n === "-force" || n.startsWith("-force:")
  })
}

// URL/GUI 啟動的 phishing 防線
function hasUrl(tokens: string[]): boolean {
  return tokens.some((t) => /^https?:\/\//i.test(cleanToken(t)))
}

function findFlagIndex(tokens: string[], flags: string[]): number {
  const lowered = flags.map((f) => f.toLowerCase())
  return tokens.findIndex((t) => lowered.includes(stripQuotes(t).toLowerCase()))
}

// -Command 內嵌形態（-Command:<script>）與「旗標後接字串」兩者皆收
function inlineAfterFlag(tokens: string[], flags: string[], inlinePrefix: string): string {
  for (let i = 0; i < tokens.length; i++) {
    const l = stripQuotes(tokens[i]).toLowerCase()
    if (inlinePrefix.length > 0 && l.startsWith(inlinePrefix)) return tokens[i].slice(inlinePrefix.length)
    if (flags.includes(l)) return tokens[i + 1] ?? ""
  }
  return ""
}

function leafVerdict(cmd: string, rest: string[], workspace: string): Verdict {
  // 直接命中的 OS 級破壞操作
  if (EXTREME_COMMANDS.has(cmd)) return "extreme"
  if (cmd === "reg" && rest.some((a) => REG_SUBCOMMANDS.has(a.toLowerCase()))) return "extreme"
  if (cmd === "cipher" && rest.some((a) => a.toLowerCase() === "/w")) return "extreme"

  // URL/GUI 啟動（phishing）：Start-Process <url>、Invoke-Item <url>、mshta <url>…
  if (URL_LAUNCHERS.includes(cmd) && hasUrl(rest)) return "extreme"

  // force-delete 家族（rm / Remove-Item / del …）
  if (DELETE_CMDLETS.includes(cmd)) {
    const hasForce = hasForceRm(rest) || hasPsForceDelete([cmd, ...rest]) || hasCmdForceDelete([cmd, ...rest])
    if (!hasForce) return null
    // workspace 逃逸判定：任何 operate 路徑不在 workspace 內或為系統頂層 → extreme；
    // 全部在 workspace 內 → "force"（現行一層 ask 的 dangerous 層，保護正常 agent 清理）。
    // 排除 cmd.exe 家族斜線開關（del /f /s /q…）：否則 `cmd /c del /f <workspace 內>`
    // 的 /f 被誤當 target，resolve 到目前磁碟根（workspace 外）→ 假 extreme。
    const targets = rest.filter((a) => !a.startsWith("-") && !isCmdSwitch(a, cmd))
    const escaped = targets.some((t) => !isInsideWorkspace(workspace, t) || isTopLevelSystemPath(t))
    return escaped ? "extreme" : "force"
  }
  return null
}

// 單一命令（token 已切好、不含 statement 分隔符）的 wrapper 穿透 + leaf 判定。
// wrapper：sudo / env X=Y / bash|sh|zsh -c / cmd /c / pwsh -Command / trap —— depth ≤8 往內穿透。
function scanStatement(rawTokens: string[], workspace: string, depth: number): Verdict {
  if (depth > MAX_WRAPPER_DEPTH) return null // fail-open 方向：深度過深不作 extreme（交由 dangerous 層）
  let argv = rawTokens.map(cleanToken)
  for (let d = depth; d <= MAX_WRAPPER_DEPTH; d++) {
    if (argv.length === 0) return null
    const cmd = basenamePath(argv[0])
    const rest = argv.slice(1)

    if (cmd === "sudo") {
      argv = rest
      continue
    }

    if (cmd === "env") {
      const i = rest.findIndex((a) => a === "--" || (!a.includes("=") && !a.startsWith("-")))
      if (i < 0) return null // env 只設定變數，後面沒有命令
      argv = rest.slice(i + (rest[i] === "--" ? 1 : 0))
      continue
    }

    if (POSIX_SHELLS.has(cmd)) {
      const script = inlineAfterFlag(rest, ["-c", "-lc"], "")
      if (script.trim() === "") return null
      return deepScanScript(script, workspace, d + 1)
    }

    if (cmd === "cmd") {
      const i = findFlagIndex(rest, ["/c", "/k", "/r", "-c"])
      // 找不到 /c 等旗標時不可整串放棄（fail-open）：argv 形態仍把 rest 續掃到底
      if (i < 0) return deepScanTokens(rest, workspace, d + 1)
      return deepScanTokens(rest.slice(i + 1), workspace, d + 1)
    }

    if (cmd === "pwsh" || cmd === "powershell") {
      // 大小寫不敏感：-Command / -Command:<inline> / -c
      const script = inlineAfterFlag(rest, ["-command", "-c"], "-command:")
      // 無 -Command 時也掃 rest（如 `powershell Remove-Item a.txt -Force`：
      // token 流以 cmdlet 開頭）——不可讓整段靜默逃逸
      if (script.trim() === "") return deepScanTokens(rest, workspace, d + 1)
      return deepScanScript(script, workspace, d + 1)
    }

    if (cmd === "trap") {
      const action = rest.find((a) => !a.startsWith("-") && !a.includes("="))
      if (action === undefined) return null
      return deepScanScript(action, workspace, d + 1)
    }

    return leafVerdict(cmd, rest, workspace)
  }
  return null
}

// 對 token 流掃描：任一 token 含 ; & | 換行 → 先按語句切多條逐條掃，
// 取最高 verdict（extreme > force > null）。
function deepScanTokens(tokens: string[], workspace: string, depth: number): Verdict {
  if (depth > MAX_WRAPPER_DEPTH) return null
  if (!tokens.some((t) => STATEMENT_SEPARATORS.test(t))) {
    return scanStatement(tokens, workspace, depth)
  }
  // 依語句切割（保留其餘 token 邊界）：`echo hi&del /f x` → ["echo hi"], ["del /f x"]
  let worst: Verdict = null
  let cur: string[] = []
  const flush = () => {
    if (cur.length > 0) {
      const v = scanStatement(cur, workspace, depth + 1)
      if (v === "extreme") worst = "extreme"
      else if (v === "force" && worst !== "extreme") worst = "force"
      cur = []
    }
  }
  for (const tok of tokens) {
    let pending = tok
    while (pending.length > 0) {
      const hit = pending.search(STATEMENT_SEPARATORS)
      if (hit < 0) {
        cur.push(pending)
        break
      }
      pushWords(pending.slice(0, hit), cur)
      flush()
      pending = pending.slice(hit + 1)
    }
  }
  flush()
  return worst
}

// 字串形式腳本（bash -c / pwsh -Command 的內容）→ 切詞後走同一管線
function deepScanScript(script: string, workspace: string, depth: number): Verdict {
  return deepScanTokens(script.split(/\s+/), workspace, depth)
}

// classify：extreme 優先（extreme 蓋過 dangerous）；未中 extreme 但偵測到
// workspace 內 force-delete → dangerous（現行一層 ask 層）；其餘沿用現行
// dangerous 語義（metachar / dangerousCommands / dangerousFlags）→ dangerous。
export function classifyDanger(
  argv: string[],
  workspace: string,
  dangerousCommands: string[] = [],
  dangerousFlags: string[] = [],
): DangerClass {
  const verdict = deepScanTokens(argv, workspace, 0)
  if (verdict === "extreme") return "extreme"
  if (verdict === "force") return "dangerous"
  // 現行 dangerous 語義（搬入 index.ts isDangerousArgv）：
  // deny-on-metachar ⇒ approval required even when every basename looks harmless。
  const METACHAR = [";", "&&", "|", "$(", "`"]
  if (argv.some((t) => METACHAR.some((m) => t.includes(m)))) return "dangerous"
  if (argv.some((a) => dangerousCommands.includes(basenamePath(a)))) return "dangerous"
  if (argv.some((a) => dangerousFlags.includes(a))) return "dangerous"
  return "none"
}

export function isExtremeDangerous(argv: string[], workspace: string): boolean {
  // 穿透 wrapper（bash -c / cmd /c / pwsh -Command / sudo / env / trap；depth ≤8）
  return deepScanTokens(argv, workspace, 0) === "extreme"
}
