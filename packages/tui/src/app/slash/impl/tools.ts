// @i-harness/tui — G2 (M46a): tools slash commands — /doctor /copy /export
// /transcript /help /quit.
// Backend truth (M47 G2): /doctor is a LIVE probe now — the command opens the
// doctor panel in the "Probing…" state FIRST, then the loop's probeReport
// suspends the frame pump (≤800ms), re-issues the capability queries through
// the app's write sink and merges the answers into the context; the report
// rows land when the run settles.
// /copy = the existing copy-block action through the checked clipboard
// adapter. /export writes a real transcript txt into the workspace (fs).
// /transcript serializes the engine rows to a temp .ansi/txt and spawns
// $PAGER (honest simple; Windows fallback `cmd /c start` the temp file).
// M49 Task 14 (spec §10.2): /help renders the CURRENT visible registry + the
// ACTIVE key bindings through the ctx seams — never the static list.

import type { SlashCommand, SlashPanelRow } from "../types.ts"
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
      ctx.copy()
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
    description: "Slash commands + active key bindings",
    run(ctx) {
      // M49 Task 14 (spec §10.2): the CURRENT visible inventory + the CURRENT
      // key bindings (the shortcuts-bar rows) — a static list is gone.
      const commands = ctx.visibleCommands?.() ?? []
      const keys = ctx.keyBindings?.() ?? []
      const rows: LightPanelRow[] = [
        { label: "Commands", header: true },
        ...commands.map((c): SlashPanelRow => ({ label: `/${c.name}`, detail: c.description })),
        { label: "Keys", header: true },
        ...keys.map((k): SlashPanelRow => ({ label: k.key, detail: k.label })),
      ]
      ctx.openPanel({ kind: "cheatsheet", title: "Help", rows })
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
