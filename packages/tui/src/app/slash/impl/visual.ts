// @i-harness/tui — G2 (M46a): visual slash commands — /theme /timestamps
// /multiline /compact-mode /minimal /fullscreen.
// Real knobs on app state: theme = the palette kind (groknight → grokday →
// auto, the tui-core resolvePalette cycle — colors actually change),
// timestamps = the engine's runtime showTimestamps (rows gain/lose ts on the
// next viewport draw), multiline = the prompt's multiLine flag,
// compact-mode = the layout compact option (vpad 0 / hpad 1), minimal +
// fullscreen = the host relaunch (ModeSwitch — same session, flipped mode).

import type { SlashCommand } from "../types.ts"

export type ThemeKind = "groknight" | "grokday" | "auto"
export const THEME_ORDER: ThemeKind[] = ["groknight", "grokday", "auto"]

/** Cycle order (bare /theme): groknight → grokday → auto → groknight. */
export function nextTheme(current: ThemeKind): ThemeKind {
  const i = THEME_ORDER.indexOf(current)
  return THEME_ORDER[(i + 1) % THEME_ORDER.length]!
}

function cycleTheme(ctx: Parameters<SlashCommand["run"]>[0]): void {
  const current = (ctx.app.theme ?? "auto") as ThemeKind
  const next = nextTheme(current)
  ctx.setTheme(next)
  ctx.toast(`theme: ${next}`)
}

export const visualCommands: SlashCommand[] = [
  {
    name: "theme",
    description: "Cycle theme (groknight → grokday → auto)",
    argumentHint: "[name]",
    run(ctx) {
      const arg = ctx.arg.trim().toLowerCase()
      if (arg === "") { cycleTheme(ctx); return }
      if (arg === "groknight" || arg === "grokday" || arg === "auto") {
        ctx.setTheme(arg)
        ctx.toast(`theme: ${arg}`)
        return
      }
      ctx.toast(`theme: unknown '${arg}' (groknight | grokday | auto)`)
    },
  },
  {
    name: "timestamps",
    description: "Toggle right-aligned timestamps on rows",
    run(ctx) {
      const next = !(ctx.app.timestamps ?? false)
      ctx.setTimestamps(next)
      ctx.toast(next ? "timestamps on" : "timestamps off")
    },
  },
  {
    name: "multiline",
    description: "Toggle multiline prompt editing",
    run(ctx) {
      ctx.setMultiline(!ctx.app.prompt.multiLine)
      ctx.toast(ctx.app.prompt.multiLine ? "multiline on" : "multiline off")
    },
  },
  {
    name: "compact-mode",
    description: "Toggle compact mode (tighter layout)",
    run(ctx) {
      ctx.setCompactMode(!(ctx.app.compactMode ?? false))
      ctx.toast(ctx.app.compactMode ? "compact mode on" : "compact mode off")
    },
  },
  {
    name: "minimal",
    description: "Relaunch in minimal mode (terminal-native scrollback)",
    run(ctx) {
      if (ctx.relaunch()) ctx.quitApp()
    },
  },
  {
    name: "fullscreen",
    description: "Relaunch in fullscreen mode (cell TUI)",
    run(ctx) {
      if (ctx.relaunch()) ctx.quitApp()
    },
  },
]
