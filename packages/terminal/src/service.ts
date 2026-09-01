import { spawn, type IPty } from "node-pty"

// M27-H-2 (win32 ConPTY quirk): node-pty's fork()'d conpty_console_list_agent
// agent writes "Error: AttachConsole failed" to its INHERITED stderr on every
// PTY kill (exit status 0) — the subprocess stderr cannot be intercepted
// library-side, so the known-noise filter runs on the terminal surface's ERROR
// REPORT path: matching lines are stripped before an error escapes a tool, and
// an all-noise report yields the benign terminal-state outcome instead.
// Upstream: https://github.com/microsoft/node-pty (winptyagent).
const CONPTY_NOISE_RE = /AttachConsole failed|conpty_console_list_agent/i

/** True when a single error-report line is known ConPTY agent noise. */
export function isKnownConptyNoise(line: string): boolean {
  return CONPTY_NOISE_RE.test(line)
}

/** Strip known ConPTY noise lines from a PTY error report (per-line match). */
export function filterConptyNoise(text: string): string {
  return text.replace(/\r\n/g, "\n").split("\n").filter((l) => !isKnownConptyNoise(l)).join("\n")
}

export interface TerminalOpenSpec {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}
export type TerminalSignalName = "INT" | "TERM" | "KILL"
export interface TerminalView {
  id: string
  command: string
  pid: number
  status: "running" | "exited"
  exitCode?: number
  cols: number
  rows: number
  beganAt: string
  ownerSessionId?: string
}
export interface TerminalRunSpec { id: string; pid: number; cols: number; rows: number }
export interface TerminalReadResult {
  id: string
  data: string
  nextOffset: number
  truncated: boolean
  status: TerminalView["status"]
  exitCode?: number
}
export interface TerminalService {
  open(spec: TerminalOpenSpec, opts?: { sessionId?: string }): TerminalRunSpec
  send(id: string, data: string, opts?: { sessionId?: string }): void
  read(id: string, opts?: { offset?: number; maxBytes?: number; sessionId?: string }): TerminalReadResult
  signal(id: string, signal: TerminalSignalName, opts?: { sessionId?: string }): TerminalView
  close(id: string, opts?: { sessionId?: string }): TerminalView
  resize(id: string, cols: number, rows: number, opts?: { sessionId?: string }): TerminalView
  list(): TerminalView[]
  waitExited(id: string): Promise<{ exitCode?: number }>
  dispose(): void
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const DEFAULT_MAX_READ_BYTES = 64_000

// 場沖模型：每 terminal 一個 chunks 序列（string[]），offset 以 UTF-16 code unit 計
// （與 LSP position 慣例一致，文件化）。read(offset) 回傳 [offset, offset+max)：
// 可重複、可以任意游標重讀——日誌視圖語意，非消耗型。
class PtySession {
  static counter = 0 // 先於 id 初始化（useDefineForClassFields 聲明序）
  readonly id = `term-${++PtySession.counter}`
  private chunks: string[] = []
  // 超過 RING_MAX 就丟最舊——早於 ring 起點的 offset 從 ring 起點開始（文件化缺點）。
  private static readonly RING_MAX = 1_000_000
  status: "running" | "exited" = "running"
  exitCode?: number
  readonly pty: IPty
  /** ConPTY ready 信號（首個 onData）——resize 下發門檻（見 onData 註釋）。service 閉包需要讀。 */
  ptyReady = false
  // M26-B2 (win32 校準)：ConPTY 的 pty.cols/rows getter 在 resize 後是異步/過期值，而且
  // resize 已 exit 的 pty 直接 throw——view 的尺寸以 service 追蹤值為準（resize 對 exited
  // 節點是 no-op 但追蹤值仍更新；running 時才真的下發 pty.resize）。
  cols: number
  rows: number
  readonly beganAt = new Date().toISOString()
  private dataWaiters: Array<() => void> = []
  // public：waitExited（service 閉包）需要 push——用方法收回不如直接可讀（內部一致性）。
  exitWaiters: Array<{ resolve: (v: { exitCode?: number }) => void; reject: (e: Error) => void }> = []

