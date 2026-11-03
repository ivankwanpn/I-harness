import { isRecord } from "../normalize/primitives.ts"

/** Per-section revision counters persisted as the additive `_revision` top-level
 * meta key (section-mutate protocol, Task 1 of the models plan). Old readers
 * only read the nine original keys, so the meta key is harmless to them, and
 * normalizeSettings never surfaces it in its output. */
export function loadRevisionMeta(raw: unknown): Record<string, number> {
  if (!isRecord(raw) || !isRecord(raw._revision)) return {}
  const out: Record<string, number> = {}
  for (const [name, value] of Object.entries(raw._revision)) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) out[name] = value
  }
  return out
}
