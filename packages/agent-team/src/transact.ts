import type { TeamEvent } from "./types.ts";
import { applyTeamEvent, createFoldState, type TeamFoldState } from "./fold.ts";
export interface TeamLead {
    commit(events: readonly TeamEvent[]): Promise<void>;
    onCommit?(): void;
}
export interface TeamTransaction {
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
    const settle = async () => {
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
            await chain;
            try {
                await settle();
            }
            catch (error) {
                if ((error as {
                    code?: string;
                })?.code !== 'FACT_CANCELLED')
                    throw error;
            }
        },
        transact<T>(fn: (state: TeamFoldState) => {
            events?: TeamEvent[];
            result: T;
        }): Promise<T> {
            const next = chain.then(async () => {
                await settle();
                if (!shared)
                    shared = createFoldState();
                // fn runs against the throwaway clone, never the live state.
                const snapshot = cloneState(shared);
                const out = fn(snapshot);
                if (out.events && out.events.length > 0) {
                    // Validate every candidate in order (zod + invariants) against the
                    // snapshot, which accumulates the candidates as they validate (so
                    // [provisioning, active] chains correctly). A violation throws HERE,
                    // before anything reaches the live state or the log.
                    for (const e of out.events)
                        applyTeamEvent(snapshot, e);
                    // Keep the exact candidate through unknown. The next operation or
                    // owning source drain settles it before invoking another pure fn.
                    pending = out.events;
                    await settle();
                }
                return out.result;
            });
            chain = next.catch(() => { }); // a throw commits nothing new; chain survives
            return next;
        },
    };
}
