// @i-harness/tui — G4 (M37b): the G1↔G2 binder (overlay-seam adapters).
//
// G2's seam (present.ts OverlaySeam) draws overlays GENERICALLY —
//   draw(ctx, view, palette, glyphs) with ctx = the PROMPT-SLOT rect
//   act?(action: AppAction) — AppAction strings from the app keymap.
// G1's renderers have their OWN signatures (surf+state / q+state / state).
// These binders are the signature adapters: they close over the G1 state
// and render it into the seam's draw slot, and translate the app's
// AppAction vocabulary back onto the G1 interactive semantics.
//
// Adapter contract (what the loop's actions mean on a G1 overlay):
//   - { type: "overlay-accept", index }  → G1 select. The app keymap ships the
//     digit 1-BASED (keys.ts: index = Number(ev.key)); G1 rows are 0-based —
//     the accept adapters translate index-1 (permission 1-9 / question 1-9
//     (a-f is an unhandled loop gap) / cancel-turn 1-4).
//   - "overlay-select"     → Enter — select-at-cursor (permission/cancel) or
//     submit (question).
//   - "overlay-nav-prev" / "overlay-nav-next" → G1 cursor -1/+1 (Up/Down).
//   - "overlay-dismiss"    → Esc — close WITHOUT a decision (a permission/
//     question left unanswered is the backend's fail-closed path; the host
//     clears the surface — onClose).
//   - "overlay-range-left" / "overlay-range-right" → permission scope cycling.
//   - "overlay-question-prev" / "overlay-question-next" → question page -/+1.
//   - "overlay-tab"        → question freeform-focus toggle (best effort).
//
// DECISIONS: the interaction seam is boolean-only (approval.ts DECISION_MAP
// parity) — G1's Always/Never/Once/Reject verdicts map to { approved } HERE
// and are recorded via the bind options (onDecision) + onClose so the host
// (or a future production wiring) owns the answer/clear lifecycle. The
// binder closes the overlay itself ONLY through onClose — the host does
// `app.state().overlay = undefined` there (the binders never touch the app).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { RewindMode, RewindResult } from "@i-harness/rewind"
import type { BackendClient } from "../contracts.ts"
import type { AppAction } from "./keys.ts"
import type { OverlayFreeform, OverlaySeam } from "./present.ts"
import type { Rect, ViewDraw } from "../views/agent.ts"
import type { PermissionSurface, PermissionState } from "../views/permission.ts"
import { renderPermission } from "../views/permission.ts"
import type { QuestionQuestion, QuestionState } from "../views/question.ts"
import { renderQuestion } from "../views/question.ts"
import type { CancelTurnState } from "../views/cancel-turn.ts"
import { CANCEL_OPTIONS, renderCancelTurn } from "../views/cancel-turn.ts"
import type { RewindState } from "../views/rewind.ts"
import { filesDisabled, renderRewind } from "../views/rewind.ts"

// ------------------------------------------------------------------ share

/** Render the seam: the ctx handed in by present() IS the prompt-slot rect
 * (the G1 renderers target the prompt slot per spec §2.1 precedence). */
type SeamDraw = (ctx: Rect, view: ViewDraw, palette: Palette, glyphs: GlyphSet) => void

export type SeamKind = OverlaySeam["kind"]

/** Baseline OverlaySeam composition helper (a binder's output shape). */
export function overlaySeam(
  kind: SeamKind,
  draw: SeamDraw,
  act?: (action: AppAction) => void,
  freeform?: OverlayFreeform,
): OverlaySeam {
  return { kind, draw, ...(act === undefined ? {} : { act }), ...(freeform === undefined ? {} : { freeform }) }
}

// ------------------------------------------------------------------ permission

export type PermissionVerdict = "always" | "never" | "once" | "reject"

export interface PermissionDecision {
  surfaceId: string
  verdict: PermissionVerdict
  /** Seam parity: always/once → true; never/reject → false (DECISION_MAP). */
  approved: boolean
  /** 0-based option row that produced the verdict. */
  index: number
  /** Scope label at the time of the decision (Always/Never row only). */
  scope?: string
  /** RejectOnce typed feedback (verdict "reject" only). */
  feedback?: string
}

