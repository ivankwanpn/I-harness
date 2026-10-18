import type { SessionEvent } from '@i-harness/core-session';
import { agentFacts, committedFactSeqs } from './facts.ts';
import type { AgentDeps, TurnLifecycle } from './types.ts';
type Dependencies = Pick<AgentDeps, 'session' | 'facts' | 'sourceFacts'>;
export function openStepBoundary(lifecycle: TurnLifecycle): void {
    lifecycle.stepOpen = true;
    lifecycle.providerCompleted = false;
    lifecycle.stepFailed = false;
    lifecycle.stepEnd = undefined;
    lifecycle.stepFailure = undefined;
}
/** One identity per actual boundary preserves its first completion payload
 * when a failed save later passes through failTurn. */
export function closeStepBoundary(deps: Dependencies, lifecycle: TurnLifecycle, event: Extract<SessionEvent, {
    type: 'step/end';
}>): Promise<void> {
    return lifecycle.stepEnd ??= (async () => {
        committedFactSeqs(await (deps.sourceFacts?.lifecycle ?? agentFacts(deps).agent).lifecycle(event));
        lifecycle.stepOpen = false;
    })();
}
export function failStepBoundary(deps: Dependencies, lifecycle: TurnLifecycle): Promise<void> {
    return lifecycle.stepFailure ??= (async () => {
        committedFactSeqs(await (deps.sourceFacts?.lifecycle ?? agentFacts(deps).agent).lifecycle({ type: 'step/failed' }));
        lifecycle.stepFailed = true;
    })();
}
export function closeTurnBoundary(deps: Dependencies, lifecycle: TurnLifecycle): Promise<void> {
    return lifecycle.turnEnd ??= (async () => {
        committedFactSeqs(await (deps.sourceFacts?.lifecycle ?? agentFacts(deps).agent).lifecycle({ type: 'turn/end' }));
        lifecycle.turnOpen = false;
    })();
}
