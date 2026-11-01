import { readDeliveries } from './delivery.ts';
import { isDeliveryEventType } from '../events/delivery.ts';
import type { SessionView as Session } from "../managed/types.ts";
import type { ConversationProjection, ConversationCall } from "./types.ts";
import { conversationSources } from "./sources.ts";
import { conversationVisibility } from "./visibility.ts";
import { validateBootstrapReadiness } from './bootstrap-validation.ts';
export interface ConversationState {
    archive: {
        eventCount: number;
        lastSeq?: number;
    };
    branch: {
        sourceId: string;
        anchorSeq: number;
    }[];
    rewrites: {
        sourceId: string;
        type: string;
    }[];
    itemIds: string[];
    sourceIds: string[];
    pendingInputIds: string[];
    unsettledDelegationIds: string[];
    pending: {
        inputId: string;
        state: "admitted" | "promoted";
        sourceIds: string[];
    }[];
    effects?: {
        itemId: string;
        callId: string;
        outcome: ConversationCall["outcome"];
        sourceIds: string[];
    }[];
    turnSourceId?: string;
}
export type ConversationStateRead = {
    kind: "available";
    state: ConversationState;
} | {
    kind: "ambiguous";
    sourceIds: readonly string[];
};
/** Replay facts only: no claim, execution, scheduling or delivery authority. */
export function readConversationState(session: Session, projection: ConversationProjection): ConversationStateRead {
    validateBootstrapReadiness(session.events, session.formatVersion, session.header ?? {});
    const visibility = conversationVisibility(session);
    const sources = conversationSources(session, projection.ownerSessionId, []);
    const seedEnd = session.header?.parentSession === undefined && session.header?.semanticSeed === undefined ? 0 : session.header.seedLength ?? 0;
    return readStateFacts(session.events.map(stateFact), projection, visibility, sources, readDeliveries(session), seedEnd);
}
/** Structural input belongs to this original state owner, never SessionEvent. */
interface StateFact {
    type: import('../managed/types.ts').SessionEventView['type'];
    seq?: number;
    anchorSeq?: number;
    inputId?: string;
    input?: {
        inputId: string;
    };
    imageInputId?: string;
    taskId?: string;
    outcome?: string;
    key?: import('../events/delivery.ts').DeliveryKey;
    sourceSeq?: number;
    terminalSeq?: number;
    callSeq?: number;
    startSeq?: number;
    generationId?: string;
    kind?: string;
}
function stateFact(event: import('../managed/types.ts').SessionEventView): StateFact {
    const base: StateFact = { type: event.type, ...(event.seq === undefined ? {} : { seq: event.seq }) };
    if (event.type === 'rewind/point')
        return { ...base, anchorSeq: event.anchorSeq };
    if (['agent/input/admitted', 'agent/input/promoted', 'agent/input/cancelled'].includes(event.type))
        return { ...base, inputId: (event as Extract<import('../managed/types.ts').SessionEventView, {
                type: 'agent/input/admitted';
            }>).inputId };
    if (event.type === 'user/message')
        return { ...base, ...(event.input ? { input: { inputId: event.input.inputId } } : {}), ...(event.imageInputId === undefined ? {} : { imageInputId: event.imageInputId }) };
    if (event.type === 'subagent/start')
        return { ...base, taskId: event.taskId };
    if (event.type === 'subagent/end')
        return { ...base, taskId: event.taskId, outcome: event.outcome };
    if (event.type === 'agent/delivery-received')
        return { ...base, key: { ...event.key }, sourceSeq: event.sourceSeq, terminalSeq: event.terminalSeq };
    if (event.type === 'agent/delivery-source')
        return { ...base, generationId: event.generationId, kind: event.kind, callSeq: event.callSeq, ...(event.kind === 'subagent' ? { startSeq: event.startSeq } : {}) };
    return base;
}
function readStateFacts(facts: readonly StateFact[], projection: ConversationProjection, visibility: ReturnType<typeof conversationVisibility>, sources: Pick<ReturnType<typeof conversationSources>, 'ref'>, delivery: ReturnType<typeof readDeliveries>, seedEnd: number): ConversationStateRead {
    let turn: number | undefined;
    let physicalUnit: string | undefined;
    const pending = new Map<string, {
        inputId: string;
        state: "admitted" | "promoted";
        sourceIds: string[];
    }>();
    const consumed = new Set<string>(), delegations = new Map<string, string>();
    const delegationUnits = new Map<string, string>();
    const branch: ConversationState["branch"] = [], rewrites: ConversationState["rewrites"] = [];
    for (const [index, event] of facts.entries()) {
        if (!visibility.branch(event))
            continue;
        const sourceId = sources.ref(index, "event").id;
        if (event.type === "rewind/point")
            branch.push({ sourceId, anchorSeq: event.anchorSeq! });
        if (["rewind/point", "compaction/summary", "compaction/reset", "compaction/prune", 'compaction/replacement'].includes(event.type))
            rewrites.push({ sourceId, type: event.type });
        if (index < seedEnd)
            continue;
        if (event.type === 'step/start')
            physicalUnit = sources.ref(index, 'step').id;
        if (event.type === 'step/end' || event.type === 'step/failed' || event.type === 'turn/end')
            physicalUnit = undefined;
        // Both lifecycle boundaries survive compaction content hiding.
        if (event.type === "turn/start") {
            if (turn !== undefined)
                return { kind: "ambiguous", sourceIds: [sources.ref(turn, "event").id, sourceId] };
            turn = index;
        }
        else if (event.type === "turn/end") {
            if (turn === undefined)
                return { kind: "ambiguous", sourceIds: [sourceId] };
            turn = undefined;
        }
        else if (event.type === "agent/input/admitted")
            pending.set(event.inputId!, { inputId: event.inputId!, state: "admitted", sourceIds: [sources.ref(index, "admission").id] });
        else if (event.type === "agent/input/promoted") {
            const previous = pending.get(event.inputId!);
            pending.set(event.inputId!, { inputId: event.inputId!, state: "promoted", sourceIds: [...previous?.sourceIds ?? [], sourceId] });
        }
        else if (event.type === "agent/input/cancelled")
            pending.delete(event.inputId!);
        else if (event.type === "user/message") {
            const id = event.input?.inputId ?? event.imageInputId;
            if (id)
                consumed.add(id);
        }
        else if (event.type === "subagent/start") {
            delegations.set(event.taskId!, sourceId);
            if (physicalUnit)
                delegationUnits.set(event.taskId!, physicalUnit);
        }
        else if (event.type === "subagent/end" && event.outcome !== "recovery-required") {
            delegations.delete(event.taskId!);
            delegationUnits.delete(event.taskId!);
        }
    }
    for (const id of consumed)
        pending.delete(id);
    const effects = projection.items.flatMap(item => (item.exchange?.calls ?? []).filter(call => call.outcome === "unknown" || call.outcome === "pending")
        .map(call => ({ itemId: item.id, callId: call.callId, outcome: call.outcome, sourceIds: [call.call, call.dispatch, call.result].flatMap(source => source ? [source.id] : []) })));
    const unsettledItems = new Set(effects.map(effect => effect.itemId));
    const unsettledUnits = new Set(delegationUnits.values());
    const protectedItems = projection.items.filter(item => item.provenance.scope === "session" || item.kind === "input" && turn !== undefined && item.sources.some(source => source.eventIndex > turn!) || item.unit && (item.unit.state !== 'closed' || !item.unit.source.addressable || unsettledUnits.has(item.unit.source.id)) || item.exchange && item.exchange.state !== "closed" || unsettledItems.has(item.id));
    const itemIds = protectedItems.map(item => item.id);
    const sourceIds = [...new Set([...protectedItems.flatMap(item => [...item.sources, ...item.provenance.evidence, ...item.unit ? [item.unit.source] : []].map(source => source.id)), ...[...pending.values()].flatMap(input => input.sourceIds), ...delegations.values()])];
    const deliveryRefs = new Set<number>();
    const consumedDeliverySources = new Set(facts.flatMap(event => event.type === 'agent/delivery-received' && delivery.receipt(event.key!)?.disposition !== 'pending' ? [event.sourceSeq] : []));
    for (const event of facts) {
        if (isDeliveryEventType(event.type) && event.seq !== undefined)
            deliveryRefs.add(event.seq);
        if (event.type === 'agent/delivery-source' && event.generationId === delivery.activeGeneration()?.generationId && !consumedDeliverySources.has(event.seq!)) {
            deliveryRefs.add(event.callSeq!);
            if (event.kind === 'subagent')
                deliveryRefs.add(event.startSeq!);
        }
        if (event.type === 'agent/delivery-received' && delivery.receipt(event.key!)?.disposition === 'pending') {
            deliveryRefs.add(event.sourceSeq!);
            deliveryRefs.add(event.terminalSeq!);
            deliveryRefs.add(event.seq! + 1);
        }
    }
    for (const [index, event] of facts.entries())
        if (event.seq !== undefined && deliveryRefs.has(event.seq)) {
            const id = sources.ref(index, 'event').id;
            if (!sourceIds.includes(id))
                sourceIds.push(id);
        }
    const lastSeq = facts.at(-1)?.seq;
    return { kind: "available", state: {
            archive: { eventCount: facts.length, ...(lastSeq === undefined ? {} : { lastSeq }) }, branch, rewrites,
            itemIds, sourceIds, pendingInputIds: [...pending.keys()], unsettledDelegationIds: [...delegations.keys()], pending: [...pending.values()], effects,
            ...(turn === undefined ? {} : { turnSourceId: sources.ref(turn, "event").id }),
        } };
}
const stateViews = new WeakMap<object, {
    current(): boolean;
    facts: readonly StateFact[];
}>();
/** Its mutable structural fold never leaves the original constructor. */
export function createConversationStateIndex() {
    const facts: StateFact[] = [];
    let revision = 0;
    return {
        stage(events: readonly import('../managed/types.ts').SessionEventView[]) {
            const expected = revision, next = events.map(stateFact);
            let installed = false;
            return {
                commit() {
                    if (installed)
                        return;
                    if (revision !== expected)
                        throw new Error('Stale conversation state suffix');
                    for (const fact of next)
                        facts.push(fact);
                    revision++;
                    installed = true;
                }
            };
        },
        read(): object {
            const expected = revision, view = Object.freeze({});
            stateViews.set(view, { current: () => revision === expected, facts });
            return view;
        },
    };
}
export function readIndexedConversationState(view: object, projection: ConversationProjection, options: {
    visibility: ReturnType<typeof conversationVisibility>;
    sources: Pick<ReturnType<typeof conversationSources>, 'ref'>;
    delivery: ReturnType<typeof readDeliveries>;
    seedEnd: number;
}): ConversationStateRead {
    const original = stateViews.get(view);
    if (!original || !original.current())
        throw new TypeError('Invalid or stale conversation state fold');
    return readStateFacts(original.facts, projection, options.visibility, options.sources, options.delivery, options.seedEnd);
}
