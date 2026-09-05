// @i-harness/tui — M46b G2: mouse timing constants — the SINGLE source for the
// click-semantics timings (multi-click, clipboard toast coalescing, context
// debounce, selection flash). Everything in src/app/mouse.ts + the wiring
// imports from here; no raw literal powers any mouse timing elsewhere.
// (The M40-era "wheel = 3 rows/tick" constant that the loop used is superseded
// by G1's scroll-stream — see loop.ts mouse routing.)

/** Second/third click window (inclusive <): a click with the SAME target
 * within this many ms of the previous one counts as multi-click. */
export const MULTI_CLICK_TIMEOUT_MS = 300

/** "Copied!" toast coalescing window — repeated copies within this window show
 * ONE toast (drag/copy storms never spam). */
export const CLIPBOARD_TOAST_DEBOUNCE = 500

/** Context chip → usage panel debounce (a brief hover/click storm settles to a
 * single open). */
export const CONTEXT_CLICK_DEBOUNCE = 300

/** Selection flash highlight duration (state `selectionFlashUntil`, spec:
 * keep_text_selection=flash → the highlight flashes then the selection clears). */
export const DEFAULT_SELECTION_HIGHLIGHT_DURATION_MS = 150
