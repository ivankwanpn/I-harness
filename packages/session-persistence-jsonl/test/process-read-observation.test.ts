import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createJsonlBackend } from '../src/index.ts';
import { lookupJsonlProcessRead } from '../src/backend-factory.ts';
import { CURRENT_FORMAT_VERSION, encodeFactBatch, legacyPrefixDigest } from '@i-harness/core-session';
import { createSessionCoordinator } from '@i-harness/session-persistence';
import * as observationModule from '../src/backend/process-read.ts';

const closeInterposition = vi.hoisted(() => ({ path: '', invalidIdentity: false, statFailure: undefined as undefined | { path: string; value: unknown },
    unchangedTimestamps: undefined as undefined | { path: string; mtimeNs: bigint; ctimeNs: bigint },
    reads: undefined as undefined | { path: string; chunks: { length:number; bytesRead:number }[] },
    run: undefined as undefined | (() => Promise<void>) }));
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    const timestamps = (path: string, stat: BigIntStats) => {
        const prior = closeInterposition.unchangedTimestamps;
        return prior?.path === path ? Object.assign(stat, { mtimeNs: prior.mtimeNs, ctimeNs: prior.ctimeNs }) : stat;
    };
    return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
        if (closeInterposition.statFailure?.path === String(args[0])) throw closeInterposition.statFailure.value;
        const stat = await actual.lstat(...args);
        return closeInterposition.invalidIdentity ? Object.assign(stat, { ino: 0n }) : timestamps(String(args[0]), stat as BigIntStats);
    }, open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        if (closeInterposition.unchangedTimestamps?.path === String(args[0])) {
            const stat = handle.stat.bind(handle);
            handle.stat = (async (options: { bigint: true }) => timestamps(String(args[0]), await stat(options))) as typeof handle.stat;
        }
        const traced = closeInterposition.reads;
        if (traced?.path === String(args[0])) {
            const read = handle.read.bind(handle);
            handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
                const result = await read(buffer, offset, length, position);
                traced.chunks.push({ length, bytesRead: result.bytesRead });
                return result;
            }) as typeof handle.read;
        }
        if (String(args[0]) === closeInterposition.path && closeInterposition.run) {
            const close = handle.close.bind(handle);
            handle.close = async () => { await close(); const run = closeInterposition.run; closeInterposition.run = undefined; await run?.(); };
        }
        return handle;
    } };
});

it('reuses only finished cold transcript data and still observes the selected documents fresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-cold-reuse-')), backend = createJsonlBackend(root);
    const path = join(root, 's.jsonl');
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        const batch = encodeFactBatch('observed-transcript', legacyPrefixDigest(0, new Uint8Array()), [
            { type: 'tool/call', seq: 0, callId: 'read', name: 'read', args: { nested: { text: 'x'.repeat(131072) } } },
        ]);
        await appendFile(path, batch.bytes);
        await backend.putDocument('one', { value: 'first' });
        await backend.putDocument('two', { value: 'second' });
        const capability = lookupJsonlProcessRead(backend)!;
        const first = await capability.capture('s', ['one']);
        const premature = await capability.capture('s', []);
        expect(first.reusableInitial).toBe(true);
        expect(capability.recognizesDecodedProcessHistory('s', first.initial)).toBe(true);
        expect(capability.recognizesDecodedProcessHistory('wrong-session', first.initial)).toBe(false);
        expect(capability.recognizesDecodedProcessHistory('s', Object.freeze({ ...first.initial }))).toBe(false);
        expect(premature.initial).not.toBe(first.initial);
        await first.finish();
        const size = (await readFile(path)).length;
        const trace = { path, chunks: [] as { length:number; bytesRead:number }[] };
        closeInterposition.reads = trace;
        const next = await capability.capture('s', ['two']);
        expect(next.reusableInitial).toBe(true);
        expect(next.initial).toBe(first.initial);
        expect(capability.recognizesDecodedProcessHistory('s', next.initial)).toBe(true);
        expect(Object.isFrozen(next.initial.events)).toBe(true);
        const event = next.initial.events[0];
        if (event?.type !== 'tool/call') throw new Error('Missing original nested tool call');
        expect(Object.isFrozen((event.args as { nested: object }).nested)).toBe(true);
        expect(next.documents.has('one')).toBe(false);
        expect(next.documents.get('two')).toEqual({ kind: 'present', value: { value: 'second' } });
        expect(trace.chunks.reduce((sum, chunk) => sum + chunk.bytesRead, 0)).toBe(size);
        await next.finish();
        expect(trace.chunks.reduce((sum, chunk) => sum + chunk.bytesRead, 0)).toBe(2 * size);
        expect(trace.chunks.every(chunk => chunk.length <= 65536)).toBe(true);
    } finally { closeInterposition.reads = undefined; await rm(root, { recursive: true, force: true }); }
});

