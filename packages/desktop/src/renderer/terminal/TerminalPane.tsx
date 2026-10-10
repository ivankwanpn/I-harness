import { useEffect, useRef, useState } from "react"
import { Terminal, type ITerminalOptions } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { useUiStore, type Appearance } from "../shell/ui-store.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import "./terminal-pane.css"
interface Entry { id: string; command?: string; status: "running" | "exited"; exitCode?: number }
interface Output { data: string; nextOffset: number; truncated: boolean; dropped?: boolean; status: "running" | "exited"; exitCode?: number }

function terminalLabel(entry: Entry): string {
  const executable = entry.command?.split(/[\\/]/).at(-1)
  return executable ? `${executable} · ${entry.id}` : entry.id
}

const DEFAULT_TERMINAL_FONT = "Consolas, monospace"

function appearanceOptions(fontFamily: string, fontSize: number, appearance: Appearance): Pick<ITerminalOptions, "fontFamily" | "fontSize" | "theme"> {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const light = (root.dataset.theme ?? (appearance === "system" ? window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light" : appearance)) === "light"
  const background = style.getPropertyValue("--ih-bg").trim() || (light ? "#f8f8f8" : "#151515")
  const foreground = style.getPropertyValue("--ih-text").trim() || (light ? "#252525" : "#ececec")
  const selectionBackground = style.getPropertyValue("--ih-accent").trim() || (light ? "#345eac" : "#b8c9ed")
  return { fontFamily, fontSize, theme: { background, foreground, cursor: foreground, cursorAccent: background, selectionBackground, selectionForeground: background } }
}

function Emulator({ bridge, workspaceId, id, fontFamily }: { bridge: DesktopBridge; workspaceId: string; id: string; fontFamily: string }) {
  const element = useRef<HTMLDivElement>(null)
  const emulator = useRef<{ terminal: Terminal; resize(): void }>(undefined)
  const [error, setError] = useState<string>()
  const [exited, setExited] = useState<{ code?: number }>()
  const [dropped, setDropped] = useState(false)
  const [retry, setRetry] = useState(0)
  const t = useText()
  const text = useRef(t)
  text.current = t
  const fontSize = useUiStore(state => state.fontSize)
  const appearance = useUiStore(state => state.appearance)
  const presentation = useRef({ fontFamily, fontSize, appearance })
  presentation.current = { fontFamily, fontSize, appearance }
  useEffect(() => {
    if (!element.current) return
    setError(undefined); setExited(undefined); setDropped(false)
    let active = true; let offset = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let frame: number | undefined
    let inputQueue = Promise.resolve()
    let inputBytes = 0
    const terminal = new Terminal({ scrollback: 5000, ...appearanceOptions(presentation.current.fontFamily, presentation.current.fontSize, presentation.current.appearance) })
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
    emulator.current = { terminal, resize }
    const appearanceObserver = new MutationObserver(() => {
      if (!active) return
      terminal.options = appearanceOptions(presentation.current.fontFamily, presentation.current.fontSize, presentation.current.appearance)
      resize()
    })
    appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] })
    const input = terminal.onData((data) => {
      if (inputBytes + data.length > 65536) { setError(text.current("終端輸入佇列已滿，請稍後再試。")); return }
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
        if (output.status === "exited" && !output.truncated) { setExited({ code: typeof output.exitCode === "number" && Number.isInteger(output.exitCode) ? output.exitCode : undefined }); return }
        timer = setTimeout(() => { void poll() }, output.truncated ? 10 : 120)
      } catch (reason) { if (active) setError(String(reason)) }
    }
    void poll(); terminal.focus()
    return () => { active = false; clearTimeout(timer); if (frame !== undefined) cancelAnimationFrame(frame); observer.disconnect(); appearanceObserver.disconnect(); emulator.current = undefined; input.dispose(); terminal.dispose() }
  }, [bridge, workspaceId, id, retry])
  useEffect(() => {
    const current = emulator.current
    if (!current) return
    current.terminal.options = appearanceOptions(fontFamily, fontSize, appearance)
    current.resize()
  }, [fontFamily, fontSize, appearance])
  return <><div ref={element} className="terminal-emulator" />{dropped ? <p className="muted">{t("較舊終端輸出已被裁切。")}</p> : null}{exited !== undefined ? <p role="status">{exited.code === undefined ? t("終端已結束；未回報結束代碼。") : t("終端已結束，代碼 {code}", { code: exited.code })}</p> : null}{error ? <p role="alert">{error}<Button size="small" onClick={() => setRetry(retry + 1)}>{t("重試")}</Button></p> : null}</>
}

export function TerminalPane({ bridge, workspaceId, active: visible = true }: { bridge: DesktopBridge; workspaceId: string; active?: boolean }) {
  const t = useText()
  const [entries, setEntries] = useState<Entry[]>([])
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [fontFamily, setFontFamily] = useState<string>()
  const [reload, setReload] = useState(0)
  const locked = useRef(false)
  const readFontRef = useRef<(() => void) | undefined>(undefined)
  const previousVisible = useRef(visible)
  useEffect(() => {
    let active = true, ticket = 0
    setFontFamily(undefined)
    const readFont = () => {
      const read = ++ticket
      void bridge.request({ kind: "desktop/local/state" }).then((value) => {
        if (!active || ticket !== read) return
        const saved = (value as { terminalFontFamily?: unknown } | undefined)?.terminalFontFamily
        setFontFamily(typeof saved === "string" && saved.trim() ? saved.trim() : DEFAULT_TERMINAL_FONT)
      }).catch(() => { if (active && ticket === read) setFontFamily(old => old ?? DEFAULT_TERMINAL_FONT) })
    }
    const foreground = () => { if (!document.hidden) readFont() }
    readFontRef.current = readFont
    readFont()
    window.addEventListener("focus", foreground); document.addEventListener("visibilitychange", foreground)
    return () => { active = false; readFontRef.current = undefined; window.removeEventListener("focus", foreground); document.removeEventListener("visibilitychange", foreground) }
  }, [bridge, workspaceId])
  useEffect(() => {
    if (visible && !previousVisible.current) readFontRef.current?.()
    previousVisible.current = visible
  }, [visible])
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
  return <section className="terminal-pane ih-control-scope" aria-label={t("終端")}>
    <div className="terminal-controls"><select aria-label={t("選擇終端")} value={selected ?? ""} onChange={(event) => setSelected(event.target.value)}><option value="">{t("選擇終端")}</option>{entries.map((row) => <option key={row.id} value={row.id} title={row.command}>{terminalLabel(row)}</option>)}</select><Button size="small" disabled={busy || entries.length >= 8} onClick={() => { void act(false) }}>{t("新增終端")}</Button><Button size="small" disabled={busy || !selected} onClick={() => { void act(true) }}>{t("關閉終端")}</Button></div>
    <p className="muted">{t("此終端使用本機使用者權限，並非 Agent 沙箱。")}</p>
    {error ? <p role="alert">{error}<Button size="small" disabled={busy} onClick={() => setReload(reload + 1)}>{t("重試")}</Button></p> : null}
    {selected ? fontFamily === undefined ? <p>{t("正在載入終端…")}</p> : <Emulator key={selected} bridge={bridge} workspaceId={workspaceId} id={selected} fontFamily={fontFamily} /> : <p>{t("新增終端以開啟工作區 shell。")}</p>}
  </section>
}
