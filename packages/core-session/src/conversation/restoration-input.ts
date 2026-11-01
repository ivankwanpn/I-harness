import type { SessionEventView, SessionView, EncodedFactBatch, FactReceipt, JournalPrefix } from '../managed/types.ts';
/** Installed only by original storage/document construction. This read source
 * is not a receipt, HeldFactOwner, HistoryProof or a public Session. */
export interface OriginalConversationRestorationSource {
    readonly formatVersion: number;
    readonly header?: SessionView['header'];
    readonly prefix: Readonly<JournalPrefix>;
    assertCurrent(): void;
    consume(accept: (unit: readonly SessionEventView[]) => Promise<void>): Promise<void>;
    readEvent(ordinal: number): Promise<SessionEventView>;
    settle(): Promise<void>;
    close(): Promise<void>;
    appendCommitted(batch: EncodedFactBatch, receipt: FactReceipt): void;
}
