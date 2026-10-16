import { SETTINGS_STATUS_LINE_SEGMENTS, type SettingsStatusLineSegment, type SettingsTui } from "../schema/types.ts"
import { isRecord, isPositiveInteger, oneOf } from "./primitives.ts"

/** M49 Task 13: a string id list (non-empty strings, deduped — corrupt entries
 * dropped, non-array input degrades to []). */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === "string" && entry !== "" && !out.includes(entry)) out.push(entry)
  }
  return out
}

/** M49 Task 13: the status-segment allowlist — only valid segments survive;
 * a NON-array input (or an all-corrupt list) falls back to the full default
 * list (a corrupt file must not silently hide every segment). */
function statusLineItems(value: unknown): SettingsStatusLineSegment[] {
  if (!Array.isArray(value)) return [...SETTINGS_STATUS_LINE_SEGMENTS]
  const out: SettingsStatusLineSegment[] = []
  for (const entry of value) {
    if ((SETTINGS_STATUS_LINE_SEGMENTS as readonly string[]).includes(entry as string)) {
      out.push(entry as SettingsStatusLineSegment)
    }
  }
  return out.length > 0 ? out : [...SETTINGS_STATUS_LINE_SEGMENTS]
}

/** Appended TUI section (M49 Task 6): the presentation prefs only — the
 * legacy `providers` payload is no longer normalized (the canonical plane is
 * `llm.providers`; the store still passes the raw legacy section to the
 * read migration). Corrupt input degrades per pref.
 *
 * The projection names every key it reads, so a retired key left in an older
 * on-disk document is simply never read — the document still loads. */
export function normalizeTui(raw: unknown, base: SettingsTui): SettingsTui {
  const prefsRaw = isRecord(raw) && isRecord(raw.prefs) ? raw.prefs : {}
  const b = base.prefs
  return {
    prefs: {
      compact: typeof prefsRaw.compact === "boolean" ? prefsRaw.compact : b.compact,
      guardian: typeof prefsRaw.guardian === "boolean" ? prefsRaw.guardian : b.guardian,
      // M49 Task 13 (spec §9.2): dashboard order + the status line — corrupt
      // input degrades per field (the run-time nullability of command/refreshMs
      // is preserved — an absent value means "host default 1000ms/1s", never a
      // fabricated one).
      dashboard: {
        order: stringList((isRecord(prefsRaw.dashboard) ? prefsRaw.dashboard : {}).order),
      },
      statusLine: (() => {
        const slRaw = isRecord(prefsRaw.statusLine) ? prefsRaw.statusLine : {}
        const mode = oneOf(slRaw.mode, ["disabled", "builtin", "command"] as const, b.statusLine.mode)
        const items = statusLineItems(slRaw.items)
        const command = typeof slRaw.command === "string" && slRaw.command !== "" ? slRaw.command : undefined
        const refreshMs = isPositiveInteger(slRaw.refreshMs) ? Math.max(300, slRaw.refreshMs) : undefined
        return { mode, items, ...(command !== undefined ? { command } : {}), ...(refreshMs !== undefined ? { refreshMs } : {}) }
      })(),
    },
  }
}
