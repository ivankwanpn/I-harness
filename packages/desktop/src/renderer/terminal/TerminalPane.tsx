import { useEffect, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
interface Entry { id: string; command?: string; status: "running" | "exited"; exitCode?: number }
interface Output { data: string; nextOffset: number; truncated: boolean; dropped?: boolean; status: "running" | "exited"; exitCode?: number }

function terminalLabel(entry: Entry): string {
  const executable = entry.command?.split(/[\\/]/).at(-1)
  return executable ? `${executable} · ${entry.id}` : entry.id
}

const DEFAULT_TERMINAL_FONT = "Consolas, monospace"

function Emulator({ bridge, workspaceId, id, fontFamily }: { bridge: DesktopBridge; workspaceId: string; id: string; fontFamily: string }) {
  const element = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string>()
  const [exited, setExited] = useState<number>()
  const [dropped, setDropped] = useState(false)
  const [retry, setRetry] = useState(0)
  const t = useText()
  useEffect(() => {
    if (!element.current) return
    setError(undefined); setExited(undefined); setDropped(false)
    let active = true; let offset = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let frame: number | undefined
    let inputQueue = Promise.resolve()
    let inputBytes = 0
    const terminal = new Terminal({ scrollback: 5000, fontSize: 13, fontFamily, theme: { background: "#151515", foreground: "#ececec" } })
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element.current)
    const resize = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!active || !element.current?.clientWidth || !element.current.clientHeight) return
        fit.fit()
        void bridge.request({ kind: "desktop/terminal/resize", workspaceId, id, cols: Math.max(2, Math.min(500, terminal.cols)), rows: Math.max(2, Math.min(500, terminal.rows)) }).catch((reason: unknown) => { if (active) setError(String(reason)) })
      })
    }
    const observer = new ResizeObserver(resize); observer.observe(element.current); resize()
    const input = terminal.onData((data) => {
      if (inputBytes + data.length > 65536) { setError(t("終端輸入佇列已滿，請稍後再試。")); return }
      inputBytes += data.length
      inputQueue = inputQueue.then(async () => {
        for (let start = 0; start < data.length; start += 32768) await bridge.request({ kind: "desktop/terminal/write", workspaceId, id, data: data.slice(start, start + 32768) })
      }).catch((reason: unknown) => { if (active) setError(String(reason)) }).finally(() => { inputBytes -= data.length })
    })
    const poll = async () => {
      if (!active) return
      if (document.hidden) { timer = setTimeout(() => { void poll() }, 1000); return }
      try {
        const output = await bridge.request({ kind: "desktop/terminal/read", workspaceId, id, offset }) as Output
        if (!active) return
        offset = output.nextOffset
        if (output.dropped) { terminal.reset(); setDropped(true) }
        if (output.data) await new Promise<void>((resolve) => terminal.write(output.data, resolve))
        if (!active) return
        if (output.status === "exited" && !output.truncated) { setExited(output.exitCode ?? 0); return }
        timer = setTimeout(() => { void poll() }, output.truncated ? 10 : 120)
      } catch (reason) { if (active) setError(String(reason)) }
    }
    void poll(); terminal.focus()
    return () => { active = false; clearTimeout(timer); if (frame !== undefined) cancelAnimationFrame(frame); observer.disconnect(); input.dispose(); terminal.dispose() }
  }, [bridge, workspaceId, id, fontFamily, retry, t])
  return <><div ref={element} className="terminal-emulator" />{dropped ? <p className="muted">{t("較舊終端輸出已被裁切。")}</p> : null}{exited !== undefined ? <p role="status">{t("終端已結束，代碼 {code}", { code: exited })}</p> : null}{error ? <p role="alert">{error}<button onClick={() => setRetry(retry + 1)}>{t("重試")}</button></p> : null}</>
}

export function TerminalPane({ bridge, workspaceId }: { bridge: DesktopBridge; workspaceId: string }) {
  const t = useText()
  const [entries, setEntries] = useState<Entry[]>([])
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [fontFamily, setFontFamily] = useState<string>()
  const [reload, setReload] = useState(0)
  const locked = useRef(false)
  useEffect(() => {
    let active = true
    setFontFamily(undefined)
    void bridge.request({ kind: "desktop/local/state" }).then((value) => {
      if (!active) return
      const saved = (value as { terminalFontFamily?: unknown } | undefined)?.terminalFontFamily
      setFontFamily(typeof saved === "string" && saved.trim() ? saved.trim() : DEFAULT_TERMINAL_FONT)
    }).catch(() => { if (active) setFontFamily(DEFAULT_TERMINAL_FONT) })
    return () => { active = false }
  }, [bridge, workspaceId])
  useEffect(() => {
    let active = true
    void bridge.request({ kind: "desktop/terminal/list", workspaceId }).then((value) => { if (active) { const rows = value as Entry[]; setEntries(rows); setSelected((old) => rows.some((row) => row.id === old) ? old : rows[0]?.id); setError(undefined) } }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [bridge, workspaceId, reload])
  async function act(close: boolean) {
    if (locked.current || (close && !selected)) return
    locked.current = true; setBusy(true); setError(undefined)
    try {
      const result = await bridge.request(close ? { kind: "desktop/terminal/close", workspaceId, id: selected! } : { kind: "desktop/terminal/open", workspaceId }) as { id: string }
      setSelected(close ? undefined : result.id); setReload((value) => value + 1)
    } catch (reason) { setError(String(reason)) }
    finally { locked.current = false; setBusy(false) }
  }
  return <section className="terminal-pane" aria-label={t("終端")}>
    <div className="provider-actions"><select aria-label={t("選擇終端")} value={selected ?? ""} onChange={(event) => setSelected(event.target.value)}><option value="">{t("選擇終端")}</option>{entries.map((row) => <option key={row.id} value={row.id} title={row.command}>{terminalLabel(row)}</option>)}</select><button disabled={busy || entries.length >= 8} onClick={() => { void act(false) }}>{t("新增終端")}</button><button disabled={busy || !selected} onClick={() => { void act(true) }}>{t("關閉終端")}</button></div>
    <p className="muted">{t("此終端使用本機使用者權限，並非 Agent 沙箱。")}</p>
    {error ? <p role="alert">{error}<button disabled={busy} onClick={() => setReload(reload + 1)}>{t("重試")}</button></p> : null}
    {selected ? fontFamily === undefined ? <p>{t("正在載入終端…")}</p> : <Emulator key={selected} bridge={bridge} workspaceId={workspaceId} id={selected} fontFamily={fontFamily} /> : <p>{t("新增終端以開啟工作區 shell。")}</p>}
  </section>
}
