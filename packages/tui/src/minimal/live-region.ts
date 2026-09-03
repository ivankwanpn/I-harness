// @i-harness/tui — G2: minimal-mode live-region content model (M38a).
// Pure composition — no terminal, no tui-core: WHAT the live region shows,
// bottom-anchored (spec §1.1): `[live tail · todos · status(1) · prompt(1)]`
// (+ an optional info row). Prompt + status are ALWAYS visible (idle minimum
// 2 rows); the tail is truncated to fit and keeps the LAST lines (the most
// recent content); an optional info row shows only when `showInfo`.

import type { RegionLine } from "./contracts.ts"

export interface LiveRegionState {
  /** Residual live tail — the engine's recent display rows, oldest first.
   * Truncated to fit (keeps the LAST lines). */
  tail: RegionLine[]
  /** Todo summary rows (optional — empty = hidden). */
  todos: RegionLine[]
  /** Status row: `model · flag · context · queued` (spec §5.5). */
  status: RegionLine
  /** Prompt row — the bottom row; always focused in minimal mode. */
  prompt: RegionLine
  /** Prompt info row — drawn only when `showInfo` is set. */
  info: RegionLine
}

export interface ComposeRegionOptions {
  /** Draw the info row (default false — the minimal quick prompt hides it). */
  showInfo?: boolean
}

/**
 * Compose the region rows bottom-anchored: [tail (residual) · todos
 * (optional) · status(1) · prompt(1) · info(1 if showInfo)], total ≤ maxRows.
 *
 * - status+prompt are always visible (idle minimum 2 rows).
 * - the tail is truncated to fit — LAST lines survive (most recent wins).
 * - when even the fixed rows do not fit (maxRows < 2), the prompt row wins
 *   (the bottom row is always the prompt, spec §1.1).
 */
export function composeRegion(
  state: LiveRegionState,
  maxRows: number,
  opts: ComposeRegionOptions = {},
): RegionLine[] {
  if (maxRows <= 0) return []
  const fixed: RegionLine[] = [state.status, state.prompt]
  if (opts.showInfo === true) fixed.push(state.info)
  if (maxRows < fixed.length) {
    // One row fits only the prompt — the bottom row wins under pressure.
    return fixed.slice(fixed.length - maxRows)
  }
  const budget = maxRows - fixed.length
  const todos = state.todos.length > 0 ? state.todos.slice(-budget) : []
  // slice(-0) === slice(0): guard the zero-budget case eagerly.
  const tailBudget = Math.max(0, budget - todos.length)
  const tail = tailBudget > 0 ? state.tail.slice(-tailBudget) : []
  return [...tail, ...todos, ...fixed]
}
