// @i-harness/tui — G2 (M46a): visual slash commands — /theme /timestamps
// /multiline /compact-mode /minimal /fullscreen.
// Real knobs on app state: theme = the palette id (M49 Task 8 — the six-id
// SettingsTheme vocabulary: system / grok-night / grok-day / tokyo-night /
// rose-pine-moon / oscura-midnight — the loop's setTheme is the shared
// preview/commit/rollback path WITH persistence, /theme and the Settings row
// are the same route), timestamps = the engine's runtime showTimestamps
// (rows gain/lose ts on the next viewport draw), multiline = the prompt's
// multiLine flag, compact-mode = the layout compact option (vpad 0 / hpad 1),
// minimal + fullscreen = the host relaunch (ModeSwitch — same session,
// flipped mode, persisted screenMode).

import type { SettingsTheme } from "@i-harness/settings"
import type { SlashCommand } from "../types.ts"

/** The slash theme vocabulary = the persisted settings vocabulary (M49 Task 8). */
export type ThemeKind = SettingsTheme
export const THEME_ORDER: ThemeKind[] = [
  "system",
  "grok-night",
  "grok-day",
  "tokyo-night",
  "rose-pine-moon",
  "oscura-midnight",
]

/** Cycle order (bare /theme): system → grok-night → grok-day → tokyo-night →
 * rose-pine-moon → oscura-midnight → system. */
export function nextTheme(current: ThemeKind): ThemeKind {
  const i = THEME_ORDER.indexOf(current)
  return THEME_ORDER[(i + 1) % THEME_ORDER.length]!
}

function cycleTheme(ctx: Parameters<SlashCommand["run"]>[0]): void {
  const current: ThemeKind = ctx.app.theme === undefined || ctx.app.theme === "auto"
    ? "system"
    : ctx.app.theme
  const next = nextTheme(current)
  ctx.setTheme(next)
  ctx.toast(`theme: ${next === "system" ? "auto" : next}`)
}

export const visualCommands: SlashCommand[] = [
  {
    name: "theme",
    description: "Cycle theme (auto → grok-night → grok-day → tokyo-night → …)",
    argumentHint: "[name]",
    run(ctx) {
      const arg = ctx.arg.trim().toLowerCase()
      if (arg === "") { cycleTheme(ctx); return }
      const canonical = arg === "auto" ? "system" : arg
      if ((THEME_ORDER as string[]).includes(canonical)) {
        ctx.setTheme(canonical as ThemeKind)
        ctx.toast(`theme: ${arg === "auto" ? "auto" : canonical}`)
        return
      }
      ctx.toast(`theme: unknown '${arg}' (system | grok-night | grok-day | tokyo-night | rose-pine-moon | oscura-midnight)`)
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