export interface PermissionBindOptions {
  /** The host records the verdict (answerApproval / answered marker…). */
  onDecision?: (d: PermissionDecision) => void
  /** The host clears the surface (sets app.state().overlay = undefined). */
  onClose?: () => void
}

/** G1 permission rows: 0 always / 1 never / 2 yes-once / 3 no-once / 4 reject
 * (only when freeform). Mirrors permission.ts row order; row select keeps the
 * same boundary logic (the app never selects the absent row 5). */
function permissionRowCount(surf: PermissionSurface): number {
  return surf.freeform ? 5 : 4
}

function permissionVerdictOf(index: number): { verdict: PermissionVerdict; approved: boolean } {
  switch (index) {
    case 0: return { verdict: "always", approved: true }
    case 1: return { verdict: "never", approved: false }
    case 3: return { verdict: "once", approved: true } // No, I trust it — same boolean
    case 2: return { verdict: "once", approved: true } // Yes, proceed
    default: return { verdict: "reject", approved: false } // 4 — No, reject
  }
}

/** Binder: draw adapter (renderPermission → seam draw) + act (AppAction →
 * permission selection/scope/cursor semantics). `state` is mutated in place,
 * so the host owns the authoritative copy (it reads scrollback-mirror… no —
 * it re-reads `state` for the decision record). */
export function bindPermissionOverlay(
  surf: PermissionSurface,
  state: PermissionState,
  opts: PermissionBindOptions = {},
): OverlaySeam {
  const close = (): void => opts.onClose?.()

  const decide = (index: number): void => {
    const n = permissionRowCount(surf)
    if (index < 0 || index >= n) return // guard (digits on a 4-row surface)
    const v = permissionVerdictOf(index)
    const scopeIdx = surf.scopes.length > 0 ? state.scopeIndex % surf.scopes.length : -1
    opts.onDecision?.({
      surfaceId: surf.id,
      verdict: v.verdict,
      approved: v.approved,
      index,
      ...(scopeIdx >= 0 ? { scope: surf.scopes[scopeIdx]! } : {}),
      ...(index === 4 ? { feedback: state.freeformText } : {}),
    })
    close()
  }

  // M39 wheel close: freeform capture — the reject row (last row when
  // surf.freeform) is the input slider; chars go to state.freeformText, the
  // carrier reaches the decision as `feedback` (see decide()).
  const freeformRow = surf.freeform ? permissionRowCount(surf) - 1 : -1

  return overlaySeam("permission", (ctx, view, palette, glyphs) => {
    renderPermission(ctx, surf, state, view, palette, glyphs)
  }, (action: AppAction) => {
    if (typeof action !== "string") {
      // The app keymap ships digit-accept 1-BASED (keys.ts overlayKeys:
      // index = Number(key)) — G1 rows are 0-based: adapt index-1.
      if (action.type === "overlay-accept") decide(action.index - 1)
      return
    }
    const n = permissionRowCount(surf)
    switch (action) {
      case "overlay-select": decide(state.cursor); break
      case "overlay-nav-prev": state.cursor = Math.max(0, state.cursor - 1); break
      case "overlay-nav-next": state.cursor = Math.min(n - 1, state.cursor + 1); break
      case "overlay-range-left":
        if (surf.scopes.length > 0) state.scopeIndex = (state.scopeIndex + surf.scopes.length - 1) % surf.scopes.length
        break
      case "overlay-range-right":
        if (surf.scopes.length > 0) state.scopeIndex = (state.scopeIndex + 1) % surf.scopes.length
        break
      case "overlay-dismiss": // Esc/Ctrl-C — unanswered → fail-closed backend side
        close()
        break
      default: break // overlay-copy/expand/collapse/toggle: M38 chrome
    }
  }, freeformRow >= 0 ? {
    active: () => state.cursor === freeformRow,
    append: (t: string) => { state.freeformText += t },
    backspace: () => { state.freeformText = state.freeformText.slice(0, -1) },
    submit: () => decide(freeformRow), // decide() carries feedback
    abort: () => close(),
  } : undefined)
}

// ------------------------------------------------------------------ question

export type QuestionMode = "option" | "freeform"

