import type { AgentShellDialect } from "../types.ts"

/** Advisory approval tokens. Windows dialects preserve path backslashes; they
 * must never pass through the POSIX backslash parser. Dynamic expansion and
 * invocation stay conservative so the danger classifier requires approval. */
export function getAgentArgv(command: string, dialect: AgentShellDialect): string[] {
  if (dialect === "posix") return getArgv(command)
  const argv: string[] = []
  let token = "", quoted: "'" | '"' | undefined, started = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quoted === undefined && /\s/.test(char)) {
      if (started) argv.push(token)
      token = ""; started = false
    } else if (char === quoted) {
      if (dialect === "powershell" && command[i + 1] === quoted) { token += char; i++ }
      else quoted = undefined
    } else if (quoted === undefined && (char === '"' || (dialect === "powershell" && char === "'"))) {
      quoted = char; started = true
    } else if ((dialect === "powershell" && char === "`" && quoted !== "'") || (dialect === "cmd" && char === "^" && quoted === undefined)) {
      token += command[++i] ?? ""; started = true
    } else {
      token += char; started = true
    }
  }
  if (started) argv.push(token)
  // The shared classifier has no expansion evaluator. Never allow an expanded
  // executable/target, script block or single-& invocation as a harmless argv.
  if (quoted !== undefined || /[\r\n&]/.test(command)
    || (dialect === "cmd" ? /[%!]/.test(command) : /[$`{}]/.test(command))) argv.push(";")
  return argv
}

// Minimal shell-quote parser: splits on whitespace, honors single/double
// quotes, and honors backslash escapes outside quotes and inside double
// quotes (F03-2 bypass shapes like `r\m`, `'r''m'`, `r""m`).
export function getArgv(command: string): string[] {
  const args: string[] = []
  let current = ""
  let inArg = false
  let quote: "'" | '"' | null = null
  let i = 0
  while (i < command.length) {
    const ch = command[i]!
    if (quote === null) {
      if (ch === "'" || ch === '"') {
        quote = ch
        inArg = true
        i++
        continue
      }
      if (ch === "\\") {
        current += command[i + 1] ?? ""
        inArg = true
        i += 2
        continue
      }
      if (ch === " " || ch === "\t" || ch === "\n") {
        if (inArg) {
          args.push(current)
          current = ""
          inArg = false
        }
        i++
        continue
      }
      current += ch
      inArg = true
      i++
    } else if (ch === quote) {
      quote = null
      i++
    } else if (ch === "\\" && quote === '"') {
      current += command[i + 1] ?? ""
      i += 2
    } else {
      current += ch
      i++
    }
  }
  if (inArg) args.push(current)
  return args
}
