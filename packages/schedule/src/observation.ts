import {isOriginalExecutionObservation, type ExecutionObservation, type ManagedExecutionIdentity} from '@i-harness/core-session/internal/execution'
import {createScheduleFoldSink, type FoldedSchedules} from './index.ts'

export type OwnedScheduleSnapshot = FoldedSchedules & {readonly inactive:readonly {readonly id:string;readonly state:'already-fired'|'already-deleted'}[]}
export interface OriginalScheduleSource {readonly identity:ManagedExecutionIdentity; observe():ExecutionObservation}
const validate = createScheduleFoldSink({seedLength:0}).validateSnapshot
export function readOriginalSchedules(source:OriginalScheduleSource): {snapshot:OwnedScheduleSnapshot;assertCurrent():void} {
 const observation=source.observe()
 if (!isOriginalExecutionObservation(observation) || observation.identity!==source.identity) throw TypeError('Original same-owner schedule observation required')
 observation.assertCurrent()
 if (observation.schedules.kind!=='available' || !validate(observation.schedules.snapshot)) throw TypeError('Original schedule observation unavailable')
 observation.assertCurrent()
 return {snapshot:observation.schedules.snapshot as OwnedScheduleSnapshot,assertCurrent:()=>observation.assertCurrent()}
}