it('keeps ordinary Process validation when the serializer changes or original history has a predecessor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-cold-decode-fallback-')), backend = createJsonlBackend(root);
    try {
        await backend.create('native', { sessionId: 'native', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        const capability = lookupJsonlProcessRead(backend)!, native = await capability.capture('native', []);
        expect(capability.recognizesDecodedProcessHistory('native', native.initial)).toBe(true);
        await native.finish();
        const serialize = vi.spyOn(JSON, 'stringify');
        const fallback = await (async () => {
            try {
                expect(capability.recognizesDecodedProcessHistory('native', native.initial)).toBe(false);
                return await capability.capture('native', []);
            } finally { serialize.mockRestore(); }
        })();
        expect(fallback.initial).not.toBe(native.initial);
        expect(capability.recognizesDecodedProcessHistory('native', fallback.initial)).toBe(false);
        expect(fallback.initial.events).toEqual(native.initial.events);
        await fallback.finish();

        const event = { type: 'user/message', seq: 0, text: 'valid predecessor' };
        const body = Buffer.from(JSON.stringify(event) + '\n');
        const header = { sessionId: 'legacy', formatVersion: CURRENT_FORMAT_VERSION, journal: {
            version: 1, legacyBodyBytes: body.length, legacyEventCount: 1,
            legacyPrefixDigest: legacyPrefixDigest(1, body), separatorBytes: 0,
        } };
        await writeFile(join(root, 'legacy.jsonl'), Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), body]));
        const legacy = await capability.capture('legacy', []);
        expect(legacy.initial.events).toEqual([event]);
        expect(capability.recognizesDecodedProcessHistory('legacy', legacy.initial)).toBe(false);
        await legacy.finish();
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('does not enroll a native transcript with a malformed conversation graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-cold-native-graph-')), backend = createJsonlBackend(root);
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        const invalid = encodeFactBatch('duplicate-fence', legacyPrefixDigest(0, new Uint8Array()), [
            { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1', seq: 0 },
            { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1', seq: 1 },
        ]);
        const path = join(root, 's.jsonl'), header = await readFile(path);
        await appendFile(path, invalid.bytes);
        await expect(lookupJsonlProcessRead(backend)!.capture('s', [])).rejects.toMatchObject({
            code: 'SESSION_CONVERSATION_FORMAT', message: expect.stringMatching(/duplicate semantics fence/),
        });
        expect(await readFile(path)).toEqual(Buffer.concat([header, invalid.bytes]));
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('uses a full digest rather than unchanged inode, extent and timestamps for a candidate hit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-cold-hit-digest-')), backend = createJsonlBackend(root);
    const path = join(root, 's.jsonl');
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z', title: 'before' });
        const capability = lookupJsonlProcessRead(backend)!, original = await capability.capture('s', []);
        await original.finish();
        const { lstat } = await import('node:fs/promises'), stats = await lstat(path, { bigint: true });
        const before = await readFile(path, 'utf8'), changed = before.replace('"before"', '"change"');
        expect(changed).not.toBe(before);
        expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(before));
        await writeFile(path, changed);
        closeInterposition.unchangedTimestamps = { path, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs };
        const next = await capability.capture('s', []);
        expect(next.initial).not.toBe(original.initial);
        expect(next.initial.header).toMatchObject({ title: 'change' });
        await next.finish();
        const reused = await capability.capture('s', []);
        expect(reused.initial).toBe(next.initial);
        await reused.finish();
    } finally { closeInterposition.unchangedTimestamps = undefined; await rm(root, { recursive: true, force: true }); }
});

it('does not treat a cache-hit descriptor close failure as a miss', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-cold-hit-close-')), backend = createJsonlBackend(root);
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        const capability = lookupJsonlProcessRead(backend)!, original = await capability.capture('s', []);
        await original.finish();
        closeInterposition.path = join(root, 's.jsonl');
        closeInterposition.run = async () => { throw new Error('injected transcript descriptor close failure'); };
        await expect(capability.capture('s', [])).rejects.toThrow('injected transcript descriptor close failure');
    } finally { closeInterposition.run = undefined; await rm(root, { recursive: true, force: true }); }
});

it('retires both the cached transcript and unfinished observations with the original read fence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-cold-reuse-fence-')), backend = createJsonlBackend(root);
    const firstCoordinator = createSessionCoordinator(backend);
    try {
        await firstCoordinator.create({ sessionId: 's' });
        const capability = lookupJsonlProcessRead(backend)!, first = await capability.capture('s', []);
        await first.finish();
        const pending = await capability.capture('s', []);
        expect(pending.initial).toBe(first.initial);
        await firstCoordinator.close();
        expect(capability.recognizesDecodedProcessHistory('s', pending.initial)).toBe(false);
        await expect(pending.finish()).rejects.toThrow();
        const nextCoordinator = createSessionCoordinator(backend);
        try {
            const next = await capability.capture('s', []);
            expect(next.initial).not.toBe(first.initial);
            await next.finish();
        } finally { await nextCoordinator.close(); }
    } finally { await firstCoordinator.close(); await rm(root, { recursive: true, force: true }); }
});

