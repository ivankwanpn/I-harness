import { isManagedFactOwner, type FactReceipt, type ProducerFactOutcome } from '@i-harness/core-session';
import type { ChildAgentEntry } from '../agent-table.ts';
type Evidence = Readonly<{
    inputId: string;
    seq: number;
    disposition: {
        kind: 'committed';
        receipt: FactReceipt;
    } | {
        kind: 'memory';
        durability: 'nondurable';
    };
}>;
const evidence = new WeakMap<ChildAgentEntry, {
    fact: Evidence;
    view: ChildAgentEntry['session'];
    owner: ChildAgentEntry['factOwner'];
    sessionId: string | undefined;
}>();
/** Only publishChild records this historical admission, before publishing its
 * entry. It never confers current execution or liveness authority. */
export function retainInitialInput(entry: ChildAgentEntry, inputId: string, outcome: ProducerFactOutcome): void {
    if (outcome.kind !== 'committed' && outcome.kind !== 'memory-committed')
        throw new TypeError('Initial input requires its actual admission outcome');
    if (outcome.seqs.length !== 1)
        throw new TypeError('Initial input must name one admission');
    const fact: Evidence = Object.freeze({ inputId, seq: outcome.seqs[0]!, disposition: outcome.kind === 'committed' ? Object.freeze({ kind: 'committed', receipt: outcome.receipt }) : Object.freeze({ kind: 'memory', durability: 'nondurable' }) });
    evidence.set(entry, { fact, view: entry.session, owner: entry.factOwner, sessionId: entry.sessionId });
}
export function hasCommittedInitialInput(entry: ChildAgentEntry, sessionId: string): boolean {
    const stored = evidence.get(entry), fact = stored?.fact;
    if (!stored || !fact || stored.view !== entry.session || stored.owner !== entry.factOwner || stored.sessionId !== sessionId || entry.sessionId !== sessionId || !entry.factOwner || !isManagedFactOwner(entry.session, entry.factOwner) || fact.disposition.kind !== 'committed')
        return false;
    const { receipt } = fact.disposition, key = receipt.key, event = entry.session.events[fact.seq];
    return receipt.owner.sessionId === sessionId && fact.seq >= key.firstSeq && fact.seq < key.firstSeq + key.count && receipt.lastSeq === key.firstSeq + key.count - 1
        && fact.seq >= (entry.session.header?.seedLength ?? 0) && event?.type === 'agent/input/admitted' && event.seq === fact.seq && event.inputId === fact.inputId
        && event.intent === 'user' && event.provenance?.producer === 'subagent.initial' && event.provenance.kind === 'inherited';
}
