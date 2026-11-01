/** Request-local mutation witnesses. This registry never delays a writer. */
const originalMutations=new WeakMap<object,()=>void>()
export function assertOriginalProcessMutation(token:object){const check=originalMutations.get(token);if(!check)throw Error('Original mutation token required');check()}
export function createProcessReadLatches() {
    type Mutation = { sessionIds: readonly string[]; documentKeys: readonly string[]; kind: 'managed-append' | 'other'; managedOwner?: object };
    type Capture = { sessionId: string; documentKeys: readonly string[]; mode: 'cold' | 'managed'; managedOwner?: object };
    type Reader = { input: Capture; invalid: boolean; retired: boolean; verified: boolean };
    const readers = new Set<Reader>(), active = new Set<Mutation>();
    const poisonedSessions = new Set<string>(), poisonedDocuments = new Set<string>();
    let closed = false;
    const matches = (m: Mutation, r: Reader) => m.sessionIds.includes(r.input.sessionId) || m.documentKeys.some(key => r.input.documentKeys.includes(key));
    const compatible = (m: Mutation, r: Reader) => !r.verified && r.input.mode === 'managed' && !!r.input.managedOwner
        && m.kind === 'managed-append' && m.managedOwner === r.input.managedOwner
        && m.sessionIds.includes(r.input.sessionId) && !m.documentKeys.some(key => r.input.documentKeys.includes(key));
    const denied = () => { throw new Error('PROCESS_READ_UNAVAILABLE'); };
    return {
        assertUnpoisoned(sessionId: string, documentKeys: readonly string[]) {
            if (closed || poisonedSessions.has(sessionId) || documentKeys.some(key => poisonedDocuments.has(key))) denied();
        },
        beginMutation(input: Mutation) {
            const mutation: Mutation = { ...input, sessionIds: [...new Set(input.sessionIds)], documentKeys: [...new Set(input.documentKeys)] };
            active.add(mutation);
            for (const reader of readers) if (matches(mutation, reader) && !compatible(mutation, reader)) reader.invalid = true;
            let ended = false;
            const token = Object.freeze({ end(outcome: 'settled' | 'unknown') {
                if (this !== token) throw new TypeError('Invalid mutation token receiver');
                if (ended) throw new Error('Mutation token already ended');
                ended = true;
                active.delete(mutation);
                if (outcome === 'unknown') {
                    for (const id of mutation.sessionIds) poisonedSessions.add(id);
                    for (const key of mutation.documentKeys) poisonedDocuments.add(key);
                    for (const reader of readers) if (matches(mutation, reader)) reader.invalid = true;
                }
            } });
            originalMutations.set(token,()=>{if(ended||!active.has(mutation))throw Error('Mutation token unavailable')});return token;
        },
        capture(input: Capture) {
            const reader: Reader = { input: { ...input, documentKeys: [...new Set(input.documentKeys)] }, invalid: false, retired: false, verified: false };
            const assertCurrent = () => {
                if (closed || reader.invalid || reader.retired || poisonedSessions.has(reader.input.sessionId)
                    || reader.input.documentKeys.some(key => poisonedDocuments.has(key))
                    || [...active].some(m => matches(m, reader))) { reader.invalid = true; denied(); }
            };
            assertCurrent();
            readers.add(reader);
            const result = Object.freeze({ assertCurrent() { if (this !== result) throw new TypeError('Invalid read latch receiver'); assertCurrent(); },
                markVerified() { if (this !== result) throw new TypeError('Invalid read latch receiver'); assertCurrent(); reader.verified = true; },
                retire() { if (this !== result) throw new TypeError('Invalid read latch receiver'); reader.retired = true; readers.delete(reader); } });
            return result;
        },
        closeAdmission() { closed = true; for (const reader of readers) reader.invalid = true; },
    };
}
