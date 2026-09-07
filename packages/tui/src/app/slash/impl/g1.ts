// @i-harness/tui — G2 (M46a): the G1-owned slash surfaces in the registry.
// /provider /model /settings run the M49 Task 6 modal overlays (provider
// master/detail, model picker, typed settings modal) — the loop's submit path
// intercepts /settings /provider /model FIRST (tryG1SlashModal); these
// registry entries are the inventory + unit-test surface and forward through
// the DEDICATED ctx seams (spec §10.2 "Model/settings": visible only when the
// live provider-settings capability — the provider controller — exists).
// /effort writes the settings llm.defaultModel.reasoningEffort through the
// provider controller's settings surface when the host wired it (the REAL
// write — the six-level vocabulary below; unknown levels are rejected).

import type { SlashCommand } from "../types.ts"
import { hasCapability } from "../types.ts"

/** The six-level effort vocabulary (the settings/llm-seam ReasoningEffort). */
export const EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const

export const g1Commands: SlashCommand[] = [
  {
    name: "provider",
    description: "Provider management (menu / add / use / delete / reload)",
    argumentHint: "[action]",
    visible: (ctx) => hasCapability(ctx, "provider-settings"),
    run(ctx) {
      ctx.provider?.(ctx.arg.trim())
    },
  },
  {
    name: "model",
    description: "Model selector (ArgPicker over the active provider catalog)",
    argumentHint: "[name]",
    visible: (ctx) => hasCapability(ctx, "provider-settings"),
    run(ctx) {
      ctx.model?.(ctx.arg.trim())
    },
  },
  {
    name: "settings",
    description: "Settings modal (Appearance / Mouse / Models / Approval …)",
    visible: (ctx) => hasCapability(ctx, "provider-settings"),
    run(ctx) {
      ctx.openSettings?.()
    },
  },
  {
    name: "effort",
    description: "Model reasoning effort (settings llm.defaultModel.reasoningEffort)",
    argumentHint: "<level>",
    visible: (ctx) => hasCapability(ctx, "provider-settings"),
    run(ctx) {
      // Honest surface: host-wired provider store → the REAL settings write;
      // the interactive ArgPicker (6-dial) is the settings modal's Models
      // class. No arg → report the current effort; an unknown level is
      // rejected with the vocabulary (never a silent write).
      const level = ctx.arg.trim().toLowerCase()
      if (level === "") {
        ctx.effort?.("")
        return
      }
      if (!(EFFORT_LEVELS as readonly string[]).includes(level)) {
        ctx.toast(`effort: unknown level '${level}' (off | low | medium | high | xhigh | max)`)
        return
      }
      ctx.effort?.(level)
    },
  },
]
