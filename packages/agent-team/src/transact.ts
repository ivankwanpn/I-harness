import type { TeamEvent } from "./types.ts";
import { applyTeamEvent, createFoldState, type TeamFoldState } from "./fold.ts";
import { isDeepStrictEqual } from 'node:util';
export type Queued = Extract<TeamEvent, { type: 'team/message/queued' }>;
export type Ack = Extract<TeamEvent, { type: 'team/message/delivered' }>;
export type Failure = { occurred: false } | { occurred: true; error: unknown };
export type DeliveryOutcome = { kind: 'consumed'; via: 'target' | 'parent-stop'; sendFailure: Failure }
    | { kind: 'queued'; via: 'no-target-call' | 'bridge-false' | 'target-owned'; sendFailure: Failure };
export type MailboxResult = { messageId: string; status: 'accepted' | 'queued' };
export type QueueGuard = (clone: TeamFoldState) => void;
export type DeliveryRequest = { queued: Queued; mode: 'enqueue' | 'existing'; guard: QueueGuard; deliver: () => Promise<DeliveryOutcome> };
export type InstallAck = (write: () => Promise<void>, markInstalled: () => void) => Promise<void>;
export interface MessageObligation {
    readonly queueEvents: readonly [Queued];
    queue(): Promise<void>;
    queueInstalled(): void;
    start(deliver: () => Promise<DeliveryOutcome>): Promise<MailboxResult>;
    settle(): Promise<void>;
}
export interface TeamLead {
    beginCandidate?(): { capture(events: readonly TeamEvent[]): void; abandon(): void };
    commit(events: readonly TeamEvent[]): Promise<void>;
    onCommit?(): void;
    reserveMessage?(queued: Queued, mode: 'enqueue' | 'existing', installAck: InstallAck): MessageObligation;
    findMessage?(queued: Queued): MessageObligation | undefined;
    settleMessages?(): Promise<void>;
    messageFailed?(record: MessageObligation, error: unknown): void;
}
export interface TeamTransaction {
    deliverMessage(request: DeliveryRequest): Promise<MailboxResult>;
    transact<T>(fn: (state: TeamFoldState) => {
        events?: TeamEvent[];
        result: T;
    }): Promise<T>;
}
// Manual clone: applyTeamEvent mutates the queued arrays in place (push), so
// they must be deep-copied; member/task objects are replaced wholesale, never
// mutated in place. Cheap insurance vs structuredClone if state ever holds
// class instances.
function cloneState(state: TeamFoldState): TeamFoldState {
    return {
        members: new Map(state.members),
        tasks: new Map(state.tasks),
        queued: new Map([...state.queued].map(([k, list]) => [k, [...list]])),
        delivered: new Set(state.delivered),
        nextTaskNumber: state.nextTaskNumber,
    };
}
// Ruling 10 contract: the transact fn is PURE-READ — it inspects the state
// param and returns { events, result }; it NEVER mutates the state. The
// transact runs the fn against a CLONE, validates each candidate in order via
// applyTeamEvent against that clone, then applies the validated events to the
// live state, appends them to the log, and flushes. A misbehaving fn can only
// corrupt the throwaway clone — "invalid never enters state or log" holds by
// construction.
//
// `state` is optional and SHARED: pass the team's live folded state so external
// readers (listMembers/getTask/pendingCount) and the transact observe the same
// object; on restore the caller seeds it via foldTeam so replay validation sees
// prior events (no double-apply of a duplicate provisioning on restart).
export function createTeamTransact(lead: TeamLead, state?: TeamFoldState): TeamTransaction & {
    drain(): Promise<void>;
} {
    let chain: Promise<unknown> = Promise.resolve();
    let shared: TeamFoldState | undefined = state;
    let pending: readonly TeamEvent[] | undefined;
    let pendingMessage: MessageObligation | undefined;
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
        const next = chain.then(work);
        chain = next.catch(() => {});
        return next;
    };
    const settle = async () => {
        if (pendingMessage) {
            const record = pendingMessage;
            try { await record.queue(); }
            catch (error) {
                if ((error as { teamQueueNotIssued?: boolean })?.teamQueueNotIssued) pendingMessage = undefined;
                throw error;
            }
            for (const event of record.queueEvents) applyTeamEvent(shared!, event);
            record.queueInstalled();
            pendingMessage = undefined;
            lead.onCommit?.();
        }
        if (!pending)
            return;
        const events = pending;
        try {
            await lead.commit(events);
        }
        catch (error) {
            if ((error as {
                code?: string;
            })?.code === 'FACT_CANCELLED')
                pending = undefined;
            throw error;
        }
        for (const event of events)
            applyTeamEvent(shared!, event);
        pending = undefined;
        lead.onCommit?.();
    };
    return {
        async drain() {
            try {
                await serial(settle);
            }
            catch (error) {
                if ((error as {
                    code?: string;
                })?.code !== 'FACT_CANCELLED' && !(error as { teamQueueNotIssued?: boolean })?.teamQueueNotIssued)
                    throw error;
            }
            // Drivers can enter the ack lane. Never join them from within it.
            await lead.settleMessages?.();
            await serial(settle);
        },
        async deliverMessage(request) {
            if (!lead.reserveMessage) throw Object.assign(new Error('Team lead does not own message settlement'), { code: 'FACT_OWNER_UNSUPPORTED' });
            let reserved: MessageObligation | undefined;
            const record = await serial(async () => {
                // Exact original work joins before admission, capacity or delivered checks.
                const existing = lead.findMessage?.(request.queued);
                if (existing) return existing;
                await settle();
                if (!shared) shared = createFoldState();
                const sameId = [...shared.queued.values()].flat().find(message => message.id === request.queued.message.id);
                if (sameId && !isDeepStrictEqual(sameId, request.queued.message)) throw new Error('Team message tuple mismatch');
                if (sameId && shared.delivered.has(sameId.id)) return undefined;
                const snapshot = cloneState(shared);
                request.guard(snapshot);
                if (request.mode === 'enqueue') applyTeamEvent(snapshot, request.queued);
                const obligation = lead.reserveMessage!(request.queued, request.mode, (write, markInstalled) => serial(async () => {
                    const original = obligation.queueEvents[0];
                    const ack: Ack = { type: 'team/message/delivered', version: 1, teamId: original.teamId, messageId: original.message.id, targetId: original.message.targetId };
                    applyTeamEvent(cloneState(shared!), ack);
                    await write();
                    applyTeamEvent(shared!, ack);
                    markInstalled();
                    lead.onCommit?.();
                }));
                reserved = obligation;
                if (request.mode === 'enqueue') {
                    pendingMessage = obligation;
                    await settle();
                } else obligation.queueInstalled();
                return obligation;
            }).catch(error => { if (reserved) lead.messageFailed?.(reserved, error); throw error; });
            return record ? record.start(request.deliver) : { messageId: request.queued.message.id, status: 'accepted' };
        },
        transact<T>(fn: (state: TeamFoldState) => {
            events?: TeamEvent[];
            result: T;
        }): Promise<T> {
            return serial(async () => {
                await settle();
                const candidate = lead.beginCandidate?.();
                try {
                    if (!shared)
                        shared = createFoldState();
                    // No await separates admission from the pure callback,
                    // validation, original capture and pending installation.
                    const snapshot = cloneState(shared);
                    const out = fn(snapshot);
                    if (out.events && out.events.length > 0) {
                        // Validate all candidates against the throwaway clone.
                        for (const e of out.events)
                            applyTeamEvent(snapshot, e);
                        // Keep the exact captured candidate through unknown;
                        // the next operation/drain settles it without replay.
                        candidate?.capture(out.events);
                        pending = out.events;
                        await settle();
                    }
                    return out.result;
                } finally { candidate?.abandon(); }
            });
        },
    };
}
