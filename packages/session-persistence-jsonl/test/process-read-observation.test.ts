import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createJsonlBackend } from '../src/index.ts';
import { lookupJsonlProcessRead } from '../src/backend/process-read.ts';
import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session';

it('uses a genuine backend to capture once and detect same-length replacement at finish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-cold-')), backend = createJsonlBackend(root);
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        const capability = lookupJsonlProcessRead(backend)!;
        expect(lookupJsonlProcessRead({ ...backend })).toBeUndefined();
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
