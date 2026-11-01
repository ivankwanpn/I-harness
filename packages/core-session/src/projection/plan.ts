import type { SessionView as Session } from "../managed/types.ts"

export interface PlanModeView { active: boolean; proposal?: string; eventSeq?: number }

/** Latest-wins plan-mode projection (last-wins: an "off" resets). */
export function derivePlanMode(session: Session): PlanModeView {
  const index=createPlanModeIndex();index.stage(session.events).commit();return index.read()
}
/** Same latest-wins projection, staged by the original managed context fold. */
export function createPlanModeIndex(){
 let view:PlanModeView={active:false},revision=0
 return {read:()=>({...view}),releasePayloads(){view={active:view.active,...view.eventSeq!==undefined?{eventSeq:view.eventSeq}:{}}},stage(events:readonly import('../managed/types.ts').SessionEventView[]){
  const expected=revision;let next=view,installed=false
  for (const ev of events) {
    if (ev.type !== "plan/mode") continue
    next = {
      active: ev.mode === "on",
      ...(ev.proposal !== undefined ? { proposal: ev.proposal } : {}),
      eventSeq: ev.seq ?? 0,
    }
  }
  return {commit(){if(installed)return;if(revision!==expected)throw TypeError('Stale plan observation');view=next;revision++;installed=true}}
 }}
}
