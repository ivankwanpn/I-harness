import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import type { BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CURRENT_FORMAT_VERSION, freezeJsonData, readFactJournal, type JournalPrefix, type SessionEvent, type SessionView } from '@i-harness/core-session';
import { createArchiveJournalHistoryDecoder } from '@i-harness/core-session/internal/archive';
import { parseHeader } from '../format.ts';
import { isHeldTaskDocumentScope, SessionFormatUnsupportedError, type HeldTaskDocumentScope } from '@i-harness/session-persistence';
import { preflightDecodedFactHistory, preflightSessionFormat } from '@i-harness/session-persistence/internal/task-document-operations';
import { MAX_PREPARED_HISTORY_BYTES, MAX_PREPARED_HISTORY_EVENTS, type PreparedArchiveHistory, type ReplayColdHistory } from './cold-archive-history.ts';
import { isOriginalRestorationFramingEnvironment as cleanDecodeEnvironment, type RestoredArchiveFraming, type VerifiedArchiveBody } from './verified-archive-body.ts';

type Identity = { dev: bigint; ino: bigint; size: number; mtimeNs: bigint; ctimeNs: bigint };
type DirectoryChain = { root: Identity; rootAncestry: string; pathAncestry: string };
type Witness = { path: string; identity: Identity; digest: string; parents: DirectoryChain };
type ColdTranscript = { id: string; witness: Witness; initial: SessionView; reusableInitial?: true };
type ColdRead = { kind: 'process'; value: ColdTranscript } | { kind: 'history'; value: PreparedArchiveHistory; expiresAt: number };
type DecodedHistory = ReturnType<typeof readFactJournal> & { framing?: RestoredArchiveFraming };
export type CleanHistoryCheck = Readonly<{ before(id: string): Promise<void>; isCanonical(events: SessionEvent[]): boolean }>;
type Ports = { assertOriginal(): void; root: string; file(id: string): string; document(key: string): string; checkNamespace(id: string): Promise<void>; checkDeleted(kind: string, id: string): Promise<void>; isOriginalCleanCheck?(check: CleanHistoryCheck): boolean; hasOrdinaryNamespace?(id: string): Promise<boolean>; replayColdHistory?: ReplayColdHistory };
const bad = (): never => { throw new Error('PROCESS_READ_UNAVAILABLE'); };
class HistoryLocationChanged extends Error {}
const changedLocation = (): never => { throw new HistoryLocationChanged(); };
const identity = (stat: BigIntStats): Identity => {
    if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint' || stat.ino <= 0n || stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) return bad();
    return { dev: stat.dev, ino: stat.ino, size: Number(stat.size), mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
};
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
// Distinct selected paths share the store root, but each keeps its own complete
// directory chain. Absence must remain tied to that original parent as well.
const sameRoot = (a: DirectoryChain, b: DirectoryChain) => same(a.root, b.root) && a.rootAncestry === b.rootAncestry;
const sameParents = (a: DirectoryChain, b: DirectoryChain) => sameRoot(a, b) && a.pathAncestry === b.pathAncestry;
const stableParents = (a: DirectoryChain, b: DirectoryChain) => a.root.dev === b.root.dev && a.root.ino === b.root.ino && a.rootAncestry === b.rootAncestry && a.pathAncestry === b.pathAncestry;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const PREPARED_HISTORY_LIFETIME_MS = 2_500;
const { parse: nativeParse, stringify: nativeStringify } = JSON;
const nativeTranscriptDecoding = () => JSON.parse === nativeParse && JSON.stringify === nativeStringify
    && Object.getPrototypeOf(Array.prototype) === Object.prototype
    && !Object.hasOwn(Object.prototype, 'toJSON') && !Object.hasOwn(Array.prototype, 'toJSON');

/** The stream decoder owns the fresh bytes and decoded rows through validation.
 * Use the ordinary decoder to preserve its error ordering on malformed input. */
function decodeCleanHistory(body: Buffer, meta: ReturnType<typeof parseHeader>, header: Buffer): DecodedHistory | undefined {
    try {
        const history = createArchiveJournalHistoryDecoder(meta.journal!, meta.formatVersion);
        history.push(body);
        const result = history.finish();
        if (result.torn || result.prefix.bodyBytes !== body.length) return undefined;
        let original = false;
        const events = result.validatedEvents(meta, () => { original = true }, true);
        const framing = original && result.frames?.length ? Object.freeze({
            headerDigest: hash(header),
            body: Object.freeze({
                formatVersion: meta.formatVersion, legacyPrefixDigest: meta.journal!.legacyPrefixDigest,
                prefix: Object.freeze({ ...result.prefix }), digest: hash(body), frames: result.frames,
            }) satisfies VerifiedArchiveBody,
        }) : undefined;
        return { prefix: result.prefix, torn: false, events, framing };
    } catch { return undefined; }
}
/** Low-level byte adapter; cannot associate a backend with factory authority. */
export function createJsonlProcessReadCapability(ports: Ports) {
    const freshOwners = new WeakMap<object, HeldTaskDocumentScope>();
    const historyOwners = new WeakMap<object, { scope: HeldTaskDocumentScope; bytes: Buffer; identity: Identity; prefix?: Readonly<import('@i-harness/core-session').JournalPrefix>; cleanGeneration?: object; assertPrefixCurrent():void }>();
    const cleanWriterHistory = new WeakMap<Readonly<JournalPrefix>, { id: string; witness: Witness; generation: object; framing?: RestoredArchiveFraming }>();
    const decodedProcessHistory = new WeakMap<SessionView, { id: string; generation: object }>();
    let coldRead: ColdRead | undefined, historyExpiry: NodeJS.Timeout | undefined, coldGeneration = {};
    function replaceColdRead(value?: ColdRead) {
        if (historyExpiry) clearTimeout(historyExpiry);
        historyExpiry = undefined;
        coldRead = value;
    }
    function retireColdTranscript() { coldGeneration = {}; replaceColdRead(); }
    function prepareHistory(value: PreparedArchiveHistory) {
        ports.assertOriginal();
        if (!cleanDecodeEnvironment() || value.size >= MAX_PREPARED_HISTORY_BYTES ||
            value.events.length > MAX_PREPARED_HISTORY_EVENTS || !Object.isFrozen(value.events)) return;
        replaceColdRead({ kind: 'history', value, expiresAt: performance.now() + PREPARED_HISTORY_LIFETIME_MS });
        historyExpiry = setTimeout(replaceColdRead, PREPARED_HISTORY_LIFETIME_MS);
        historyExpiry.unref();
    }
    function takePreparedHistory(id: string, witness: Witness, header: Buffer, body: Buffer): DecodedHistory | undefined {
        const cached = coldRead;
        if (cached?.kind !== 'history' || cached.value.sessionId !== id) return undefined;
        replaceColdRead();
        const { value, expiresAt } = cached;
        if (performance.now() >= expiresAt || !cleanDecodeEnvironment() ||
            value.dev !== witness.identity.dev || value.ino !== witness.identity.ino ||
            value.size !== witness.identity.size || value.verified.prefix.bodyBytes !== body.length ||
            value.headerDigest !== hash(header) || value.verified.digest !== hash(body)) return undefined;
        return { prefix: value.verified.prefix, torn: false, events: value.events,
            framing: Object.freeze({ headerDigest: value.headerDigest, body: value.verified }) };
    }
    function processHeader(line: string) {
        const raw = JSON.parse(line) as Record<string, unknown>;
        // Generic header normalization deliberately remains unchanged. This
        // narrower read domain cannot infer local provenance for copied seed.
        if (Object.hasOwn(raw, 'seedLength') && raw.seedLength !== 0) bad();
        const meta = parseHeader(line);
        if (meta.formatVersion !== CURRENT_FORMAT_VERSION || meta.semanticSeed || !meta.journal) bad();
        return meta;
    }
    async function ancestors(path: string, unavailable: () => never = bad) {
        let parent = dirname(path), root: Identity | undefined;
        const rootAncestry: string[] = [], pathAncestry: string[] = [];
        for (;;) {
            const info = await lstat(parent, { bigint: true });
            if (!info.isDirectory() || info.isSymbolicLink()) unavailable();
            const current = identity(info), entry = `${current.dev}/${current.ino}`;
            pathAncestry.push(entry);
            if (parent === ports.root) root = current;
            if (root) rootAncestry.push(entry);
            const next = dirname(parent); if (next === parent) break; parent = next;
        }
        if (!root) return unavailable();
        return { root, rootAncestry: rootAncestry.join(':'), pathAncestry: pathAncestry.join(':') };
    }
    async function file(path: string, parents: DirectoryChain): Promise<{ bytes: Buffer; witness: Witness }> {
        if (!sameParents(parents, await ancestors(path))) bad();
        const before = await lstat(path, { bigint: true }); if (!before.isFile() || before.isSymbolicLink()) bad();
        const first = identity(before), handle = await open(path, 'r');
        try {
            if (!same(first, identity(await handle.stat({ bigint: true })))) bad();
            const bytes = Buffer.alloc(first.size + 1); let offset = 0;
            while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
            if (offset !== first.size || !same(first, identity(await handle.stat({ bigint: true }))) || !same(first, identity(await lstat(path, { bigint: true })))) bad();
            return { bytes: bytes.subarray(0, first.size), witness: { path, identity: first, digest: hash(bytes.subarray(0, first.size)), parents } };
        } finally { await handle.close(); }
    }
    async function digestMatches(w: Witness, stableDirectories = false): Promise<boolean> {
        const sameChain = stableDirectories ? (a: DirectoryChain, b: DirectoryChain) => a.root.dev === b.root.dev && a.root.ino === b.root.ino && a.rootAncestry === b.rootAncestry && a.pathAncestry === b.pathAncestry : sameParents;
        if (!sameChain(w.parents, await ancestors(w.path))) bad();
        const before = await lstat(w.path, { bigint: true }); if (!before.isFile() || before.isSymbolicLink() || !same(w.identity, identity(before))) bad();
        const handle: FileHandle = await open(w.path, 'r');
        try {
            if (!same(w.identity, identity(await handle.stat({ bigint: true })))) bad();
            const digest = createHash('sha256'), buffer = Buffer.alloc(65536); let offset = 0;
            while (offset <= w.identity.size) {
                const length = Math.min(buffer.length, w.identity.size + 1 - offset), read = await handle.read(buffer, 0, length, offset);
                if (!read.bytesRead) break; digest.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead;
            }
            if (offset !== w.identity.size || !same(w.identity, identity(await handle.stat({ bigint: true }))) || !same(w.identity, identity(await lstat(w.path, { bigint: true }))) || !sameChain(w.parents, await ancestors(w.path))) bad();
            return digest.digest('hex') === w.digest;
        } finally { await handle.close(); }
    }
    async function verify(w: Witness, stableDirectories = false) {
        if (!await digestMatches(w, stableDirectories)) bad();
    }

    /** New writer authority supplies its own descriptor. The prior owner lent
     * just the exact header/body byte witness, with no surviving Task scope. */
    function openCleanWriterPrefix(id: string, prefix: Readonly<JournalPrefix>, assertWriter: () => void) {
        const original = cleanWriterHistory.get(prefix), hasOrdinaryNamespace = ports.hasOrdinaryNamespace;
        if (!original || original.id !== id || original.generation !== coldGeneration ||
            !hasOrdinaryNamespace || !cleanDecodeEnvironment()) return undefined;
        const { witness, generation } = original;
        const current = () => {
            assertWriter(); ports.assertOriginal();
            if (generation !== coldGeneration) bad();
        };
        async function sameFile(handle: FileHandle): Promise<boolean> {
            current();
            if (ports.file(id) !== witness.path) return false;
            await ports.checkDeleted('session', id);
            let intact = false;
            try {
                if (await hasOrdinaryNamespace!(id)) {
                    const parents = await ancestors(witness.path, changedLocation);
                    const opened = await handle.stat({ bigint: true });
                    const path = await lstat(witness.path, { bigint: true });
                    intact = opened.isFile() && path.isFile() && !path.isSymbolicLink() && stableParents(witness.parents, parents)
                        && same(witness.identity, identity(opened)) && same(witness.identity, identity(path));
                }
            } catch (error) {
                if (!(error instanceof HistoryLocationChanged) && !['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw error;
            }
            current();
            return intact;
        }
        const sameEnvironment = (): true | undefined => cleanDecodeEnvironment() ? true : undefined;
        return Object.freeze({ prefix, async seal(handle: FileHandle): Promise<boolean | undefined> {
            return await sameFile(handle) ? sameEnvironment() : false;
        }, async verify(handle: FileHandle): Promise<boolean | undefined> {
            if (!await sameFile(handle)) return false;
            if (!sameEnvironment()) return undefined;
            const limit = witness.identity.size + 1, digest = createHash('sha256'), buffer = Buffer.allocUnsafe(Math.min(65536, limit));
            let offset = 0;
            while (offset < limit) {
                if (generation !== coldGeneration) bad();
                const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit - offset), offset);
                if (!bytesRead) break;
                digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
            }
            if (!await sameFile(handle) || offset !== witness.identity.size || digest.digest('hex') !== witness.digest) return false;
            return sameEnvironment();
        } });
    }
    async function captureTranscript(id: string, path: string, parents: DirectoryChain, decoder: TextDecoder, generation: object): Promise<ColdTranscript> {
        const prior = coldRead?.kind === 'process' ? coldRead.value : undefined, native = nativeTranscriptDecoding();
        if (prior?.id === id) {
            if (native && prior.witness.path === path && sameParents(prior.witness.parents, parents)) {
                const current = await lstat(path, { bigint: true });
                if (!current.isFile() || current.isSymbolicLink()) bad();
                // Equality of metadata selects a candidate only. The shared
                // descriptor pass still hashes every byte on a cache hit.
                if (same(prior.witness.identity, identity(current)) && await digestMatches(prior.witness) && nativeTranscriptDecoding()) return prior;
            }
            if (coldRead?.value === prior) replaceColdRead();
            // A proven digest mismatch may enter the ordinary decode after
            // its descriptor closed. I/O and currentness failures still throw.
            ports.assertOriginal(); await ports.checkDeleted('session', id); await ports.checkNamespace(id);
        }
        const raw = await file(path, parents);
        if (!isUtf8(raw.bytes)) bad();
        const end = raw.bytes.indexOf(10); if (end < 0 || raw.bytes.at(-1) !== 10) bad();
        const nativeHeader = native && nativeTranscriptDecoding();
        const meta = processHeader(decoder.decode(raw.bytes.subarray(0, end)));
        const journal = meta.journal!, body = raw.bytes.subarray(end + 1);
        const originalDecoder = nativeHeader && nativeTranscriptDecoding() &&
            !journal.legacyBodyBytes && !journal.legacyEventCount && !journal.separatorBytes;
        let decoded: ReturnType<typeof readFactJournal>;
        if (originalDecoder) {
            const history = createArchiveJournalHistoryDecoder(journal, meta.formatVersion);
            history.push(body);
            const { prefix, torn, validatedEvents } = history.finish();
            decoded = { prefix, torn, events: validatedEvents(meta) };
        } else decoded = readFactJournal(body, journal, meta.formatVersion, meta);
        if (decoded.torn || decoded.prefix.bodyBytes !== body.length) bad();
        // Only data produced by the original JSON decoders qualifies for a
        // reusable recursively frozen capture. Keep ordinary reads unchanged.
        const initial = freezeJsonData({ formatVersion: meta.formatVersion, header: meta, events: decoded.events });
        if (originalDecoder && meta.sessionId === id && nativeTranscriptDecoding())
            decodedProcessHistory.set(initial, { id, generation });
        const reusable = native && nativeTranscriptDecoding() && raw.witness.identity.size < MAX_PREPARED_HISTORY_BYTES
            && decoded.events.length <= MAX_PREPARED_HISTORY_EVENTS;
        return { id, witness: raw.witness, initial, ...(reusable ? { reusableInitial: true as const } : {}) };
    }
    async function captureCommon(id: string, requested: readonly string[], transcript: boolean) {
        ports.assertOriginal();
        const generation = coldGeneration;
        const assertGeneration = () => { if (transcript && generation !== coldGeneration) bad(); };
        const keys = [...new Set(requested)].sort(); if (keys.length > 32) bad();
        const path = ports.file(id), sessionParents = await ancestors(path);
        await ports.checkDeleted('session', id); await ports.checkNamespace(id);
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const raw = transcript ? await captureTranscript(id, path, sessionParents, decoder, generation) : undefined;
        assertGeneration();
        if (!transcript) {
            // Generic loads may normalize malformed legacy boundary fields.
            // Check the original bounded header as domain evidence only; this
            // neither decodes history nor certifies managed backing-file bytes.
            const info = await lstat(path, { bigint: true });
            if (!info.isFile() || info.isSymbolicLink()) bad();
            const original = identity(info), handle = await open(path, 'r');
            try {
                if (!same(original, identity(await handle.stat({ bigint: true })))) bad();
                const bytes = Buffer.alloc(65536); let offset = 0, end = -1;
                while (offset < bytes.length && end < 0) {
                    const read = await handle.read(bytes, offset, bytes.length - offset, offset);
                    if (!read.bytesRead) break;
                    offset += read.bytesRead; end = bytes.subarray(0, offset).indexOf(10);
                }
                if (end < 0) bad();
                processHeader(decoder.decode(bytes.subarray(0, end)));
            } finally { await handle.close(); }
        }
        const documents = new Map<string, { kind: 'absent' } | { kind: 'present'; value: unknown }>(), witnesses = new Map<string, Witness>();
        const documentParents = new Map<string, DirectoryChain>();
        for (const key of keys) {
            await ports.checkDeleted('document', key); const doc = ports.document(key);
            const parents = await ancestors(doc);
            if (!sameRoot(sessionParents, parents)) bad();
            documentParents.set(key, parents);
            try { const captured = await file(doc, parents); documents.set(key, Object.freeze({ kind: 'present', value: freezeJsonData(JSON.parse(decoder.decode(captured.bytes))) })); witnesses.set(key, captured.witness); }
            catch (error) { if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') throw error; if (!sameParents(parents, await ancestors(doc))) bad(); await ports.checkDeleted('document', key); documents.set(key, Object.freeze({ kind: 'absent' })); }
        }
        let finished = false, checking = false, failed = false;
        async function cheap() {
            ports.assertOriginal(); assertGeneration();
            await ports.checkDeleted('session', id); await ports.checkNamespace(id);
            if (!sameParents(sessionParents, await ancestors(path))) bad();
            if (raw) { const row = await lstat(path, { bigint: true }); if (!row.isFile() || row.isSymbolicLink() || !same(raw.witness.identity, identity(row))) bad(); }
            for (const key of keys) {
                await ports.checkDeleted('document', key); const doc = ports.document(key), witness = witnesses.get(key);
                if (!sameParents(documentParents.get(key)!, await ancestors(doc))) bad();
                try { const info = await lstat(doc, { bigint: true }); if (!witness || !info.isFile() || info.isSymbolicLink() || !same(witness.identity, identity(info))) bad(); }
                catch (error) { if (witness || (error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') throw error; }
            }
            ports.assertOriginal(); assertGeneration();
        }
        await cheap(); ports.assertOriginal(); assertGeneration();
        const readonlyDocuments = Object.freeze({
            get size() { return documents.size }, get: documents.get.bind(documents), has: documents.has.bind(documents),
            entries: documents.entries.bind(documents), keys: documents.keys.bind(documents), values: documents.values.bind(documents),
            [Symbol.iterator]: documents[Symbol.iterator].bind(documents),
            forEach(callback: (value: { kind: 'absent' } | { kind: 'present'; value: unknown }, key: string, map: ReadonlyMap<string, { kind: 'absent' } | { kind: 'present'; value: unknown }>) => void, thisArg?: unknown) { documents.forEach((value, key) => callback.call(thisArg, value, key, readonlyDocuments)); },
        });
        return { initial: raw?.initial, ...(raw?.reusableInitial ? { reusableInitial: true as const } : {}), documents: readonlyDocuments,
            async check() {
                if (finished || checking || failed) { failed = true; bad(); }
                checking = true; try { await cheap(); } catch (error) { failed = true; throw error; } finally { checking = false; }
            },
            async finish() {
                if (finished || checking || failed) { failed = true; bad(); } finished = true;
                await cheap();
                await ports.checkDeleted('session', id); await ports.checkNamespace(id); if (raw) await verify(raw.witness);
                for (const key of keys) {
                    await ports.checkDeleted('document', key); const witness = witnesses.get(key), doc = ports.document(key);
                    if (witness) await verify(witness);
                    else { if (!sameParents(documentParents.get(key)!, await ancestors(doc))) bad(); try { await lstat(doc, { bigint: true }); bad(); } catch (error) { if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') throw error; } }
                }
                // Verification and its resource closes can yield. Recheck the
                // original namespace, tombstones, paths and absent documents
                // after the last stream closes, before this owner succeeds.
                await cheap(); ports.assertOriginal(); assertGeneration();
                if (raw?.reusableInitial) replaceColdRead({ kind: 'process', value: raw });
            },
        };
    }
    async function observeFreshTaskParent(scope: HeldTaskDocumentScope) {
        if (!isHeldTaskDocumentScope(scope)) bad();
        scope.assertActive(); ports.assertOriginal();
        const id = scope.parentSessionId, path = ports.file(id), parents = await ancestors(path);
        async function rootCurrent() {
            scope.assertActive(); ports.assertOriginal(); await ports.checkDeleted('session', id); await ports.checkDeleted('document', scope.key); await ports.checkNamespace(id);
            const current = await ancestors(path);
            if (parents.root.dev !== current.root.dev || parents.root.ino !== current.root.ino || parents.rootAncestry !== current.rootAncestry || parents.pathAncestry !== current.pathAncestry) bad();
            scope.assertActive(); ports.assertOriginal();
        }
        async function absent() {
            await rootCurrent();
            try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') { await ports.checkDeleted('session', id); await ports.checkDeleted('document', scope.key); await ports.checkNamespace(id); const after = await ancestors(path); if (parents.root.dev !== after.root.dev || parents.root.ino !== after.root.ino || parents.rootAncestry !== after.rootAncestry || parents.pathAncestry !== after.pathAncestry) bad(); scope.assertActive(); ports.assertOriginal(); return; } throw error; }
            bad();
        }
        const proof = Object.freeze({ async assertCurrent() { if (this !== proof) bad(); await absent(); }, async assertRoot() { if (this !== proof) bad(); await rootCurrent(); } });
        freshOwners.set(proof, scope); await proof.assertCurrent(); return proof;
    }
    async function observeReservedTaskParent(scope: HeldTaskDocumentScope, readNamespace: () => Promise<string>) {
        if (!isHeldTaskDocumentScope(scope)) bad(); scope.assertActive(); ports.assertOriginal();
        const id = scope.parentSessionId, path = ports.file(id), parents = await ancestors(path), baseline = await readNamespace();
        async function rootCurrent() {
            scope.assertActive(); ports.assertOriginal(); await ports.checkDeleted('session',id); await ports.checkDeleted('document',scope.key);
            const current = await ancestors(path); if (parents.root.dev !== current.root.dev || parents.root.ino !== current.root.ino || parents.rootAncestry !== current.rootAncestry || parents.pathAncestry !== current.pathAncestry) bad();
            scope.assertActive(); ports.assertOriginal();
        }
        async function absent() {
            await rootCurrent(); if (await readNamespace() !== baseline) bad();
            try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') { await rootCurrent(); if (await readNamespace() !== baseline) bad(); return } throw error }
            bad();
        }
        const proof = Object.freeze({ async assertCurrent() { if (this !== proof) bad(); await absent() }, async assertRoot() { if (this !== proof) bad(); await rootCurrent() } })
        freshOwners.set(proof,scope); await proof.assertCurrent(); return proof
    }
    async function observePublishedTaskParent(scope: HeldTaskDocumentScope, readNamespace: () => Promise<string>) {
        if (!isHeldTaskDocumentScope(scope)) bad()
        scope.assertActive(); ports.assertOriginal()
        const id = scope.parentSessionId, path = ports.file(id), parents = await ancestors(path)
        const before = await lstat(path, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined; throw error })
        if (before && (!before.isFile() || before.isSymbolicLink())) bad()
        const original = before && identity(before), baseline = await readNamespace()
        async function rootCurrent() {
            scope.assertActive(); ports.assertOriginal()
            await ports.checkDeleted('session', id); await ports.checkDeleted('document', scope.key)
            const current = await ancestors(path)
            if (parents.root.dev !== current.root.dev || parents.root.ino !== current.root.ino
                || parents.rootAncestry !== current.rootAncestry || parents.pathAncestry !== current.pathAncestry) bad()
            scope.assertActive(); ports.assertOriginal()
        }
        const proof = Object.freeze({
            async assertCurrent() {
                if (this !== proof) bad()
                await rootCurrent()
                const file = await lstat(path, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined; throw error })
                if (original ? !file || !file.isFile() || file.isSymbolicLink() || !same(original,identity(file)) : !!file) bad()
                if (await readNamespace() !== baseline) bad()
                await rootCurrent()
                const finalFile = await lstat(path, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined; throw error })
                scope.assertActive(); ports.assertOriginal()
                if (original ? !finalFile || !finalFile.isFile() || finalFile.isSymbolicLink() || !same(original,identity(finalFile)) : !!finalFile) bad()
            },
            async assertRoot() { if (this !== proof) bad(); await rootCurrent() },
        })
        // This scope authenticates the published partial prefix. Creation and
        // history writers require proofs from their dedicated constructors.
        await proof.assertCurrent()
        return proof
    }
    function openTaskHistory(scope: HeldTaskDocumentScope, namespaceCheck?: () => Promise<void | string>, cleanCheck?: CleanHistoryCheck) {
        if (!isHeldTaskDocumentScope(scope)) bad();
        scope.assertActive(); ports.assertOriginal();
        const id = scope.parentSessionId, path = ports.file(id), checkNamespace = namespaceCheck ?? (() => ports.checkNamespace(id));
        const resources = new Set<{ handle: FileHandle; close: FileHandle['close']; failed: boolean; cause?: unknown }>();
        let observing: Promise<{ initial: import('@i-harness/core-session').SessionView; seedLength: number; assertCurrent(): Promise<void>; assertRoot(): Promise<void> }> | undefined;
        let observingClean: Promise<Awaited<NonNullable<typeof observing>> | undefined> | undefined;
        let checking: Promise<void> | undefined, cleanup: Promise<void> | undefined, retiring = false;
        let verificationBuffer: Buffer | undefined;
        async function closeResource(resource: { handle: FileHandle; close: FileHandle['close']; failed: boolean; cause?: unknown }) {
            if (resource.failed && resource.handle.fd < 0) throw resource.cause;
            try { await Reflect.apply(resource.close, resource.handle, []); resources.delete(resource); }
            catch (error) { resource.failed = true; resource.cause = error; throw error; }
        }
        type CapturedHistory = { bytes: Buffer; witness: Witness };
        async function readOriginal(parents: DirectoryChain): Promise<CapturedHistory>;
        async function readOriginal(parents: DirectoryChain, expected: Witness, scratch?: Buffer): Promise<void>;
        async function readOriginal(parents: DirectoryChain, expected?: Witness, scratch?: Buffer): Promise<CapturedHistory | void> {
            scope.assertActive(); if (resources.size) bad();
            const before = await lstat(path, { bigint: true }); scope.assertActive(); if (!before.isFile() || before.isSymbolicLink()) bad();
            const first = identity(before);
            if (expected && !same(expected.identity, first)) bad();
            const handle = await open(path, 'r'), resource = { handle, close: handle.close, failed: false }; resources.add(resource);
            let result: CapturedHistory | undefined, observedDigest: string | undefined, failed = false, cause: unknown;
            try {
                scope.assertActive(); if (!same(first, identity(await handle.stat({ bigint: true })))) bad();
                // Include one byte past the fixed extent to detect early EOF and growth.
                const length = first.size + 1, digest = createHash('sha256');
                const buffer = scratch ?? (expected ? Buffer.allocUnsafe(Math.min(65536, length)) : Buffer.alloc(length));
                const chunkSize = scratch?.length ?? 65536;
                let offset = 0;
                while (offset < length) {
                    scope.assertActive();
                    const targetOffset = expected ? 0 : offset;
                    const { bytesRead } = await handle.read(buffer, targetOffset, Math.min(chunkSize, length - offset), offset);
                    if (!bytesRead) break;
                    digest.update(buffer.subarray(targetOffset, targetOffset + bytesRead));
                    offset += bytesRead;
                }
                scope.assertActive(); if (offset !== first.size || !same(first, identity(await handle.stat({ bigint: true }))) || !same(first, identity(await lstat(path, { bigint: true })))) bad();
                observedDigest = digest.digest('hex');
                if (!expected) result = { bytes: buffer.subarray(0, first.size), witness: { path, identity: first, digest: observedDigest, parents } };
            } catch (error) { failed = true; cause = error; }
            try { await closeResource(resource); } catch (error) { if (failed) throw new AggregateError([cause, error], 'Task history read and cleanup failed'); throw error; }
            if (failed) throw cause;
            if (expected && observedDigest !== expected.digest) bad();
            return result;
        }
        async function observeOriginal(clean?: CleanHistoryCheck, coldPageEvidence?: () => object | undefined) {
            scope.assertActive(); ports.assertOriginal(); await ports.checkDeleted('session', id);
            await clean?.before(id);
            let sourceDigest = clean ? undefined : await checkNamespace();
            scope.assertActive();
            const parents = await ancestors(path), captured = await readOriginal(parents);
            scope.assertActive();
            if (sourceDigest !== undefined && sourceDigest !== captured.witness.digest) bad();
            if (!clean && !isUtf8(captured.bytes)) bad();
            const end = captured.bytes.indexOf(10); if (end < 0) bad();
            if (clean && !isUtf8(captured.bytes.subarray(0, end))) bad();
            const generation = coldGeneration;
            const nativeHeader = !!clean && ports.isOriginalCleanCheck?.(clean) && cleanDecodeEnvironment();
            const line = captured.bytes.subarray(0, end).toString('utf8'), raw = JSON.parse(line) as Record<string, unknown>, meta = parseHeader(line);
            if (clean) {
                if (!Number.isSafeInteger(meta.formatVersion) || meta.formatVersion < 0)
                    throw new SessionFormatUnsupportedError('invalid session format version');
                if (meta.formatVersion > CURRENT_FORMAT_VERSION)
                    throw new SessionFormatUnsupportedError(`format version ${meta.formatVersion} is newer than this build (upgrade the harness)`);
            }
            if (meta.sessionId !== id || !Number.isSafeInteger(meta.formatVersion) || meta.formatVersion > CURRENT_FORMAT_VERSION) bad();
            if (Object.hasOwn(raw, 'seedLength') && (!Number.isSafeInteger(raw.seedLength) || (raw.seedLength as number) < 0)) bad();
            if (Object.hasOwn(raw, 'parentSession') && (typeof raw.parentSession !== 'string' || !raw.parentSession || !Object.hasOwn(raw, 'seedLength'))) bad();
            const body = captured.bytes.subarray(end + 1);
            if (clean) {
                if (!stableParents(parents, await ancestors(path))) bad();
                scope.assertActive();
                const journal = meta.journal;
                if (meta.formatVersion !== CURRENT_FORMAT_VERSION || meta.semanticSeed !== undefined ||
                    !journal || journal.legacyEventCount || journal.legacyBodyBytes || journal.separatorBytes ||
                    captured.bytes.at(-1) !== 10) return undefined;
                if (!isUtf8(body)) bad();
                sourceDigest = await checkNamespace();
                scope.assertActive();
                if (sourceDigest !== undefined && sourceDigest !== captured.witness.digest) bad();
            }
            if (meta.formatVersion >= 6 && captured.bytes.at(-1) !== 10) bad();
            let decoded: DecodedHistory | undefined;
            let validatedClean = false;
            if (meta.formatVersion >= 6) {
                // The clean route above already excluded older formats, seeds,
                // legacy boundaries, and partial bytes. Inherited lineages and
                // published forks retain their ordinary validation semantics.
                if (nativeHeader && sourceDigest === undefined && !Object.hasOwn(raw, 'parentSession') &&
                    !Object.hasOwn(raw, 'seedLength') && !Object.hasOwn(raw, 'forkPublication') &&
                    meta.origin !== 'fork' && cleanDecodeEnvironment()) {
                    const headerBytes = captured.bytes.subarray(0, end + 1);
                    decoded = takePreparedHistory(id, captured.witness, headerBytes, body);
                    if (!decoded && coldPageEvidence && ports.replayColdHistory) {
                        const evidence = coldPageEvidence();
                        scope.assertActive(); ports.assertOriginal();
                        if (evidence) decoded = ports.replayColdHistory(id, evidence, captured.witness.identity, headerBytes, body, meta);
                    }
                    decoded ??= decodeCleanHistory(body, meta, headerBytes);
                    validatedClean = decoded !== undefined;
                }
                try { decoded ??= readFactJournal(body, meta.journal!, meta.formatVersion, meta); }
                catch (cause) {
                    if (clean && ['SESSION_CONTEXT_REPLACEMENT_FORMAT', 'SESSION_CONVERSATION_FORMAT'].includes((cause as { code?: string })?.code ?? ''))
                        throw new SessionFormatUnsupportedError('unsupported conversation history', { cause });
                    throw cause;
                }
            }
            if (decoded?.torn || decoded && decoded.prefix.bodyBytes !== body.length) bad();
            const events = decoded ? decoded.events : body.toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
            const seedLength = meta.seedLength ?? 0;
            if (seedLength > events.length) bad();
            if (decoded) preflightDecodedFactHistory(meta.formatVersion, events);
            else preflightSessionFormat(meta.formatVersion, events, meta);
            if (clean && !clean.isCanonical(events)) return undefined;
            scope.assertActive();
            const initial = freezeJsonData({ formatVersion: meta.formatVersion, header: meta, events }) as import('@i-harness/core-session').SessionView;
            const proof = Object.freeze({ initial, seedLength, async assertRoot() { if (this !== proof || retiring) bad(); scope.assertActive(); ports.assertOriginal(); await ports.checkDeleted('session', id); await checkNamespace(); if (!stableParents(parents, await ancestors(path))) bad(); scope.assertActive(); ports.assertOriginal(); }, assertCurrent() {
                if (this !== proof || retiring || checking || resources.size) return Promise.reject(new Error('TASK_HISTORY_UNAVAILABLE'));
                checking = Promise.resolve().then(async () => {
                    scope.assertActive(); ports.assertOriginal(); await ports.checkDeleted('session', id); const currentDigest = await checkNamespace(); if (currentDigest !== undefined && currentDigest !== captured.witness.digest) bad();
                    if (!stableParents(parents, await ancestors(path))) bad();
                    // This proof admits one descriptor check at a time. Reuse
                    // its scratch across full-byte checks, then release it
                    // with the original Task scope.
                    const scratch = validatedClean && captured.witness.identity.size > 65536 && cleanDecodeEnvironment()
                        ? verificationBuffer ??= Buffer.allocUnsafe(Math.min(1024 * 1024, captured.witness.identity.size + 1))
                        : undefined;
                    await readOriginal(parents, captured.witness, scratch);
                    if (!stableParents(parents, await ancestors(path))) bad();
                    scope.assertActive(); ports.assertOriginal();
                });
                void checking.then(() => { checking = undefined }, () => { checking = undefined }); return checking;
            } });
            if(historyOwners.has(proof))bad();
            const prefix=decoded?Object.freeze({eventCount:decoded.prefix.eventCount,bodyBytes:decoded.prefix.bodyBytes,prefixDigest:decoded.prefix.prefixDigest}):undefined;
            historyOwners.set(proof, { scope, bytes: captured.bytes, identity: captured.witness.identity, prefix,
                cleanGeneration: validatedClean && cleanDecodeEnvironment() ? generation : undefined,
                assertPrefixCurrent(){if(retiring||checking||resources.size)bad();scope.assertActive();ports.assertOriginal()} });
            await proof.assertCurrent();
            if (!retiring && prefix && validatedClean && generation === coldGeneration && cleanDecodeEnvironment()) {
                scope.assertActive(); ports.assertOriginal();
                const witness = Object.freeze({ ...captured.witness, identity: Object.freeze({ ...captured.witness.identity }) });
                cleanWriterHistory.set(prefix, { id, witness, generation, framing: decoded?.framing });
            }
            return proof;
        }
        function settle(retire: boolean) {
            if (retire) retiring = true; if (cleanup) return cleanup;
            cleanup = Promise.resolve().then(async () => { await observing?.catch(() => {}); await observingClean?.catch(() => {}); await checking?.catch(() => {}); verificationBuffer = undefined; let failed = false, cause: unknown; for (const resource of resources) try { await closeResource(resource); } catch (error) { if (!failed) { failed = true; cause = error; } } if (failed) throw cause; });
            void cleanup.then(() => { cleanup = undefined }, () => { cleanup = undefined }); return cleanup;
        }
        const session = Object.freeze({
            observe() { if (this !== session) return Promise.reject(new TypeError('Invalid history receiver')); if (observingClean || retiring && !observing) return Promise.reject(new Error('TASK_HISTORY_UNAVAILABLE')); return observing ??= Promise.resolve().then(async () => await observeOriginal() ?? bad()); },
            observeClean(coldPageEvidence?: () => object | undefined) { if (this !== session) return Promise.reject(new TypeError('Invalid history receiver')); if (!cleanCheck || observing || retiring) return Promise.reject(new Error('TASK_HISTORY_UNAVAILABLE')); return observingClean ??= Promise.resolve().then(() => observeOriginal(cleanCheck, coldPageEvidence)); },
            hasDebt() { if (this !== session) throw new TypeError('Invalid history receiver'); return [...resources].some(resource => resource.failed) },
            retryResources() { if (this !== session || retiring) return Promise.reject(new TypeError('Invalid history receiver')); return settle(false) },
            settleResources() { if (this !== session) return Promise.reject(new TypeError('Invalid history receiver')); return settle(true) },
        });
        return session;
    }
    return {
        openTaskHistory, observeFreshTaskParent, observeReservedTaskParent, observePublishedTaskParent, retireColdTranscript, prepareHistory, openCleanWriterPrefix,
        recognizesDecodedProcessHistory(id: string, initial: SessionView): boolean {
            const proof = decodedProcessHistory.get(initial);
            return !!proof && proof.id === id && proof.generation === coldGeneration && nativeTranscriptDecoding();
        },
        recognizesCleanHistoryMaterialization(proof: object) {
            const owner = historyOwners.get(proof);
            if (!owner || owner.cleanGeneration !== coldGeneration || !cleanDecodeEnvironment()) return false;
            try { owner.assertPrefixCurrent(); return true; } catch { return false; }
        },
        assertFreshOwner(proof: object, scope: HeldTaskDocumentScope) { if (freshOwners.get(proof) !== scope) bad(); scope.assertActive(); },
        qualifiedHistoryPrefix(proof:object){const value=historyOwners.get(proof);if(!value?.prefix)return undefined;try{value.assertPrefixCurrent();return value.prefix}catch{return undefined}},
        qualifiedHistoryFraming(id: string, proof: object, prefix: Readonly<JournalPrefix>) {
            const owner = historyOwners.get(proof), original = cleanWriterHistory.get(prefix);
            if (owner?.prefix !== prefix || original?.id !== id || original.generation !== coldGeneration || !cleanDecodeEnvironment()) return undefined;
            try { owner.assertPrefixCurrent(); return original.framing; } catch { return undefined; }
        },
        originalHistory(proof: object, scope: HeldTaskDocumentScope) { const value = historyOwners.get(proof); if (!value || value.scope !== scope) return bad(); scope.assertActive(); return { bytes: value.bytes, identity: value.identity }; },
        async capture(id: string, requested: readonly string[]) {
            const result = await captureCommon(id, requested, true)
            if (!result.initial) return bad()
            return { ...result, initial: result.initial as import('@i-harness/core-session').SessionView }
        },
        async captureManagedAuxiliary(id: string, requested: readonly string[]) {
            const { initial: _initial, ...result } = await captureCommon(id, requested, false)
            return result
        },
    };
}
