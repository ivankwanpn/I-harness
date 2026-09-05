// @i-harness/tui — G2 (M46a): tools slash commands — /doctor /copy /export
// /transcript /help /quit.
// Backend truth (M47 G2): /doctor is a LIVE probe now — the command opens the
// doctor panel in the "Probing…" state FIRST, then the loop's probeReport
// suspends the frame pump (≤800ms), re-issues the capability queries through
// the app's write sink and merges the answers into the context; the report
// rows land when the run settles. (The M46a note — re-running mid-frame would
// interleave raw escape queries with TUI bytes — is superseded by the
// paint-suspend: NO frames are written while the probe owns the tty.)
// /copy = the existing `y` copy-block action (toast; clipboard M38).
// /export writes a real transcript txt into the workspace (fs).
// /transcript serializes the engine rows to a temp .ansi/txt and spawns
// $PAGER (honest simple; Windows fallback `cmd /c start` the temp file).
// /help = shortcuts cheatsheet; /quit = the normal quit sequence.

import type { SlashCommand } from "../types.ts"
import type { LightPanelRow } from "../../../views/light-panel.ts"
import { doctorProbingRows } from "../../../views/light-doctor.ts"

export const toolsCommands: SlashCommand[] = [
  {
    name: "doctor",
    description: "Terminal capability report (live probe)",
    run: async (ctx) => {
      // LIVE probe (M47 G2): the panel opens in the Probing… state FIRST (that
      // frame paints before the probe's paint-suspend engages) — then the
      // loop's probeReport re-runs the probe against the terminal and the rows
      // land when the run settles (answers or the ≤800ms window).
      if (ctx.probeReport === undefined) {
        ctx.openPanel({ kind: "doctor", title: "TUI doctor", rows: [{ label: "probe report unavailable" }] })
        return
      }
      ctx.openPanel({ kind: "doctor", title: "TUI doctor", rows: doctorProbingRows() })
      const rows = (await ctx.probeReport()) ?? [{ label: "probe report unavailable" }]
      ctx.openPanel({ kind: "doctor", title: "TUI doctor", rows })
    },
  },
  {
    name: "copy",
    description: "Copy the selected block",
    run(ctx) {
      ctx.copyBlock()
    },
  },
  {
    name: "export",
    description: "Write the session transcript to a workspace file",
    run: async (ctx) => {
      const path = await ctx.exportTranscript()
      ctx.toast(path !== undefined ? `exported: ${path}` : "export failed")
    },
  },
  {
    name: "transcript",
    description: "Open the transcript in $PAGER (temp file)",
    run: async (ctx) => {
      const ok = await ctx.openTranscriptPager()
      ctx.toast(ok ? "transcript: pager opened" : "transcript failed")
    },
  },
  {
    name: "help",
    description: "Shortcuts cheatsheet",
    run(ctx) {
      ctx.openPanel({ kind: "cheatsheet", title: "Shortcuts", rows: helpRows() })
    },
  },
  {
    name: "quit",
    description: "Quit the TUI",
    run(ctx) {
      ctx.quitApp()
    },
  },
]

export function helpRows(): LightPanelRow[] {
  return [
    { label: "j/k", detail: "scroll up/down" },
    { label: "g/G", detail: "top/bottom" },
    { label: "L/H", detail: "next/prev turn" },
    { label: "y", detail: "copy block" },
    { label: "Tab", detail: "prompt ⇄ scrollback" },
    { label: "Enter", detail: "submit · Ctrl+Enter interject" },
    { label: "Shift+Tab", detail: "mode (normal → plan)" },
    { label: "Ctrl+Q", detail: "quit" },
    { label: "Ctrl+S / Alt+S", detail: "stash/pop prompt draft" },
    { label: "F3", detail: "session picker" },
    { label: "Ctrl+G", detail: "tasks pane (fullscreen) / $EDITOR (minimal)" },
    { label: "Ctrl+T", detail: "todo pane" },
    { label: "Ctrl+;", detail: "queue pane" },
    { label: "Esc (empty, ≥1 turn)", detail: "rewind picker (Esc Esc)" },
    { label: "/ <name>", detail: "slash command (Enter runs on submit)" },
  ]
}
