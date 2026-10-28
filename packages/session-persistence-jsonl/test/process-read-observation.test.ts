import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createJsonlBackend } from '../src/index.ts';
import { lookupJsonlProcessRead } from '../src/backend-factory.ts';
import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session';
import * as observationModule from '../src/backend/process-read.ts';

const closeInterposition = vi.hoisted(() => ({ path: '', invalidIdentity: false, run: undefined as undefined | (() => Promise<void>) }));
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
        const stat = await actual.lstat(...args);
        return closeInterposition.invalidIdentity ? Object.assign(stat, { ino: 0n }) : stat;
    }, open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        if (String(args[0]) === closeInterposition.path && closeInterposition.run) {
            const close = handle.close.bind(handle);
            handle.close = async () => { await close(); const run = closeInterposition.run; closeInterposition.run = undefined; await run?.(); };
        }
        return handle;
    } };
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