for (const cause of [null, undefined]) it(`preserves a thrown ${String(cause)} document failure instead of treating it as absence`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-falsey-doc-')), backend = createJsonlBackend(root);
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        await backend.putDocument('task-s', { value: 'original' });
        closeInterposition.statFailure = { path: join(root, 'task-s.doc.jsonl'), value: cause };
        await expect(lookupJsonlProcessRead(backend)!.capture('s', ['task-s'])).rejects.toBe(cause);
    } finally { closeInterposition.statFailure = undefined; await rm(root, { recursive: true, force: true }); }
});

it('refuses a store reached through a junction above its configured root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ih-parent-link-'));
    try {
        await mkdir(join(parent, 'target')); await symlink(join(parent, 'target'), join(parent, 'alias'), 'junction');
        const backend = createJsonlBackend(join(parent, 'alias', 'store'));
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        await expect(lookupJsonlProcessRead(backend)!.capture('s', [])).rejects.toThrow();
    } finally { await rm(parent, { recursive: true, force: true }); }
});

it('rejects unavailable native identity and replacement of the original store root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ih-root-identity-')), root = join(parent, 'store'), backend = createJsonlBackend(root);
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        closeInterposition.invalidIdentity = true;
        await expect(lookupJsonlProcessRead(backend)!.capture('s', [])).rejects.toThrow();
        closeInterposition.invalidIdentity = false;
        const observation = await lookupJsonlProcessRead(backend)!.capture('s', []), bytes = await readFile(join(root, 's.jsonl'));
        await rename(root, join(parent, 'old')); await mkdir(root); await writeFile(join(root, 's.jsonl'), bytes);
        await expect(observation.finish()).rejects.toThrow();
    } finally { closeInterposition.invalidIdentity = false; await rm(parent, { recursive: true, force: true }); }
});

it('cannot associate an arbitrary backend through an externally callable registrar', () => {
    const fake = {}, register = (observationModule as unknown as { registerJsonlProcessRead?: (...args: unknown[]) => void }).registerJsonlProcessRead;
    register?.(fake, { root: 'D:/fake', file: () => 'D:/fake/s', document: () => 'D:/fake/d', checkNamespace: async () => {}, checkDeleted: async () => {} });
    expect(lookupJsonlProcessRead(fake)).toBeUndefined();
});

it('rejects replaced original backend methods without invoking getters or reviving the observation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-backend-method-')), backend = createJsonlBackend(root);
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        const capability = lookupJsonlProcessRead(backend)!, observation = await capability.capture('s', []), original = backend.read;
        expect(() => Object.defineProperty(capability, 'capture', { value: async () => { throw new Error('forged capture'); } })).toThrow();
        let getters = 0;
        Object.defineProperty(backend, 'read', { configurable: true, get() { getters++; return original; } });
        expect(lookupJsonlProcessRead(backend)).toBeUndefined();
        await expect(observation.check()).rejects.toThrow(); expect(getters).toBe(0);
        Object.defineProperty(backend, 'read', { configurable: true, writable: true, enumerable: true, value: original });
        await expect(observation.finish()).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
});

for (const kind of ['namespace', 'session-tombstone', 'document-tombstone', 'close-failure'] as const) it(`rejects ${kind} introduced during final verification resource close`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-final-gate-')), backend = createJsonlBackend(root);
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        await backend.putDocument('task-s', { value: 'stable' });
        const observation = await lookupJsonlProcessRead(backend)!.capture('s', ['task-s']);
        const { createHash } = await import('node:crypto');
        const marker = kind === 'namespace' ? join(root, 's.jsonl.bootstrap-unknown')
            : join(root, `desktop-deleted-${kind === 'document-tombstone' ? 'document' : 'session'}-${createHash('sha256').update(kind === 'document-tombstone' ? 'task-s' : 's').digest('hex')}.tombstone`);
        closeInterposition.path = join(root, 'task-s.doc.jsonl');
        closeInterposition.run = async () => { if (kind === 'close-failure') throw new Error('injected close failure'); await writeFile(marker, 'retired'); };
        await expect(observation.finish()).rejects.toThrow();
        await expect(observation.finish()).rejects.toThrow();
    } finally { closeInterposition.run = undefined; await rm(root, { recursive: true, force: true }); }
});