export interface QuestionDecision {
  questionId: string
  mode: QuestionMode
  /** Option that produced the answer (mode "option" only). */
  index?: number
  /** The answered string — option label, or the typed freeform text. */
  value: string
}

export interface QuestionBindOptions {
  onDecision?: (d: QuestionDecision) => void
  onClose?: () => void
}

/** Binder: draw adapter (renderQuestion → seam draw) + act (AppAction →
 * choose/nav/freeform/submit). Multi-select answers join with ","; the
 * interaction seam answers a single string (single-select parity). */
export function bindQuestionOverlay(
  q: QuestionQuestion,
  state: QuestionState,
  opts: QuestionBindOptions = {},
): OverlaySeam {
  const close = (): void => opts.onClose?.()

  const answer = (mode: QuestionMode, index?: number, value?: string): void => {
    opts.onDecision?.({
      questionId: q.id,
      mode,
      ...(mode === "option" ? { index } : {}),
      value: value ?? "",
    })
    close()
  }

  const chosenValue = (): string | undefined => {
    if (state.freeformFocused) return state.freeformText
    const opt = q.options[state.cursor]
    return opt === undefined ? undefined : opt.label
  }

  return overlaySeam("question", (ctx, view, palette, glyphs) => {
    renderQuestion(ctx, q, state, view, palette, glyphs)
  }, (action: AppAction) => {
    if (typeof action !== "string") {
      // keymap ships digit-accept 1-based (keys.ts overlayKeys) — rows are 0-based
      if (action.type !== "overlay-accept") return
      const i = action.index - 1
      const opt = q.options[i]
      if (opt === undefined) return
      if (q.multi) {
        const sel = new Set(state.selected)
        if (sel.has(opt.key)) sel.delete(opt.key)
        else sel.add(opt.key)
        state.selected = [...sel]
        state.cursor = i
      } else {
        state.selected = [opt.key]
        state.cursor = i
        answer("option", i, opt.label) // single-select quick-picks: answer now
      }
      return
    }
    switch (action) {
      case "overlay-select": {
        const v = chosenValue()
        if (v !== undefined) answer(state.freeformFocused ? "freeform" : "option", state.cursor, v)
        break
      }
      case "overlay-nav-prev": state.cursor = Math.max(0, state.cursor - 1); break
      case "overlay-nav-next":
        state.cursor = Math.min(Math.max(0, q.options.length - 1), state.cursor + 1)
        break
      case "overlay-tab": {
        // Freeform focus toggle (spec §3.8 Tab) — best effort on the loop's
        // overlay-tab (digit/tab extras land M38).
        if (q.freeform) state.freeformFocused = !state.freeformFocused
        break
      }
      case "overlay-question-prev": state.page = Math.max(1, state.page - 1); break
      case "overlay-question-next": state.page = Math.min(Math.max(1, state.pages), state.page + 1); break
      case "overlay-dismiss": close(); break // Esc back — no answer (host's question REJECTS on timeout)
      default: break // overlay-copy (y): toast is the loop's; M38 clipboard
    }
  }, q.freeform ? {
    active: () => state.freeformFocused,
    append: (t: string) => { state.freeformText += t },
    backspace: () => { state.freeformText = state.freeformText.slice(0, -1) },
    submit: () => answer("freeform", undefined, state.freeformText),
    abort: () => { state.freeformFocused = false },
  } : undefined)
}

// ------------------------------------------------------------------ cancel-turn

export interface CancelTurnDecision {
  index: number
  label: (typeof CANCEL_OPTIONS)[number]
}

export interface CancelTurnBindOptions {
  onDecision?: (d: CancelTurnDecision) => void
  onClose?: () => void
}

/** Binder: draw adapter (renderCancelTurn → seam draw) + act (AppAction →
 * label/accept semantics). Enter confirms at cursor; Esc keeps running
 * (onClose only — the host owns the stop/keep record). */