  constructor(readonly spec: TerminalOpenSpec, readonly ownerSessionId?: string) {
    this.cols = spec.cols ?? DEFAULT_COLS
    this.rows = spec.rows ?? DEFAULT_ROWS
    this.pty = spawn(spec.command, spec.args ?? [], {
      name: "xterm-256color",
      cols: spec.cols ?? DEFAULT_COLS,
      rows: spec.rows ?? DEFAULT_ROWS,
      cwd: spec.cwd,
      env: { ...process.env, ...(spec.env ?? {}) },
    })
    this.pty.onData((d: string) => {
      // ConPTY ready 信號：首個 onData（未必是應用輸出——初始化 ESC 序也夠）。在 ready 前
      // resize 會被 node-pty 的 deferred queue 收走；pty 早退時隊列執行即 throw
      // "Cannot resize a pty that has already exited"（async uncaught——vitest 視為失敗），
      // 所以 resize 只在 ready 後直接走（sync throw 可被捕）。
      this.ptyReady = true
      const cleaned = d.replace(/\r\n/g, "\n") // Windows pty CRLF/LF 歸一
      this.chunks.push(cleaned)
      const joined = this.chunks.join("")
      if (joined.length > PtySession.RING_MAX) this.chunks = [joined.slice(-PtySession.RING_MAX)]
      for (const w of this.dataWaiters) w()
      this.dataWaiters = []
    })
    this.pty.onExit(({ exitCode }) => {
      this.status = "exited"
      this.exitCode = exitCode
      for (const w of this.exitWaiters) w.resolve({ ...(exitCode !== undefined ? { exitCode } : {}) })
      this.exitWaiters = []
    })
  }

  textSince(offset: number): string {
    const combined = this.chunks.join("")
    if (offset >= combined.length) return ""
    return combined.slice(Math.max(0, offset))
  }

  closePty(): void { try { this.pty.kill() } catch { /* 已死 */ } }
  rejectAllExitWaiters(err: Error): void {
    for (const w of this.exitWaiters) w.reject(err)
    this.exitWaiters = []
  }
}

export function createTerminalService(): TerminalService {
  const sessions = new Map<string, PtySession>()

  function getOwned(sessions: Map<string, PtySession>, id: string, sessionId?: string): PtySession {
    const s = sessions.get(id)
    if (!s) throw new Error(`TERMINAL_NOT_FOUND: no terminal ${id}`)
    if (s.ownerSessionId !== undefined && sessionId !== s.ownerSessionId) {
      throw new Error(`TERMINAL_OWNER_MISMATCH: terminal ${id} is owned by session ${s.ownerSessionId}`)
    }
    return s
  }
  const view = (s: PtySession): TerminalView => ({
    id: s.id,
    command: s.spec.command,
    pid: s.pty.pid,
    status: s.status,
    ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
    cols: s.cols,
    rows: s.rows,
    beganAt: s.beganAt,
    ...(s.ownerSessionId !== undefined ? { ownerSessionId: s.ownerSessionId } : {}),
  })

  return {
    open(spec, opts) {
      const s = new PtySession(spec, opts?.sessionId)
      const pid = s.pty.pid
      sessions.set(s.id, s)
      return { id: s.id, pid, cols: s.cols, rows: s.rows }
    },
    send(id, data, opts) { getOwned(sessions, id, opts?.sessionId).pty.write(data) },
    read(id, opts) {
      const s = getOwned(sessions, id, opts?.sessionId)
      const offset = opts?.offset ?? 0
      const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_READ_BYTES
      const text = s.textSince(offset)
      const data = text.slice(0, maxBytes)
      return {
        id,
        data,
        nextOffset: offset + data.length,
        truncated: text.length > data.length,
        status: s.status,
        ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
      }
    },
    signal(id, signal, opts) {
      const s = getOwned(sessions, id, opts?.sessionId)
      switch (signal) {
        case "INT": s.pty.write("\x03"); break          // 終端 Ctrl+C（ConPTY cooked mode）
        case "TERM": s.pty.kill(); break                 // pty.kill（win: 終止 conpty 主體）
        case "KILL": s.pty.kill(); break
      }
      return view(s)
    },
    close(id, opts) {
      const s = getOwned(sessions, id, opts?.sessionId)
      s.closePty()
      sessions.delete(id)
      return view(s)
    },
    resize(id, cols, rows, opts) {
      const s = getOwned(sessions, id, opts?.sessionId)
      s.cols = cols
      s.rows = rows
      // 追蹤值一律更新；pty.resize 只在 running + ready 時下發（否則被 node-pty 的 deferred
      // queue 收走→pty 早退時 async throw——見 PtySession.ptyReady 註釋）。sync throw 也吞掉。
      if (s.status === "running" && s.ptyReady) {
        try { s.pty.resize(cols, rows) } catch { /* 已死——追蹤值仍更新 */ }
      }
      return view(s)
    },
    list() { return [...sessions.values()].map(view) },
    waitExited(id) {
      return new Promise((resolve, reject) => {
        const s = sessions.get(id)
        if (!s) { reject(new Error(`TERMINAL_NOT_FOUND: no terminal ${id}`)); return }
        if (s.status === "exited") { resolve({ ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}) }); return }
        s.exitWaiters.push({ resolve, reject }) // onExit / dispose 雙向解決
      })
    },
    dispose() {
      const err = new Error("terminal service disposed")
      for (const s of sessions.values()) { s.closePty(); s.rejectAllExitWaiters(err) }
      sessions.clear()
    },
  }
}
