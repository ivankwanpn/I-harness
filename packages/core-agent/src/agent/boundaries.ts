import type { SessionEvent } from '@i-harness/core-session';
import { modelFailureFacts } from '@i-harness/llm-seam';
import { agentFacts, committedFactSeqs } from './facts.ts';
import type { AgentDeps, TurnLifecycle } from './types.ts';
type Dependencies = Pick<AgentDeps, 'facts' | 'sourceFacts'> & {session?:AgentDeps['session']};
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
export function failStepBoundary(deps: Dependencies, lifecycle: TurnLifecycle, error?: unknown): Promise<void> {
    return lifecycle.stepFailure ??= (async () => {
        const facts = error === undefined ? undefined : modelFailureFacts(error);
        // Persist only the category and status. Provider bodies remain outside history.
        const failure = error === undefined ? undefined : {
            code: facts?.code ?? (error instanceof Error && error.name === 'AbortError' ? 'ABORTED' : 'UNKNOWN'),
            ...(facts?.httpStatus !== undefined ? { httpStatus: facts.httpStatus } : {}),
        };
        committedFactSeqs(await (deps.sourceFacts?.lifecycle ?? agentFacts(deps).agent).lifecycle({ type: 'step/failed', ...(failure ? { failure } : {}) }));
        lifecycle.stepFailed = true;
    })();
}
export function closeTurnBoundary(deps: Dependencies, lifecycle: TurnLifecycle): Promise<void> {
    return lifecycle.turnEnd ??= (async () => {
        committedFactSeqs(await (deps.sourceFacts?.lifecycle ?? agentFacts(deps).agent).lifecycle({ type: 'turn/end' }));
        lifecycle.turnOpen = false;
    })();
}
