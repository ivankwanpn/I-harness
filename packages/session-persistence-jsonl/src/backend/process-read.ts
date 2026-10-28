import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import type { Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CURRENT_FORMAT_VERSION, freezeJsonData, readFactJournal } from '@i-harness/core-session';
import { parseHeader } from '../format.ts';

type Identity = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
type Witness = { path: string; identity: Identity; digest: string };
type Ports = { root: string; file(id: string): string; document(key: string): string; checkNamespace(id: string): Promise<void>; checkDeleted(kind: string, id: string): Promise<void> };
const owners = new WeakMap<object, ReturnType<typeof createCapability>>();
export function lookupJsonlProcessRead(backend: object) { return owners.get(backend); }
/** Internal factory registration; never surfaced through the public backend. */
export function registerJsonlProcessRead(backend: object, ports: Ports) { owners.set(backend, createCapability(ports)); }
const bad = (): never => { throw new Error('PROCESS_READ_UNAVAILABLE'); };
const identity = (stat: Stats): Identity => {
    if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino) || stat.ino <= 0 || !Number.isSafeInteger(stat.size)) return bad();
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
};
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function createCapability(ports: Ports) {
    async function ancestors(path: string) {
        let parent = dirname(path), root: Identity | undefined;
        for (;;) {
            const info = await lstat(parent);
            if (!info.isDirectory() || info.isSymbolicLink()) bad();
            if (parent === ports.root) { root = identity(info); break; }
            const next = dirname(parent); if (next === parent) bad(); parent = next;
        }
        return root!;
    }
    async function file(path: string): Promise<{ bytes: Buffer; witness: Witness }> {
        await ancestors(path);
        const before = await lstat(path); if (!before.isFile() || before.isSymbolicLink()) bad();
        const first = identity(before), handle = await open(path, 'r');
        try {
            if (!same(first, identity(await handle.stat()))) bad();
            const bytes = Buffer.alloc(first.size + 1); let offset = 0;
            while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
            if (offset !== first.size || !same(first, identity(await handle.stat())) || !same(first, identity(await lstat(path)))) bad();
            return { bytes: bytes.subarray(0, first.size), witness: { path, identity: first, digest: hash(bytes.subarray(0, first.size)) } };
        } finally { await handle.close(); }
    }
    async function verify(w: Witness, root: Identity) {
        if (!same(root, await ancestors(w.path))) bad();
        const before = await lstat(w.path); if (!before.isFile() || before.isSymbolicLink() || !same(w.identity, identity(before))) bad();
        const handle: FileHandle = await open(w.path, 'r');
        try {
            if (!same(w.identity, identity(await handle.stat()))) bad();
            const digest = createHash('sha256'), buffer = Buffer.alloc(65536); let offset = 0;
            while (offset <= w.identity.size) {
                const length = Math.min(buffer.length, w.identity.size + 1 - offset), read = await handle.read(buffer, 0, length, offset);
                if (!read.bytesRead) break; digest.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead;
            }
            if (offset !== w.identity.size || digest.digest('hex') !== w.digest || !same(w.identity, identity(await handle.stat())) || !same(w.identity, identity(await lstat(w.path))) || !same(root, await ancestors(w.path))) bad();
        } finally { await handle.close(); }
    }
    return { async capture(id: string, requested: readonly string[]) {
        const keys = [...new Set(requested)].sort(); if (keys.length > 32) bad();
        const path = ports.file(id), root = await ancestors(path);
        await ports.checkDeleted('session', id); await ports.checkNamespace(id);
        const raw = await file(path), decoder = new TextDecoder('utf-8', { fatal: true });
        if (!isUtf8(raw.bytes)) bad();
        const end = raw.bytes.indexOf(10); if (end < 0 || raw.bytes.at(-1) !== 10) bad();
        const meta = parseHeader(decoder.decode(raw.bytes.subarray(0, end)));
        if (meta.formatVersion !== CURRENT_FORMAT_VERSION || meta.semanticSeed || !meta.journal) bad();
        const decoded = readFactJournal(raw.bytes.subarray(end + 1), meta.journal!, meta.formatVersion, meta);
        if (decoded.torn || decoded.prefix.bodyBytes !== raw.bytes.length - end - 1) bad();
        const documents = new Map<string, { kind: 'absent' } | { kind: 'present'; value: unknown }>(), witnesses = new Map<string, Witness>();
        for (const key of keys) {
            await ports.checkDeleted('document', key); const doc = ports.document(key);
            if (!same(root, await ancestors(doc))) bad();
            try { const captured = await file(doc); documents.set(key, Object.freeze({ kind: 'present', value: freezeJsonData(JSON.parse(decoder.decode(captured.bytes))) })); witnesses.set(key, captured.witness); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; if (!same(root, await ancestors(doc))) bad(); await ports.checkDeleted('document', key); documents.set(key, Object.freeze({ kind: 'absent' })); }
        }
        let finished = false, checking = false, failed = false;
        async function cheap() {
            await ports.checkDeleted('session', id); await ports.checkNamespace(id);
            if (!same(root, await ancestors(path))) bad();
            const row = await lstat(path); if (!row.isFile() || row.isSymbolicLink() || !same(raw.witness.identity, identity(row))) bad();
            for (const key of keys) {
                await ports.checkDeleted('document', key); const doc = ports.document(key), witness = witnesses.get(key);
                if (!same(root, await ancestors(doc))) bad();
                try { const info = await lstat(doc); if (!witness || !info.isFile() || info.isSymbolicLink() || !same(witness.identity, identity(info))) bad(); }
                catch (error) { if (witness || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            }
        }
        await cheap();
        const readonlyDocuments = Object.freeze({
            get size() { return documents.size }, get: documents.get.bind(documents), has: documents.has.bind(documents),
            entries: documents.entries.bind(documents), keys: documents.keys.bind(documents), values: documents.values.bind(documents),
            [Symbol.iterator]: documents[Symbol.iterator].bind(documents),
            forEach(callback: (value: { kind: 'absent' } | { kind: 'present'; value: unknown }, key: string) => void) { documents.forEach((value, key) => callback(value, key)); },
        });
        return { initial: freezeJsonData({ formatVersion: meta.formatVersion, header: meta, events: decoded.events }), documents: readonlyDocuments,
            async check() {
                if (finished || checking || failed) { failed = true; bad(); }
                checking = true; try { await cheap(); } catch (error) { failed = true; throw error; } finally { checking = false; }
            },
            async finish() {
                if (finished || checking || failed) { failed = true; bad(); } finished = true;
                await cheap();
                await ports.checkDeleted('session', id); await ports.checkNamespace(id); await verify(raw.witness, root);
                for (const key of keys) {
                    await ports.checkDeleted('document', key); const witness = witnesses.get(key), doc = ports.document(key);
                    if (witness) await verify(witness, root);
                    else { if (!same(root, await ancestors(doc))) bad(); try { await lstat(doc); bad(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
                }
            },
        };
    } };
}
