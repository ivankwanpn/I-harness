// @i-harness/tui — G2 (M46a): the G1-owned slash surfaces in the registry.
// /provider /model /settings run G1's modal overlays (provider menu/wizard,
// ArgPicker model select, settings modal) — the loop's tryG1SlashModal owns
// the text-match (it intercepts these BEFORE the registry run in the submit
// path); these registry entries exist so the M37b dropdown lists them and the
// registry inventory stays complete. /effort writes the settings
// llm.defaultModel.reasoningEffort through G1's settings store surface when
// the host wired a provider store (the real write — 6-dial ArgPicker is the
// settings modal's Models class, G1).

import type { SlashCommand } from "../types.ts"

export const g1Commands: SlashCommand[] = [
  {
    name: "provider",
    description: "Provider management (menu / add / use / delete / reload)",
    argumentHint: "[action]",
    run(ctx) {
      if (ctx.g1Modal?.(ctx.input) === false || ctx.g1Modal === undefined) {
        ctx.toast("provider UI: host store not wired")
      }
    },
  },
  {
    name: "model",
    description: "Model selector (ArgPicker over the active provider catalog)",
    argumentHint: "[name]",
    run(ctx) {
      if (ctx.g1Modal?.(ctx.input) === false || ctx.g1Modal === undefined) {
        ctx.toast("model picker: host store not wired")
      }
    },
  },
  {
    name: "settings",
    description: "Settings modal (Appearance / Mouse / Models / Approval …)",
    run(ctx) {
      if (ctx.g1Modal?.(ctx.input) === false || ctx.g1Modal === undefined) {
        ctx.toast("settings modal: host store not wired")
      }
    },
  },
  {
    name: "effort",
    description: "Model reasoning effort (settings llm.defaultModel.reasoningEffort)",
    argumentHint: "<level>",
    run(ctx) {
      // The honest surface: host-wired provider store → the REAL settings
      // write; the interactive ArgPicker (6-dial) is the settings modal's
      // Models class (G1). No arg → report the current effort.
      ctx.effort?.(ctx.arg)
    },
  },
]
