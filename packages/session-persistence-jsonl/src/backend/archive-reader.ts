import { createJournalStreamDecoder } from '@i-harness/core-session/internal/archive';
import type { FileHandle } from 'node:fs/promises';
import { validateConversationHistory, type SessionEvent } from '@i-harness/core-session';
import type { SessionMeta } from '@i-harness/session-persistence';
import { parseHeader } from '../format.ts';
const managed = (v: number) => [6, 7, 8, 9, 10, 11, 12, 13, 14].includes(v);
/** IO chunks are bounded; complete decoded events and the largest record remain materialized. */
export async function readSessionArchive(handle: FileHandle, extent: number, prefixOnly = false) {
    let header: SessionMeta | undefined, parts: Buffer[] = [], partBytes = 0, legacyStopped = false;
    const events: SessionEvent[] = [], birth: Buffer[] = [];
    let needed = 0, decoder: ReturnType<typeof createJournalStreamDecoder> | undefined;
    function add(bytes: Buffer) { if (bytes.length) {
        parts.push(Buffer.from(bytes));
        partBytes += bytes.length;
    } }
    function take() { const b = Buffer.concat(parts, partBytes); parts = []; partBytes = 0; return b; }
    function line(record: Buffer, lf: boolean) {
        if (!header) {
            header = parseHeader(record.subarray(0, lf ? record.length - 1 : record.length).toString('utf8'));
            if (header.semanticSeed) {
                birth.push(record);
                needed = header.semanticSeed.seedLength ? 2 : 1;
            }
            if (managed(header.formatVersion) && !prefixOnly)
                decoder = createJournalStreamDecoder(header.journal!, header.formatVersion, unit => { for (const event of unit)
                    events.push(event); });
            return;
        }
        if (needed > 0) {
            birth.push(record);
            if (!lf)
                throw Error('SESSION_BOOTSTRAP_INCOMPLETE');
            needed--;
        }
        if (prefixOnly)
            return;
        if (decoder)
            decoder.push(record);
        else if (!legacyStopped) {
            const text = record.toString('utf8');
            if (text.trim())
                try {
                    events.push(JSON.parse(text));
                }
                catch {
                    legacyStopped = true;
                }
        }
    }
    let position = 0;
    while (position < extent) {
        const buffer = Buffer.allocUnsafe(Math.min(65536, extent - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead)
            throw Error('Archive truncated during observation');
        position += bytesRead;
        const chunk = buffer.subarray(0, bytesRead);
        let start = 0;
        while (start < chunk.length) {
            const end = chunk.indexOf(10, start);
            if (end < 0) {
                add(chunk.subarray(start));
                break;
            }
            add(chunk.subarray(start, end + 1));
            line(take(), true);
            start = end + 1;
            if (prefixOnly && header && needed === 0)
                return { header, birth: Buffer.concat(birth), events };
        }
    }
    if (partBytes)
        line(take(), false);
    if (!header)
        throw Error('Empty archive');
    if (needed)
        throw Error('SESSION_BOOTSTRAP_INCOMPLETE');
    if (!prefixOnly) {
        decoder?.finish();
        if (managed(header.formatVersion) || events.some(e => e.type === 'compaction/replacement'))
            validateConversationHistory(events, header.formatVersion, header);
    }
    return { header, birth: Buffer.concat(birth), events };
}