export function bindCancelTurnOverlay(
  state: CancelTurnState,
  opts: CancelTurnBindOptions = {},
): OverlaySeam {
  const close = (): void => opts.onClose?.()

  return overlaySeam("cancel-turn", (ctx, view, palette, glyphs) => {
    renderCancelTurn(ctx, state, view, palette, glyphs)
  }, (action: AppAction) => {
    if (typeof action !== "string") {
      // keymap ships digit-accept 1-based (keys.ts overlayKeys) — rows are 0-based
      if (action.type === "overlay-accept") {
        const i = Math.max(0, Math.min(CANCEL_OPTIONS.length - 1, action.index - 1))
        state.cursor = i
      }
      return
    }
    switch (action) {
      case "overlay-select":
        opts.onDecision?.({ index: state.cursor, label: CANCEL_OPTIONS[state.cursor]! })
        close()
        break
      case "overlay-nav-prev": state.cursor = Math.max(0, state.cursor - 1); break
      case "overlay-nav-next": state.cursor = Math.min(CANCEL_OPTIONS.length - 1, state.cursor + 1); break
      case "overlay-dismiss": close(); break // Esc — keep running (the host records)
      default: break
    }
  })
}

// ------------------------------------------------------------------ rewind (M43)

export interface RewindDecision {
  target: number
  mode: RewindMode
  result: RewindResult
}

export interface RewindBindOptions {
  /** The backend whose rewind member drives points/plan/execute + the
   * running-status probe (cancel-offer) + cancel() (the offered stop). */
  backend: BackendClient
  /** The host records the executed decision ({target, mode, result}). */
  onDecision?: (d: RewindDecision) => void
  /** The host clears the surface (app.state().overlay = undefined). */
  onClose?: () => void
}

/** Runtime probe: the rewind seam's kind string. The OverlaySeam.kind union
 * in present.ts is a G2-owned closed set ("permission"|"question"|
 * "cancel-turn") — the "rewind" kind is added at runtime here WITHOUT touching
 * present.ts; the loop/keys branch on this probe (and overlayState()'s kind
 * string, which flows to keys.ts OverlayKind "rewind"). */
export function isRewindOverlay(ov: OverlaySeam): boolean {
  return (ov as { kind: string }).kind === "rewind"
}

/**
 * Binder: THE rewind phase machine (spec §3.9) over backend.rewind —
 *
 *   loading --points()--> picker --accept--> [status().running? cancel-offer :
 *   mode-select] --y(cancel+mode)/n(close)--> mode-select --a/b/f-->
 *   planning --plan()--> confirm --y--> executing --execute()--> decision+close
 *
 * Errors from every async hop land in phase "error" ("Rewind failed" + msg +
 * Esc Dismiss). The binder kicks points() on bind (the host never preloads);
 * it owns NO app state — `state` is mutated in place and onClose is the only
 * way the overlay leaves the app (permission-binder parity).
 */
