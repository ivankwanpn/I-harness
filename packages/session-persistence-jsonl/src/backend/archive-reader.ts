import { createJournalStreamDecoder } from '@i-harness/core-session/internal/archive';
import type { FileHandle } from 'node:fs/promises';
import { CURRENT_FORMAT_VERSION, validateConversationHistory, type SessionEvent, type JournalPrefix } from '@i-harness/core-session';
import { createHash } from 'node:crypto';
import type { SessionMeta } from '@i-harness/session-persistence';
import { parseHeader } from '../format.ts';
import { ArchiveEvidenceMismatch, createColdArchiveFramingRecorder, createVerifiedArchiveBodyDecoder, type VerifiedArchiveBody } from './verified-archive-body.ts';
const managed = (v: number) => [6, 7, 8, 9, 10, 11, 12, 13, 14].includes(v);
type ArchivePrefix = { header: SessionMeta; birth: Buffer };
type DependencySelection = { ordinals: ReadonlySet<number>; prefix: Readonly<JournalPrefix>; assertCurrent(): void; verified?: VerifiedArchiveBody; coldHeaderDigest?: string };
type ArchiveBodyDecoder = { push(bytes: Buffer): void; finish(): {
    prefix: JournalPrefix; torn: boolean; verified?: VerifiedArchiveBody; validatedEvents?(header: SessionMeta): SessionEvent[];
} };
const incompleteBirth = () => Object.assign(new Error('bootstrap-incomplete'), { code: 'SESSION_BOOTSTRAP_INCOMPLETE' });
/** IO chunks are bounded; complete decoded events and the largest record remain materialized. */
export async function readSessionArchive(handle: FileHandle, extent: number, prefixOnly = false, qualifyPrefix?: (prefix: ArchivePrefix) => Promise<void>, dependency?: DependencySelection, captureColdFraming = false) {
    let header: SessionMeta | undefined, parts: Buffer[] = [], partBytes = 0, legacyStopped = false;
    let events: SessionEvent[] = [];
    const birth: Buffer[] = [];
    let needed = 0, ordinal = 0, decoder: ArchiveBodyDecoder | undefined;
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
            const coldHeader = dependency?.coldHeaderDigest;
            if (coldHeader && createHash('sha256').update(record).digest('hex') !== coldHeader) throw new ArchiveEvidenceMismatch();
            header = parseHeader(record.subarray(0, lf ? record.length - 1 : record.length).toString('utf8'));
            // Ordinary headers still belong to the prefix: the bootstrap owner
            // needs their original bytes to classify a stray namespace.
            birth.push(record);
            if(dependency&&!managed(header.formatVersion))throw Error('Owned dependency format unsupported');
            if (header.semanticSeed) needed = header.semanticSeed.seedLength ? 2 : 1;
            if (managed(header.formatVersion) && !prefixOnly) {
                const journal = header.journal!;
                const accept = (unit: SessionEvent[]) => {
                    for (const event of unit) {
                        if (!dependency || dependency.ordinals.has(ordinal)) events.push(event);
                        ordinal++;
                    }
                };
                const collect = captureColdFraming && !dependency && lf && header.formatVersion === CURRENT_FORMAT_VERSION && !header.semanticSeed
                    && !journal.legacyEventCount && !journal.legacyBodyBytes && !journal.separatorBytes;
                decoder = (dependency && createVerifiedArchiveBodyDecoder(journal, header.formatVersion,
                    dependency.prefix, dependency.ordinals, event => events.push(event), dependency.verified, coldHeader !== undefined))
                    ?? (collect ? createColdArchiveFramingRecorder(journal, header.formatVersion)
                        : createJournalStreamDecoder(journal, header.formatVersion, accept));
            }
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
            // The archive owner needs exact header and birth lines. After
            // qualification, the managed decoder owns the remaining framing.
            if (decoder && needed === 0) {
                decoder.push(chunk.subarray(start));
                break;
            }
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
    if (needed) {
        // A structural export may encode the complete logical birth in one
        // frame. Only original physical-prefix/dependency reads require the
        // native phase layout; ordinary history must validate decoded data.
        if (prefixOnly || dependency) throw incompleteBirth();
        await qualifyPrefix?.({ header, birth: Buffer.concat(birth) });
        for (const frame of birth.slice(1)) consume(frame);
    }
    let verified: VerifiedArchiveBody | undefined;
    if (!prefixOnly) {
        const decoded=decoder?.finish();
        if (!dependency && header.semanticSeed) {
            const reservation = header.semanticSeed;
            const initial = 'initialInputId' in reservation && reservation.initialInputId !== undefined ? 1 : 0;
            if ((decoded?.validatedEvents ? decoded.prefix.eventCount : events.length) < reservation.seedLength + 1 + initial) throw incompleteBirth();
        }
        if(dependency){
            const expected=dependency.prefix,actual=decoded?.prefix;
            if(!actual||decoded?.torn||actual.eventCount!==expected.eventCount||actual.bodyBytes!==expected.bodyBytes||actual.prefixDigest!==expected.prefixDigest||events.length!==dependency.ordinals.size)throw Error('Owned dependency prefix mismatch');
            dependency.assertCurrent();
            verified = decoded.verified;
        }else if (managed(header.formatVersion) || events.some(e => e.type === 'compaction/replacement')) {
            if (decoded?.validatedEvents) events = decoded.validatedEvents(header);
            else validateConversationHistory(events, header.formatVersion, header);
            if (decoded?.verified && birth.length === 1 && decoded.prefix.bodyBytes === extent - birth[0]!.length) verified = decoded.verified;
        }
    }
    return { header, birth: Buffer.concat(birth), events, verified };
}
