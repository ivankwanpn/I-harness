import { readArchiveHistoryPrefix } from '../archive-read-internal.ts';
import { restoreManagedConversation, installRestoredManagedConversation, type OriginalConversationRestorationSource, type PreparedConversationArchive } from '@i-harness/core-session/internal/restoration';
import { FactRecoveryRequiredError, type Session, type SessionView, type SessionEventView, type EncodedFactBatch, type FactReceipt, type JournalPrefix } from '@i-harness/core-session';
import type { Ownership } from './ownership.ts';
import type { PersistenceBackend } from './types.ts';
import type { ManagedEntry } from './bootstrap.ts';
import type { createTaskDocumentTransitions } from './task-document-transition.ts';
import type { ManagedRestoredContextRead } from '../restored-context-internal.ts';
import { captureManagedReadyObservation } from './managed-document.ts';
type History = {
    initial: SessionView;
    seedLength: number;
    assertCurrent(): Promise<void>;
    assertRoot(): Promise<void>;
};
type State = ReturnType<typeof installRestoredManagedConversation>;
/** Subordinate to the one original ManagedEntry, not a second document registry. */
export function createManagedRestoredRead(ports: {
    id: string;
    entry: ManagedEntry;
    backend: PersistenceBackend;
    ownership: Ownership;
    transitions: ReturnType<typeof createTaskDocumentTransitions>;
    loadOwned(id: string): Promise<{
        session: Session;
    }>;
    assertEntry(): void;
    closeEntry(): Promise<void>;
    onValidated():void;
}) {
    const identity = Object.freeze({}), metadataRevision = ports.entry.metadataRevision;
    let state: State | undefined, history: History | undefined, flight: Promise<unknown> | undefined, retired = false, writer = false, hasFailure = false, prefix: JournalPrefix | undefined;
    const checkEntry = () => {
        if (hasFailure || retired || ports.entry.revoked || ports.entry.metadataRevision !== metadataRevision || ports.entry.headerUnknown)
            throw new FactRecoveryRequiredError();
        ports.assertEntry();
    };
    const check = () => {
        checkEntry();
        ports.ownership.assertHeld(ports.id);
        if (!writer && ports.entry.document) {
            const original=captureManagedReadyObservation(ports.entry.document,ports.ownership);original.assertCurrent();
            if(prefix&&(original.prefix.eventCount!==prefix.eventCount||original.prefix.prefixDigest!==prefix.prefixDigest))throw new FactRecoveryRequiredError();
        }
    };
    const source: OriginalConversationRestorationSource = {
        get formatVersion() {
            if (formatVersion === undefined)
                throw new FactRecoveryRequiredError();
            return formatVersion;
        },
        get header() {
            return header;
        }, get prefix() {
            if (!prefix)
                throw new FactRecoveryRequiredError();
            return prefix;
        },
        assertCurrent: check,
        async consume(accept) {
            check();
            const current = history;
            if (!current)
                throw Error('CONVERSATION_PAYLOAD_NOT_PREPARED');
            const document = ports.entry.document;
            const original = document ? captureManagedReadyObservation(document,ports.ownership) : undefined;
            original?.assertCurrent();
            if(original && (original.prefix.eventCount!==prefix!.eventCount || original.prefix.prefixDigest!==prefix!.prefixDigest))throw new FactRecoveryRequiredError();
            // Existing live facts keep their original objects. The strong
            // historical proof is qualification, not replacement identity.
            const events = original?.events ?? current.initial.events;
            for (const event of events) {
                await accept([event]);
                check();
            }
        },
        async readEvent(index) {
            check();
            const current = history;
            if (!current)
                throw Error('CONVERSATION_PAYLOAD_NOT_PREPARED');
            const document = ports.entry.document;
            if (document) {
                const original = captureManagedReadyObservation(document, ports.ownership);
                original.assertCurrent();
                if (original.prefix.eventCount !== prefix!.eventCount || original.prefix.prefixDigest !== prefix!.prefixDigest)
                    throw new FactRecoveryRequiredError();
                const event = original.events[index];
                if (!event)
                    throw new FactRecoveryRequiredError();
                return event;
            }
            const event = current.initial.events[index];
            if (!event)
                throw new FactRecoveryRequiredError();
            return event;
        },
        // The original TaskTransition owns and joins HistoryProof IO. This adapter
        // owns no separate descriptor; qualification stays live through hydration.
        async settle() {
            if (history) {
                await history.assertCurrent();
                check();
            }
        },
        async close() {
            retired = true;
            history = undefined;
        },
        appendCommitted(batch, receipt) {
            check();
            if (!prefix || batch.key.firstSeq !== prefix.eventCount || batch.key.previousPrefixDigest !== prefix.prefixDigest || receipt.key.batchDigest !== batch.key.batchDigest)
                throw new FactRecoveryRequiredError();
            prefix = { eventCount: prefix.eventCount + batch.key.count, bodyBytes: prefix.bodyBytes + batch.bytes.length, prefixDigest: receipt.prefixDigest };
        },
    };
    let formatVersion: number | undefined, header: SessionView['header'];
    async function qualify(): Promise<void> {
        checkEntry();
        let transient: SessionView | undefined = ports.entry.document?.view;
        if (!transient)
            transient = (await ports.loadOwned(ports.id)).session;
        check();
        const qualified = await ports.transitions.existing<void | undefined>(ports.id, async (beforeRepair) => {
            const current = transient!;
            await beforeRepair(current.formatVersion, current.events, current.header?.seedLength ?? 0);
            transient = undefined;
        }, undefined, async (proof) => {
            history = proof;
            formatVersion = proof.initial.formatVersion;
            header = proof.initial.header;
            await proof.assertCurrent();check();
            const qualifiedPrefix=readArchiveHistoryPrefix(ports.backend,proof);
            if(qualifiedPrefix.kind!=='available')throw Object.assign(new Error('Qualified original history prefix unavailable'),{code:'CONVERSATION_RESTORATION_PREFIX_UNAVAILABLE'});
            prefix={...qualifiedPrefix.prefix};
            check();
            if (prefix.eventCount !== proof.initial.events.length)
                throw new FactRecoveryRequiredError();
            if (!state) {
                const candidate = await restoreManagedConversation(source, identity, ports.id);
                state = installRestoredManagedConversation(candidate, identity);
            }
            const prepared = await state.prepare();
            await prepared.settle();
            await proof.assertCurrent();
            check();
            ports.onValidated();
        });
        void qualified;
        history = undefined;
    }
    async function ensure() {
        checkEntry();
        if (state && !state.needsPreparation())
            return;
        if (flight) {
            await flight;
            check();
            return;
        }
        const current = qualify();
        flight = current;
        try {
            await current;
            check();
        }
        catch (error) {
            hasFailure = true;
            throw error;
        }
        finally {
            if (flight === current)
                flight = undefined;
            history = undefined;
        }
    }
    const read: ManagedRestoredContextRead = Object.freeze({
        identity, async prepare(): Promise<PreparedConversationArchive> {
            if (this !== read)
                throw new TypeError('Invalid restored document receiver');
            await ensure();
            check();
            return state!.prepare();
        }, async close() {
            if (this !== read)
                throw new TypeError('Invalid restored document receiver');
            await ports.closeEntry();
        }
    });
    return {
        read, ensure, stage(events: readonly SessionEventView[], readCurrentEvent: (index: number) => SessionEventView | undefined) {
            // A terminal read is not authority to cancel original required
            // writer settlement. Its leases already refuse publication.
            const terminal = () => hasFailure || retired || ports.entry.revoked || ports.entry.metadataRevision !== metadataRevision;
            if (terminal()) return { install() {} };
            check();
            writer = true;
            try {
                const staged = state!.stageAppend(events, readCurrentEvent);
                return {
                    install(batch: EncodedFactBatch, receipt: FactReceipt) {
                        if (terminal()) return;
                        writer = true;
                        try {
                            staged.install(batch, receipt);
                        }
                        finally {
                            writer = false;
                        }
                    }
                };
            }
            finally {
                writer = false;
            }
        }, async close() {
            retired = true;
            await flight?.catch(() => {
            });
            await state?.close();
            history = undefined;
            if (hasFailure)
                await ports.transitions.joinIO();
        }
    };
}
