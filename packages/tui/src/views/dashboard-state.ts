// M49 Task 13 (spec §8.3): the local dashboard STATE — rows + selection +
// filter + pin/order. Pure: no I/O, no rendering, no backend dependency — the
// loop feeds rows from BackendClient.dashboard() (backend truth) and the view
// reads visibleRows()/selectedId() only.
//
// Truth rules:
//   - The stable id is the SESSION id. Selection survives row refreshes by id
//     (a vanished selected id falls back to the first visible row).
//   - Pinned/order ids come from the persisted tui.prefs.dashboard — ids that
//     are NOT in the current rows are IGNORED for display but KEPT in the
//     persisted snapshot until a successful commit prunes them
//     (persistedDashboard() / pruneMissing() — the host calls pruneMissing
//     AFTER its settings.set resolves; missing ids are never deleted eagerly).

import type { DashboardSessionRow } from "../contracts.ts"

/** The persisted dashboard preference shape (tui.prefs.dashboard). */
export interface DashboardPrefs {
  pinned: string[]
  order: string[]
}

export interface DashboardState {
  /** Set the single selection (by stable session id). */
  select(id: string): void
  /** The selected session id (undefined when no rows). */
  selectedId(): string | undefined
  /** Single-step relative selection (-1/+1 — clamps to the visible rows). */
  move(delta: number): void
  /** Replace the authoritative rows (a dashboard refresh from backend truth); */
  replaceRows(rows: DashboardSessionRow[]): void
  /** The rows currently visible (order: pinned → persisted order → rest). */
  visibleRows(): DashboardSessionRow[]
  /** The raw authoritative rows (unfiltered). */
  rows(): DashboardSessionRow[]
  setFilter(text: string): void
  filter(): string
  pin(id: string): void
  unpin(id: string): void
  isPinned(id: string): boolean
  /** Reorder the pinned block ([ / ] on the dashboard screen) — the pin order
   * IS the display order of the pinned rows. */
  movePin(id: string, delta: 1 | -1): void
  /** For persist: the full pinned/order lists (missing ids still included —
   * they are deleted only after a successful commit). */
  persistedDashboard(): DashboardPrefs
  /** After a successful settings commit: prune ids no longer present in the
   * authoritative rows (missing ids are finally deleted — the "next successful
   * commit" rule). */
  pruneMissing(rows: DashboardSessionRow[]): void
}

/** Rows whose ids are absent from the persisted lists — anything not matching
 * a known row is skipped (a persisted id for a deleted session is ignored). */
export function createDashboardState(
  rows: DashboardSessionRow[] = [],
  prefs: Partial<DashboardPrefs> = {},
): DashboardState {
  let all = rows.map((r) => ({ ...r }))
  let pinned = [...(prefs.pinned ?? [])]
  let order = [...(prefs.order ?? [])]
  let filterText = ""
  let selected: string | undefined

  function knownIds(): Set<string> {
    return new Set(all.map((r) => r.id))
  }

  function visible(): DashboardSessionRow[] {
    const byId = new Map(all.map((r) => [r.id, r]))
    const known = knownIds()
    const out: DashboardSessionRow[] = []
    const seen = new Set<string>()
    for (const id of pinned) {
      if (!seen.has(id) && known.has(id)) {
        const row = byId.get(id)
        if (row !== undefined) {
          out.push(row)
          seen.add(id)
        }
      }
    }
    for (const id of order) {
      if (!seen.has(id) && known.has(id)) {
        const row = byId.get(id)
        if (row !== undefined) {
          out.push(row)
          seen.add(id)
        }
      }
    }
    // Recency order; a TIE (equal updatedAt — server-epoch stamps) keeps the
    // LISTING's own order (JS sort is stable — never a random id tie-break).
    const rest = [...all]
      .filter((r) => !seen.has(r.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    for (const row of rest) {
      out.push(row)
      seen.add(row.id)
    }
    return out
  }

  function visibleFiltered(): DashboardSessionRow[] {
    if (filterText === "") return visible()
    const q = filterText.toLowerCase()
    return visible().filter((row) =>
      row.title.toLowerCase().includes(q)
      || row.id.toLowerCase().includes(q)
      || (row.modelLabel !== undefined && row.modelLabel.toLowerCase().includes(q)),
    )
  }

  return {
    select(id) {
      selected = id
    },
    selectedId() {
      // STABLE SELECTION: the by-id selection survives row refreshes AND a
      // filter hiding the row (the id is still the user's intent — revisiting
      // the surface after a refresh would otherwise reset it). Before the
      // first backend fetch lands (no rows) the explicit selection wins too.
      if (selected !== undefined && all.some((row) => row.id === selected)) return selected
      if (selected !== undefined && all.length === 0) return selected
      return visibleFiltered()[0]?.id
    },
    move(delta) {
      const rows = visibleFiltered()
      if (rows.length === 0) {
        selected = undefined
        return
      }
      const current = rows.findIndex((row) => row.id === selected)
      const next = current === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, current + delta))
      selected = rows[next]!.id
    },
    replaceRows(next) {
      all = next.map((r) => ({ ...r }))
      // selection is id-based: keep it when the id survives in the RAW rows
      // (a filter hiding it must not clear the stable selection — spec §8.3
      // "Agent→Dashboard preserves filter/cursor"); a VANISHED id falls back
      // to the first visible row.
      if (selected !== undefined && !all.some((row) => row.id === selected)) {
        selected = visibleFiltered()[0]?.id
      }
    },
    visibleRows() {
      return visibleFiltered()
    },
    rows() {
      return [...all]
    },
    setFilter(text) {
      filterText = text
    },
    filter() {
      return filterText
    },
    pin(id) {
      if (!pinned.includes(id)) pinned.push(id)
      if (!order.includes(id)) order.push(id)
    },
    unpin(id) {
      pinned = pinned.filter((entry) => entry !== id)
      order = order.filter((entry) => entry !== id)
    },
    isPinned(id) {
      return pinned.includes(id)
    },
    movePin(id, delta) {
      if (!pinned.includes(id)) return
      const pins = [...pinned]
      const i = pins.indexOf(id)
      const j = Math.max(0, Math.min(pins.length - 1, i + delta))
      if (j === i) return
      pins.splice(i, 1)
      pins.splice(j, 0, id)
      pinned = pins
      // the pin order IS the persisted display order of the pinned block.
      order = pins
    },
    persistedDashboard() {
      return { pinned: [...pinned], order: [...order] }
    },
    pruneMissing(rows) {
      const known = new Set(rows.map((r) => r.id))
      pinned = pinned.filter((id) => known.has(id))
      order = order.filter((id) => known.has(id))
    },
  }
}
