// @i-harness/tui — G2 (M46a): tools slash commands — /doctor /copy /export
// /transcript /help /quit.
// Backend truth: /doctor reports the SESSION'S terminal capability context
// (the startup probe result — re-running probeCapabilities mid-frame would
// interleave raw escape queries with TUI bytes; see light-doctor.ts).
// /copy = the existing `y` copy-block action (toast; clipboard M38).
// /export writes a real transcript txt into the workspace (fs).
// /transcript serializes the engine rows to a temp .ansi/txt and spawns
// $PAGER (honest simple; Windows fallback `cmd /c start` the temp file).
// /help = shortcuts cheatsheet; /quit = the normal quit sequence.

import type { SlashCommand } from "../types.ts"
import type { LightPanelRow } from "../../../views/light-panel.ts"

export const toolsCommands: SlashCommand[] = [
  {
    name: "doctor",
    description: "Terminal capability report",
    run: async (ctx) => {
      const rows = (await ctx.probeReport?.()) ?? [{ label: "probe report unavailable" }]
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
