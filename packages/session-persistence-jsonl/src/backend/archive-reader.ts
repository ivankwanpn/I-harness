import { createJournalStreamDecoder } from '@i-harness/core-session/internal/archive';
import type { FileHandle } from 'node:fs/promises';
import { validateConversationHistory, type SessionEvent, type JournalPrefix } from '@i-harness/core-session';
import type { SessionMeta } from '@i-harness/session-persistence';
import { parseHeader } from '../format.ts';
const managed = (v: number) => [6, 7, 8, 9, 10, 11, 12, 13, 14].includes(v);
type ArchivePrefix = { header: SessionMeta; birth: Buffer };
const incompleteBirth = () => Object.assign(new Error('bootstrap-incomplete'), { code: 'SESSION_BOOTSTRAP_INCOMPLETE' });
/** IO chunks are bounded; complete decoded events and the largest record remain materialized. */
export async function readSessionArchive(handle: FileHandle, extent: number, prefixOnly = false, qualifyPrefix?: (prefix: ArchivePrefix) => Promise<void>, dependency?: { ordinal:number; prefix:Readonly<JournalPrefix>; assertCurrent():void }) {
    let header: SessionMeta | undefined, parts: Buffer[] = [], partBytes = 0, legacyStopped = false;
    const events: SessionEvent[] = [], birth: Buffer[] = [];
    let needed = 0, ordinal = 0, decoder: ReturnType<typeof createJournalStreamDecoder> | undefined;
    function add(bytes: Buffer) { if (bytes.length) { parts.push(Buffer.from(bytes)); partBytes += bytes.length; } }
    function take() { const b = Buffer.concat(parts, partBytes); parts = []; partBytes = 0; return b; }
    function consume(record: Buffer) {
        if (decoder) decoder.push(record);
        else if (!legacyStopped) {
            const text = record.toString('utf8');
            if (text.trim()) try { events.push(JSON.parse(text)); } catch { legacyStopped = true; }
        }
    }
    async function line(record: Buffer, lf: boolean) {
        if (!header) {
            header = parseHeader(record.subarray(0, lf ? record.length - 1 : record.length).toString('utf8'));
            // Ordinary headers still belong to the prefix: the bootstrap owner
            // needs their original bytes to classify a stray namespace.
            birth.push(record);
            if(dependency&&!managed(header.formatVersion))throw Error('Owned dependency format unsupported');
            if (header.semanticSeed) needed = header.semanticSeed.seedLength ? 2 : 1;
            if (managed(header.formatVersion) && !prefixOnly)
                decoder = createJournalStreamDecoder(header.journal!, header.formatVersion, unit => { for (const event of unit) {if(!dependency||ordinal===dependency.ordinal)events.push(event);ordinal++;} });
            if (!needed && !prefixOnly) await qualifyPrefix?.({ header, birth: Buffer.concat(birth) });
            return;
        }
        if (needed > 0) {
            birth.push(record);
            if (!lf) throw incompleteBirth();
            needed--;
            if (needed || prefixOnly) return;
            // Match the original bootstrap boundary: acquire the complete
            // required prefix before validating it or parsing the live suffix.
            await qualifyPrefix?.({ header, birth: Buffer.concat(birth) });
            for (const frame of birth.slice(1)) consume(frame);
            return;
        }
        if (!prefixOnly) consume(record);
    }
    let position = 0;
    while (position < extent) {
        const buffer = Buffer.allocUnsafe(Math.min(65536, extent - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        dependency?.assertCurrent();
        if (!bytesRead) throw Error('Archive truncated during observation');
        position += bytesRead;
        const chunk = buffer.subarray(0, bytesRead);
        let start = 0;
        while (start < chunk.length) {
            const end = chunk.indexOf(10, start);
            if (end < 0) { add(chunk.subarray(start)); break; }
            add(chunk.subarray(start, end + 1));
            await line(take(), true);
            start = end + 1;
            if (prefixOnly && header && needed === 0) return { header, birth: Buffer.concat(birth), events };
        }
    }
    if (partBytes) await line(take(), false);
    if (!header) throw Error('Empty archive');
    if (needed) throw incompleteBirth();
    if (!prefixOnly) {
        const decoded=decoder?.finish();
        if(dependency){
            const expected=dependency.prefix,actual=decoded?.prefix;
            if(!actual||decoded?.torn||actual.eventCount!==expected.eventCount||actual.bodyBytes!==expected.bodyBytes||actual.prefixDigest!==expected.prefixDigest||events.length!==1)throw Error('Owned dependency prefix mismatch');
            dependency.assertCurrent();
        }else if (managed(header.formatVersion) || events.some(e => e.type === 'compaction/replacement')) validateConversationHistory(events, header.formatVersion, header);
    }
    return { header, birth: Buffer.concat(birth), events };
}
