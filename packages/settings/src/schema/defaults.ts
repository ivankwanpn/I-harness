import type { Settings } from "./types.ts"
import { SETTINGS_STATUS_LINE_SEGMENTS } from "./types.ts"
import { normalizeContextSubsystems } from "../context-subsystems.ts"
import { normalizeWslExecution } from "../normalize/execution.ts"

// Package-private (removed from the public entry in 2026-09-18): stores and
// normalization share this one default document. `normalizeSettings` is the
// public way to obtain the same values — which is
// what the three test files that used it as an oracle now do. The row this
// retires was blocked for months by a mis-stated reason; see the correction in
// docs/handoff/2026-09-17-remove-tui-and-web-frontends.md §3.
export const SETTINGS_DEFAULTS: Settings = {
  contextSubsystems: normalizeContextSubsystems(undefined),
  codeMode: { mode: "off" },
  autoTitle: true,
  modelWait: { firstResponseSeconds: 300, progressSeconds: 300 },
  modelRetryLimit: 5,
  sandboxMode: "workspace-write",
  windowsSandboxBackend: "legacy",
  wslExecution: normalizeWslExecution(undefined),
  webSearchMode: "cached",
  agentShell: "auto",
  approvalMode: "dangerous",
  // ON by default, matching the engine's own default (`deps.compact?.auto ?? true`)
  // and its designed ladder: layer 1 is pressure compaction at 80% of the window,
  // layers 2-3 are the pure reset and the fail-closed refusal. Shipping with this
  // unreachable meant layer 1 never ran and long sessions fell straight through to
  // `prompt_too_long`. Turning it OFF is the opt-out, not the other way round.
  compaction: { auto: true },
  // Amendment (seeded defaults removed): "" = UNset — no default model. Every
  // model now comes from the user section (llm.providers + llm.defaultModel)
  // or a per-session selection; the field is kept so an OLD file's written
  // value survives verbatim (no migration chain) while a fresh document has
  // no default anywhere.
  model: "",
  language: "zh",
  fontSize: 14,
  searchBackend: "jsonl",
  plugins: { agentLoop: true, bash: true, webSearch: false, subagentModel: false },
  agents: { roles: {} },
  // Appended sections: fresh documents default here without any migration path
  // (old files without these keys load with these values — D5/no-migration).
  llm: {
    providers: {},
    // Amendment: the section default is EMPTY ("" = unset) — no seeded model
    // is filled anywhere; the resolve chain (web.ts) treats the seed-equal
    // value as "never user-set" and falls through to core.model / mock.
    defaultModel: { provider: "", model: "" },
  },
  // "" = no welcome notice acknowledged; the frontend shows the notice while
  // welcomeNoticeVersion !== "2026-08-30.1" (Task 9) — the empty default keeps
  // the first-run notice visible, while a plain old document stays unset.
  onboarding: { welcomeNoticeVersion: "" },
  // M46a G1 appended section (M49 Task 6: presentation prefs only — the
  // provider plane is llm.providers): compact off (the fullscreen default) and
  // guardian off (the embedded factory's approveAll:true default).
  tui: {
    prefs: {
      compact: false, guardian: false,
      // M49 Task 13 (spec §9.2): dashboard order empty; the builtin status line
      // with every configurable segment.
      dashboard: { order: [] },
      statusLine: { mode: "builtin", items: [...SETTINGS_STATUS_LINE_SEGMENTS] },
    },
  },
}

/** Bounds for font size (dsh font-size row: 13–16 px). */
export const FONT_SIZE_MIN = 13

export const FONT_SIZE_MAX = 16
