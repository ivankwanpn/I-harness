import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import type { BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CURRENT_FORMAT_VERSION, freezeJsonData, readFactJournal } from '@i-harness/core-session';
import { parseHeader } from '../format.ts';

type Identity = { dev: bigint; ino: bigint; size: number; mtimeNs: bigint; ctimeNs: bigint };
type DirectoryChain = { root: Identity; rootAncestry: string; pathAncestry: string };
type Witness = { path: string; identity: Identity; digest: string; parents: DirectoryChain };
type Ports = { assertOriginal(): void; root: string; file(id: string): string; document(key: string): string; checkNamespace(id: string): Promise<void>; checkDeleted(kind: string, id: string): Promise<void> };
const bad = (): never => { throw new Error('PROCESS_READ_UNAVAILABLE'); };
const identity = (stat: BigIntStats): Identity => {
    if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint' || stat.ino <= 0n || stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) return bad();
    return { dev: stat.dev, ino: stat.ino, size: Number(stat.size), mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
};
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
// Distinct selected paths share the store root, but each keeps its own complete
// directory chain. Absence must remain tied to that original parent as well.
const sameRoot = (a: DirectoryChain, b: DirectoryChain) => same(a.root, b.root) && a.rootAncestry === b.rootAncestry;
const sameParents = (a: DirectoryChain, b: DirectoryChain) => sameRoot(a, b) && a.pathAncestry === b.pathAncestry;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Low-level byte adapter; cannot associate a backend with factory authority. */
export function createJsonlProcessReadCapability(ports: Ports) {
    function processHeader(line: string) {
        const raw = JSON.parse(line) as Record<string, unknown>;
        // Generic header normalization deliberately remains unchanged. This
        // narrower read domain cannot infer local provenance for copied seed.
        if (Object.hasOwn(raw, 'seedLength') && raw.seedLength !== 0) bad();
        const meta = parseHeader(line);
        if (meta.formatVersion !== CURRENT_FORMAT_VERSION || meta.semanticSeed || !meta.journal) bad();
        return meta;
    }
    async function ancestors(path: string) {
        let parent = dirname(path), root: Identity | undefined;
        const rootAncestry: string[] = [], pathAncestry: string[] = [];
        for (;;) {
            const info = await lstat(parent, { bigint: true });
            if (!info.isDirectory() || info.isSymbolicLink()) bad();
            const current = identity(info), entry = `${current.dev}/${current.ino}`;
            pathAncestry.push(entry);
            if (parent === ports.root) root = current;
            if (root) rootAncestry.push(entry);
            const next = dirname(parent); if (next === parent) break; parent = next;
        }
        if (!root) return bad();
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
    async function verify(w: Witness) {
        if (!sameParents(w.parents, await ancestors(w.path))) bad();
        const before = await lstat(w.path, { bigint: true }); if (!before.isFile() || before.isSymbolicLink() || !same(w.identity, identity(before))) bad();
        const handle: FileHandle = await open(w.path, 'r');
        try {
            if (!same(w.identity, identity(await handle.stat({ bigint: true })))) bad();
            const digest = createHash('sha256'), buffer = Buffer.alloc(65536); let offset = 0;
            while (offset <= w.identity.size) {
                const length = Math.min(buffer.length, w.identity.size + 1 - offset), read = await handle.read(buffer, 0, length, offset);
                if (!read.bytesRead) break; digest.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead;
            }
            if (offset !== w.identity.size || digest.digest('hex') !== w.digest || !same(w.identity, identity(await handle.stat({ bigint: true }))) || !same(w.identity, identity(await lstat(w.path, { bigint: true }))) || !sameParents(w.parents, await ancestors(w.path))) bad();
        } finally { await handle.close(); }
    }
    async function captureCommon(id: string, requested: readonly string[], transcript: boolean) {
        ports.assertOriginal();
        const keys = [...new Set(requested)].sort(); if (keys.length > 32) bad();
        const path = ports.file(id), sessionParents = await ancestors(path);
        await ports.checkDeleted('session', id); await ports.checkNamespace(id);
        const raw = transcript ? await file(path, sessionParents) : undefined, decoder = new TextDecoder('utf-8', { fatal: true });
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
        let initial: ReturnType<typeof freezeJsonData> | undefined;
        if (raw) {
            if (!isUtf8(raw.bytes)) bad();
            const end = raw.bytes.indexOf(10); if (end < 0 || raw.bytes.at(-1) !== 10) bad();
            const meta = processHeader(decoder.decode(raw.bytes.subarray(0, end)));
            const decoded = readFactJournal(raw.bytes.subarray(end + 1), meta.journal!, meta.formatVersion, meta);
            if (decoded.torn || decoded.prefix.bodyBytes !== raw.bytes.length - end - 1) bad();
            initial = freezeJsonData({ formatVersion: meta.formatVersion, header: meta, events: decoded.events });
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
            ports.assertOriginal();
            await ports.checkDeleted('session', id); await ports.checkNamespace(id);
            if (!sameParents(sessionParents, await ancestors(path))) bad();
            if (raw) { const row = await lstat(path, { bigint: true }); if (!row.isFile() || row.isSymbolicLink() || !same(raw.witness.identity, identity(row))) bad(); }
            for (const key of keys) {
                await ports.checkDeleted('document', key); const doc = ports.document(key), witness = witnesses.get(key);
                if (!sameParents(documentParents.get(key)!, await ancestors(doc))) bad();
                try { const info = await lstat(doc, { bigint: true }); if (!witness || !info.isFile() || info.isSymbolicLink() || !same(witness.identity, identity(info))) bad(); }
                catch (error) { if (witness || (error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') throw error; }
            }
            ports.assertOriginal();
        }
        await cheap();
        const readonlyDocuments = Object.freeze({
            get size() { return documents.size }, get: documents.get.bind(documents), has: documents.has.bind(documents),
            entries: documents.entries.bind(documents), keys: documents.keys.bind(documents), values: documents.values.bind(documents),
            [Symbol.iterator]: documents[Symbol.iterator].bind(documents),
            forEach(callback: (value: { kind: 'absent' } | { kind: 'present'; value: unknown }, key: string, map: ReadonlyMap<string, { kind: 'absent' } | { kind: 'present'; value: unknown }>) => void, thisArg?: unknown) { documents.forEach((value, key) => callback.call(thisArg, value, key, readonlyDocuments)); },
        });
        return { initial, documents: readonlyDocuments,
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
                await cheap();
            },
        };
    }
    return {
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
