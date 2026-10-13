import type { Session } from "../events/types.ts"

export interface PlanModeView { active: boolean; proposal?: string; eventSeq?: number }

/** Latest-wins plan-mode projection (last-wins: an "off" resets). */
export function derivePlanMode(session: Session): PlanModeView {
  let view: PlanModeView = { active: false }
  for (const ev of session.events) {
    if (ev.type !== "plan/mode") continue
    view = {
      active: ev.mode === "on",
      ...(ev.proposal !== undefined ? { proposal: ev.proposal } : {}),
      eventSeq: ev.seq ?? 0,
    }
  }
  return view
}