export function bindRewindOverlay(
  state: RewindState,
  opts: RewindBindOptions,
): OverlaySeam {
  const close = (): void => opts.onClose?.()
  const rw = opts.backend.rewind

  const dumpError = (error: unknown): void => {
    state.error = error instanceof Error ? error.message : String(error)
    state.phase = "error"
  }

  const loadPoints = (): void => {
    state.phase = "loading"
    if (rw === undefined) {
      dumpError("rewind is not enabled on this backend")
      return
    }
    void rw.points().then(
      (points) => {
        state.points = points
        state.cursor = Math.max(0, Math.min(state.cursor, Math.max(0, points.length - 1)))
        state.phase = "picker"
      },
      (error: unknown) => dumpError(error),
    )
  }
  loadPoints()

  const rowCountOfPhase = (): number => {
    switch (state.phase) {
      case "picker": return state.points.length
      case "cancel-offer": return 2
      case "mode-select": return filesDisabled(state) ? 2 : 3
      case "confirm": return 2
      default: return 0
    }
  }

  const nav = (delta: -1 | 1): void => {
    const n = rowCountOfPhase()
    if (n <= 0) return
    state.cursor = Math.max(0, Math.min(n - 1, state.cursor + delta))
  }

  const cursorBackToPicked = (): void => {
    let i = state.points.findIndex((p) => p.turnIndex === state.selectedTurn)
    if (i < 0) i = 0
    state.cursor = i
  }

  const cancelOfferY = (): void => {
    if (state.phase !== "cancel-offer") return
    // "Cancel turn and rewind" — the turn abort is fire-and-forget (the
    // backend's cancellation contract); the flow proceeds to the mode select.
    void opts.backend.cancel().catch(() => {})
    state.cursor = 0
    state.phase = "mode-select"
    state.cancelOfferTarget = undefined
  }

  const cancelOfferN = (): void => {
    if (state.phase !== "cancel-offer") return
    // "Let it finish" — the rewind flow ends here; the turn keeps running and
    // a later Esc-Esc re-invokes the picker.
    close()
  }

  const chooseMode = (mode: RewindMode): void => {
    if (state.phase !== "mode-select" || state.selectedTurn === undefined) return
    if (mode === "files" && filesDisabled(state)) return // f disabled (○)
    if (rw === undefined) {
      dumpError("rewind is not enabled on this backend")
      return
    }
    const target = state.selectedTurn
    state.mode = mode
    state.cursor = mode === "all" ? 0 : mode === "conversation" ? 1 : 2
    // plan() BEFORE the confirm (§3.9: Previewing file changes... → Confirm).
    state.phase = "planning"
    void rw.plan(target, mode).then(
      (plan) => {
        state.cleanPaths = plan.clean.map((op) => op.path)
        state.conflicts = plan.conflicts
        state.cursor = 0
        state.phase = "confirm"
      },
      (error: unknown) => dumpError(error),
    )
  }

  const confirmY = (): void => {
    if (state.phase !== "confirm" || state.selectedTurn === undefined || state.mode === undefined) return
    if (rw === undefined) {
      dumpError("rewind is not enabled on this backend")
      return
    }
    const target = state.selectedTurn
    const mode = state.mode
    state.cursor = 0
    state.phase = "executing"
    void rw.execute(target, mode).then(
      (result) => {
        state.cursor = 0
        opts.onDecision?.({ target, mode, result })
        close()
      },
      (error: unknown) => dumpError(error),
    )
  }

  const back = (): void => {
    switch (state.phase) {
      case "confirm": // Bksp Back → mode select (mode may change)
        state.phase = "mode-select"
        state.cursor = state.mode === "conversation" ? 1 : state.mode === "files" ? 2 : 0
        break
      case "mode-select": // Back → picker
        state.phase = "picker"
        cursorBackToPicked()
        break
      default: break
    }
  }

  const accept = (): void => {
    switch (state.phase) {
      case "picker": {
        const p = state.points[state.cursor]
        if (p === undefined) return
        state.selectedTurn = p.turnIndex
        state.cancelOfferTarget = p.turnIndex
        state.cursor = 0
        // §3.9: a running turn gets the cancel offer first.
        state.phase = opts.backend.status().running ? "cancel-offer" : "mode-select"
        break
      }
      case "cancel-offer": cancelOfferY(); break // Enter = y
      case "mode-select": {
        const mode = state.cursor === 0 ? "all" : state.cursor === 1 ? "conversation" : "files"
        chooseMode(mode)
        break
      }
      case "confirm": confirmY(); break // Enter = y
      default: break
    }
  }

  return {
    // present.ts's kind union is closed (G2-owned); the runtime string is the
    // dispatch key — see isRewindOverlay + keys.ts OverlayKind "rewind".
    kind: "rewind" as unknown as OverlaySeam["kind"],
    draw: (ctx, view, palette, glyphs) => renderRewind(ctx, state, view, palette, glyphs),
    act: (action: AppAction) => {
      if (typeof action !== "string") return // digits: rewind has no digit rows
      switch (action) {
        case "overlay-select": accept(); break
        case "overlay-nav-prev": nav(-1); break
        case "overlay-nav-next": nav(1); break
        case "overlay-dismiss":
          // Esc during "Rewinding..." is a NO-OP — the destructive execute is
          // in flight; the decision (or error phase) is the exit.
          if (state.phase !== "executing") close()
          break
        case "rewind-y":
          if (state.phase === "cancel-offer") cancelOfferY()
          else if (state.phase === "confirm") confirmY()
          break
        case "rewind-n": cancelOfferN(); break
        case "rewind-a": chooseMode("all"); break
        case "rewind-b": chooseMode("conversation"); break
        case "rewind-f": chooseMode("files"); break
        case "rewind-back": back(); break
        default: break
      }
    },
  }
}