it('uses a genuine backend to capture once and detect same-length replacement at finish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-cold-')), backend = createJsonlBackend(root);
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        const capability = lookupJsonlProcessRead(backend)!;
        expect(lookupJsonlProcessRead({ ...backend })).toBeUndefined();
        expect(lookupJsonlProcessRead(new Proxy(backend, {}))).toBeUndefined();
        const observation = await capability.capture('s', ['task-s']);
        expect(observation.initial.events).toEqual([]);
        expect(observation.documents.get('task-s')).toEqual({ kind: 'absent' });
        const path = join(root, 's.jsonl'), bytes = await readFile(path), changed = Buffer.from(bytes);
        const index = changed.indexOf(Buffer.from('2026-01-01')); changed[index + 9] = '2'.charCodeAt(0);
        await writeFile(path, changed);
        await expect(observation.finish()).rejects.toThrow();
        await expect(observation.finish()).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects torn journal data and a newly present observed document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-cold-domain-')), backend = createJsonlBackend(root);
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        const capability = lookupJsonlProcessRead(backend)!;
        const observation = await capability.capture('s', ['task-s']);
        await backend.putDocument('task-s', { x: 1 });
        await expect(observation.finish()).rejects.toThrow();
        await appendFile(join(root, 's.jsonl'), '{"unfinished":');
        await expect(capability.capture('s', [])).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('refuses bootstrap namespace and invalid UTF-8 without repair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-cold-unsupported-')), backend = createJsonlBackend(root);
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        const capability = lookupJsonlProcessRead(backend)!, path = join(root, 's.jsonl');
        await writeFile(`${path}.bootstrap-unknown`, 'x');
        await expect(capability.capture('s', [])).rejects.toThrow();
        await rm(`${path}.bootstrap-unknown`); await appendFile(path, Buffer.from([0xff, 10]));
        const before = await readFile(path);
        await expect(capability.capture('s', [])).rejects.toThrow();
        expect(await readFile(path)).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('verifies stable present documents and rejects concurrent checks permanently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-cold-stable-')), backend = createJsonlBackend(root);
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        await backend.putDocument('task-s', { nested: { value: 1 } });
        const capability = lookupJsonlProcessRead(backend)!, first = await capability.capture('s', ['task-s', 'task-s']);
        expect(first.documents.size).toBe(1); expect(Object.isFrozen(first.documents.get('task-s'))).toBe(true);
        await first.check(); await first.finish(); await expect(first.finish()).rejects.toThrow();
        const second = await capability.capture('s', []), check = second.check();
        await expect(second.check()).rejects.toThrow(); await check; await expect(second.finish()).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('observes managed auxiliary documents with a bounded domain header and no history decoding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-aux-')), backend = createJsonlBackend(root);
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        await backend.putDocument('task-s', { value: 7 });
        const capability = lookupJsonlProcessRead(backend)!;
        // Managed authority comes from the held live document. Only the raw
        // header is consulted for domain refusal, never this invalid body.
        await appendFile(join(root, 's.jsonl'), 'invalid journal body\n');
        const witness = await capability.captureManagedAuxiliary('s', ['task-s']);
        expect(witness.documents.get('task-s')).toEqual({ kind: 'present', value: { value: 7 } });
        await witness.check(); await witness.finish();
        const changed = await capability.captureManagedAuxiliary('s', ['task-s']);
        await backend.putDocument('task-s', { value: 8 });
        await expect(changed.check()).rejects.toThrow(); await expect(changed.finish()).rejects.toThrow();
        const namespaced = await capability.captureManagedAuxiliary('s', []);
        await writeFile(join(root, 's.jsonl.bootstrap-unknown'), 'x');
        await expect(namespaced.finish()).rejects.toThrow();
        await expect(capability.capture('s', [])).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('captures genuine ordinary event bytes and refuses malformed middle records without rewriting them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-journal-domain-')), backend = createJsonlBackend(root);
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        await backend.append('s', [{ type: 'turn/start', seq: 0 }, { type: 'turn/end', seq: 1 }]);
        const capability = lookupJsonlProcessRead(backend)!, path = join(root, 's.jsonl');
        const observation = await capability.capture('s', []);
        expect(observation.initial.events.map(event => event.type)).toEqual(['turn/start', 'turn/end']);
        expect(Object.isFrozen(observation.initial.events)).toBe(true);
        await observation.finish();
        const bytes = await readFile(path), end = bytes.indexOf(10);
        const changed = Buffer.concat([bytes.subarray(0, end + 1), Buffer.from('{broken}\n'), bytes.subarray(end + 1)]);
        await writeFile(path, changed);
        await expect(capability.capture('s', [])).rejects.toThrow();
        expect(await readFile(path)).toEqual(changed);
    } finally { await rm(root, { recursive: true, force: true }); }
});
