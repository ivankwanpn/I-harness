import type { SessionView as Session } from "../managed/types.ts";
import { readManagedAssessmentEvents } from '../managed/committed-events.ts';
import { validContextEvent, type ContextRecoveryFacts, type RequestBudgetSnapshot } from "../events/context.ts";
import { isConversationBudget, type RequestBudgetSnapshotV2 } from '../events/admission.ts';
import {createPlanModeIndex} from './plan.ts';
import {changesContextProjection,createProjectionRewriteIndex} from './rewrite.ts';
import { stageProviderInput, type ProviderInputState } from './provider-input.ts';
export function deriveContextRecovery(session: Session, ownerSessionId: string, binding?: {
    providerId?: string;
    modelId: string;
    protocol: string;
}): ContextRecoveryFacts | undefined {
    const recoveries = new Map<string, ContextRecoveryFacts>();
    for (const event of readManagedAssessmentEvents(session) ?? session.events)
        if (event.type === "context/recovery" && event.ownerSessionId === ownerSessionId && validContextEvent(event)) {
            const previous = recoveries.get(event.recoveryId);
            const folded = previous
                ? { ...previous, ...event, retryConsumed: previous.retryConsumed === true || previous.state === "retry-started" || event.retryConsumed === true || event.state === "retry-started" }
                : event;
            // Keep the latest transition order when selecting among applicable lanes.
            recoveries.delete(event.recoveryId);
            recoveries.set(event.recoveryId, folded);
        }
    return selectRecovery(recoveries, binding);
}
export function deriveContextBudget(session: Session, ownerSessionId: string, select?: 'conversation'): RequestBudgetSnapshot | RequestBudgetSnapshotV2 | undefined {
    for (let index = session.events.length - 1; index >= 0; index--) {
        const event = session.events[index]!;
        if (event.type === "context/budget" && event.snapshot.ownerSessionId === ownerSessionId &&
            (select !== 'conversation' || isConversationBudget(event.snapshot)) && validContextEvent(event)) return event.snapshot;
    }
}
function selectRecovery(recoveries: ReadonlyMap<string, ContextRecoveryFacts>, binding?: {
    providerId?: string;
    modelId: string;
    protocol: string;
}): ContextRecoveryFacts | undefined {
    if (!binding)
        return [...recoveries.values()].at(-1);
    let current: ContextRecoveryFacts | undefined;
    const restriction = (facts: ContextRecoveryFacts) => facts.state === "resolved" ? 0 : facts.retryConsumed || facts.state === "retry-started" ? 2 : 1;
    for (const folded of recoveries.values()) {
        // Legacy facts lacking a model tuple remain conservative. Ambiguous edits
        // to settings of the same tuple cannot clear known provider rejection.
        if (folded.modelId && folded.protocol) {
            // Losing or discovering provider metadata is ambiguous for the same
            // model/protocol. Only two known unequal providers establish a change.
            const providerChanged = !!folded.providerId && !!binding.providerId && folded.providerId !== binding.providerId;
            if (folded.modelId !== binding.modelId || folded.protocol !== binding.protocol || providerChanged)
                continue;
        }
        // Unknown provider identity can make several concrete lanes applicable.
        // Preserve the strongest applicable restriction: consumed unresolved,
        // unconsumed unresolved, then resolved. Recency only breaks equal ranks.
        if (current && restriction(current) > restriction(folded))
            continue;
        current = folded;
    }
    return current;
}
/** Original incremental recovery/budget observation; no journal or send authority. */
export function createContextStateIndex(sessionId: string) {
    const recoveries = new Map<string, Map<string, ContextRecoveryFacts>>();
    const budgets = new Map<string, RequestBudgetSnapshot | RequestBudgetSnapshotV2>();
    let conversationBudget: RequestBudgetSnapshot | RequestBudgetSnapshotV2 | undefined;
    let conversationBudgetRewritten = false;
    let revision = 0;
    let providerInput: ProviderInputState = {};
    const plan=createPlanModeIndex(),rewrite=createProjectionRewriteIndex();
    let eventCount=0,prunes=0,contextRevision=0,scheduleRevision=0,sandbox:Readonly<{mode:Extract<import('../managed/types.ts').SessionEventView,{type:'sandbox/mode'}>['mode'];seq:number}>|undefined;
    return {
        stage(events: readonly import('../managed/types.ts').SessionEventView[]) {
            const expected = revision, changed = new Map<string, Map<string, ContextRecoveryFacts>>(), nextBudgets = new Map<string, RequestBudgetSnapshot | RequestBudgetSnapshotV2>();
            let nextConversationBudget = conversationBudget;
            let nextBudgetRewritten = conversationBudgetRewritten;
            const planStage=plan.stage(events),rewriteStage=rewrite.stage(events);let nextPrunes=prunes,nextContext=contextRevision,nextSchedule=scheduleRevision,nextSandbox=sandbox;
            const nextProviderInput = stageProviderInput(providerInput, events, sessionId);
            for (const [index,event] of events.entries()) {
                if (nextConversationBudget?.version === 2 && changesContextProjection(event)) nextBudgetRewritten = true;
                if(event.type==='compaction/prune')nextPrunes++;
                if(event.type==='context/usage'||event.type==='context/recovery')nextContext++;
                if(event.type==='schedule/change')nextSchedule++;
                if(event.type==='sandbox/mode'&&['read-only','workspace-write','danger-full-access'].includes(event.mode))nextSandbox=Object.freeze({mode:event.mode,seq:event.seq??eventCount+index});
                if (event.type === 'context/recovery' && validContextEvent(event)) {
                    let lane = changed.get(event.ownerSessionId);
                    if (!lane) {
                        lane = new Map(recoveries.get(event.ownerSessionId));
                        changed.set(event.ownerSessionId, lane);
                    }
                    const previous = lane.get(event.recoveryId);
                    const folded = previous ? { ...previous, ...event, retryConsumed: previous.retryConsumed === true || previous.state === 'retry-started' || event.retryConsumed === true || event.state === 'retry-started' } : { ...event };
                    lane.delete(event.recoveryId);
                    lane.set(event.recoveryId, folded);
                }
                if (event.type === 'context/budget' && validContextEvent(event)) {
                    const snapshot = structuredClone(event.snapshot);
                    nextBudgets.set(snapshot.ownerSessionId, snapshot);
                    if (snapshot.ownerSessionId === sessionId && isConversationBudget(snapshot)) {
                        nextConversationBudget = snapshot;
                        nextBudgetRewritten = false;
                    }
                }
            }
            let installed = false;
            return {
                commit() {
                    if (installed)
                        return;
                    if (revision !== expected)
                        throw new Error('Stale context state suffix');
                    planStage.commit();rewriteStage.commit();prunes=nextPrunes;contextRevision=nextContext;scheduleRevision=nextSchedule;sandbox=nextSandbox;eventCount+=events.length;
                    providerInput = nextProviderInput;
                    conversationBudget = nextConversationBudget;
                    conversationBudgetRewritten = nextBudgetRewritten;
                    for (const [owner, lane] of changed)
                        recoveries.set(owner, lane);
                    for (const [owner, budget] of nextBudgets)
                        budgets.set(owner, budget);
                    revision++;
                    installed = true;
                }
            };
        },
        plan:plan.read,rewrite:rewrite.read,
        releasePayloads(){plan.releasePayloads();providerInput={}},
        lastReportedInputTokens(select?: 'conversation'){return (select === 'conversation' ? providerInput.conversationReported : providerInput.reported)?.tokens},
        lastConversationUsage(budgetSeq?: number){
            const match = providerInput.conversationReported;
            return match && (budgetSeq === undefined || match.budgetSeq === budgetSeq) ? match.usage : undefined;
        },
        projectionRevision(){return rewrite.read().markers+prunes},
        conversationBudgetRewritten(){return conversationBudgetRewritten},
        contextRevision(){return contextRevision},scheduleRevision(){return scheduleRevision},
        sandboxMode(fromSeq=0){if(!Number.isSafeInteger(fromSeq)||fromSeq<0||fromSeq>eventCount)throw RangeError('Invalid original policy floor');return sandbox&&sandbox.seq>=fromSeq?sandbox.mode:undefined},
        sandboxPolicy(fromSeq=0){if(!Number.isSafeInteger(fromSeq)||fromSeq<0||fromSeq>eventCount)throw RangeError('Invalid original policy floor');return sandbox&&sandbox.seq>=fromSeq?sandbox:undefined},
        recovery(owner: string, binding?: {
            providerId?: string;
            modelId: string;
            protocol: string;
        }) {
            const value = selectRecovery(recoveries.get(owner) ?? new Map(), binding);
            return value && { ...value };
        },
        budget(owner: string, select?: 'conversation') {
            if (select === 'conversation' && owner !== sessionId) return undefined;
            const value = select === 'conversation' ? conversationBudget : budgets.get(owner);
            return value && structuredClone(value);
        },
    };
}
/** The snapshot is the exact selected event returned by deriveContextBudget. */
export function wasContextBudgetRewritten(events: Session['events'], budget: RequestBudgetSnapshotV2): boolean {
    let seenBudget = false, rewrites = 0;
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]!;
        if (event.type === 'context/budget' && event.snapshot === budget) seenBudget = true;
        if (changesContextProjection(event) && (!seenBudget || ++rewrites > budget.projectionRevision)) return true;
    }
    return false;
}
