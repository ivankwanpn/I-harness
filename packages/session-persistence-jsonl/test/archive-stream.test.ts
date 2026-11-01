import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import * as fs from 'node:fs/promises';
import { createJsonlBackend } from '../src/index.ts';
import { createSessionCoordinator } from '@i-harness/session-persistence';
vi.mock('node:fs/promises', async (load) => { const actual = await load<typeof import('node:fs/promises')>(); return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) }; });
const actualOpen = vi.mocked(fs.open).getMockImplementation()!;
const actualReadFile = vi.mocked(fs.readFile).getMockImplementation()!;
afterEach(() => { vi.mocked(fs.open).mockImplementation(actualOpen); vi.mocked(fs.readFile).mockImplementation(actualReadFile); });
async function fixture() { const root = await fs.mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'archive-')); const path = join(root, 'a.jsonl'); await fs.writeFile(path, JSON.stringify({ formatVersion: 1, sessionId: 'a', createdAt: '' }) + '\n' + JSON.stringify({ type: 'user/message', text: '雪' }) + '\n'); return { root, path, backend: createJsonlBackend(root) }; }
it('actual read streams without whole session readFile and preserves literal legacy final lines', async () => {
    const f = await fixture();
    vi.mocked(fs.readFile).mockImplementation(((...args: any[]) => {
        if (args[0] === f.path)
            throw Error('whole-file');
        return (actualReadFile as any)(...args);
    }) as typeof fs.readFile);
    expect((await f.backend.read('a')).events).toEqual([{ type: 'user/message', text: '雪' }]);
    await fs.writeFile(f.path, JSON.stringify({ formatVersion: 1, sessionId: 'a' }));
    expect((await f.backend.read('a')).events).toEqual([]);
});
it('freezes descriptor extent before concurrent append', async () => {
    const f = await fixture();
    let appended = false;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
        const h = await actualOpen(...args);
        if (args[0] === f.path) {
            const read = h.read.bind(h);
            h.read = (async (...a: any[]) => {
                if (!appended) {
                    appended = true;
                    await fs.appendFile(f.path, '{"type":"user/message","text":"late"}\n');
                }
                return (read as any)(...a);
            }) as typeof h.read;
        }
        return h;
    });
    expect((await f.backend.read('a')).events).toEqual([{ type: 'user/message', text: '雪' }]);
});
it('retains failed close through generic coordinator close and retries exact original handle', async () => {
    const f = await fixture(), c = createSessionCoordinator(f.backend);
    let closes = 0;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
        const h = await actualOpen(...args);
        if (args[0] === f.path) {
            const close = h.close.bind(h);
            h.close = async () => {
                closes++;
                if (closes === 1)
                    throw 0;
                await close();
            };
        }
        return h;
    });
    await expect(f.backend.read('a')).rejects.toBeDefined();
    await expect(f.backend.read('a')).rejects.toBeDefined();
    await c.close();
    expect(closes).toBe(2);
});
import { createJsonlSessionCoordinator } from '../src/index.ts';
import { encodeFactBatch, legacyPrefixDigest, readFactJournal, type SessionEvent } from '@i-harness/core-session';
async function managed(version = 14) { const f = await fixture(), previous = legacyPrefixDigest(0, Buffer.alloc(0)), journal = { version: 1 as const, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: previous, separatorBytes: 0 as const }; const frame = Buffer.from(encodeFactBatch('one', previous, [{ type: 'plan/mode', mode: 'on', seq: 0 }]).bytes); await fs.writeFile(f.path, JSON.stringify({ formatVersion: version, sessionId: 'a', journal }) + '\n'); await fs.appendFile(f.path, frame); return { ...f, journal, frame }; }
it.each([6, 7, 8, 9, 10, 11, 12, 13, 14])('actual managed format%s matches original validated events and ignores torn suffix', async (version) => { const f = await managed(version); await fs.appendFile(f.path, '{"unfinished":"雪'); expect((await f.backend.read('a')).events).toEqual(readFactJournal(Buffer.concat([f.frame, Buffer.from('{"unfinished":"雪')]), f.journal, version).events); });
it('rejects complete corruption without mutating the source', async () => { const f = await managed(); await fs.appendFile(f.path, '{}\n'); const before = await fs.readFile(f.path); await expect(f.backend.read('a')).rejects.toThrow(); expect(await fs.readFile(f.path)).toEqual(before); });
it('retains semantic validation after physical frame checks', async () => { const f = await managed(); const bad = encodeFactBatch('bad', f.journal.legacyPrefixDigest, [{ type: 'user/message', text: 'wrong', inputPreparation: { preparationId: 'missing', resultSeq: 0 }, seq: 0 } as unknown as SessionEvent]); await fs.writeFile(f.path, JSON.stringify({ formatVersion: 14, sessionId: 'a', journal: f.journal }) + '\n'); await fs.appendFile(f.path, bad.bytes); await expect(f.backend.read('a')).rejects.toThrow(); });
it('joins a delayed original open before coordinator close resolves', async () => {
    const f = await fixture(), c = createSessionCoordinator(f.backend), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let closes = 0;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
        const h = await actualOpen(...args);
        if (args[0] === f.path) {
            const close = h.close.bind(h);
            h.close = async () => { closes++; await close(); };
            entered.resolve();
            await release.promise;
        }
        return h;
    });
    const read = f.backend.read('a');
    void read.catch(() => { });
    await entered.promise;
    let closed = false;
    const closing = c.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    await expect(read).rejects.toThrow();
    await closing;
    expect(closes).toBe(1);
});
it('keeps consumed falsey close failure unresolved without reopening or successful no-op', async () => {
    const f = await fixture(), c = createSessionCoordinator(f.backend);
    let opens = 0, closes = 0;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
        const h = await actualOpen(...args);
        if (args[0] === f.path) {
            opens++;
            const close = h.close.bind(h);
            h.close = async () => { closes++; await close(); throw undefined; };
        }
        return h;
    });
    await expect(f.backend.read('a')).rejects.toThrow();
    await expect(c.close()).rejects.toThrow();
    await expect(c.close()).rejects.toThrow();
    expect({ opens, closes }).toEqual({ opens: 1, closes: 1 });
});
it('tracks exact read resources in the composed constructor and permits sequential coordinator reuse', async () => { const f = await fixture(); const c = createJsonlSessionCoordinator(f.root); expect((await c.snapshot!('a')).session.events).toHaveLength(1); await c.close(); const one = createSessionCoordinator(f.backend); await one.close(); const two = createSessionCoordinator(f.backend); expect((await f.backend.read('a')).events).toHaveLength(1); await two.close(); });
it('preserves primary and cleanup falsey causes', async () => {
    const f = await fixture();
    vi.mocked(fs.open).mockImplementation(async (...args) => {
        const h = await actualOpen(...args);
        if (args[0] === f.path) {
            h.read = (async () => { throw undefined; }) as typeof h.read;
            const close = h.close.bind(h);
            h.close = async () => { await close(); throw 0; };
        }
        return h;
    });
    const e = await f.backend.read('a').catch(e => e);
    expect(e.errors).toEqual([undefined, 0]);
});
it('qualifies a real semantic birth from the same streamed observation without whole-file acquisition', async () => {
    const f = await fixture();
    const fixturePath = join(import.meta.dirname, 'fixtures/bootstrap13-public');
    for (const name of await fs.readdir(fixturePath))
        await fs.copyFile(join(fixturePath, name), join(f.root, name));
    const path = join(f.root, 'target.jsonl');
    vi.mocked(fs.readFile).mockImplementation(((...args: any[]) => {
        if (args[0] === path)
            throw Error('whole-session birth read');
        return (actualReadFile as any)(...args);
    }) as typeof fs.readFile);
    expect((await f.backend.read('target')).meta?.semanticSeed?.version).toBe(1);
});
it('a partial managed frame is not completed by bytes appended after the frozen extent', async () => {
    const f = await managed();
    await fs.writeFile(f.path, JSON.stringify({ formatVersion: 14, sessionId: 'a', journal: f.journal }) + '\n');
    await fs.appendFile(f.path, f.frame.subarray(0, -1));
    let appended = false;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
        const h = await actualOpen(...args);
        if (args[0] === f.path) {
            const read = h.read.bind(h);
            h.read = (async (...a: any[]) => {
                if (!appended) {
                    appended = true;
                    await fs.appendFile(f.path, '\n');
                }
                return (read as any)(...a);
            }) as typeof h.read;
        }
        return h;
    });
    expect((await f.backend.read('a')).events).toEqual([]);
});
it('refuses premature EOF and closes exactly the original descriptor', async () => {
    const f = await fixture();
    let closed = 0;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
        const h = await actualOpen(...args);
        if (args[0] === f.path) {
            h.read = (async () => ({ bytesRead: 0, buffer: Buffer.alloc(0) })) as typeof h.read;
            const close = h.close.bind(h);
            h.close = async () => { closed++; await close(); };
        }
        return h;
    });
    await expect(f.backend.read('a')).rejects.toThrow('truncated');
    expect(closed).toBe(1);
});
it('shared prefix inspection remains available for an already admitted append while close drains', async () => { const f = await fixture(), c = createSessionCoordinator(f.backend); await c.close(); await f.backend.append('a', [{ type: 'user/message', text: 'original append' }]); const next = createSessionCoordinator(f.backend); expect((await f.backend.read('a')).events).toHaveLength(2); await next.close(); });
import { createLifecycle } from '../../session-persistence/src/coordinator/lifecycle.ts';
import { attachArchiveReadResources } from '../../session-persistence/src/archive-read-internal.ts';
it('original lifecycle joins admitted prefix IO before settling and never releases leases on archive debt', async () => { const f = await fixture(), p = attachArchiveReadResources(f.backend)!; p.fence(); let released = 0, disposed = 0; const lifecycle = createLifecycle({} as any, { releaseHeldLocks() { released++; return []; }, pendingOperations() { return []; } } as any, { flushWriteBehinds() { return [f.backend.append('a', [{ type: 'user/message', text: 'accepted' }])]; }, cancelAutomaticWaits() { }, clearConversationIndexes() { } } as any, { pendingWrites: async () => { }, joinTaskDocumentIO: async () => { }, retryDisposals: async () => { disposed++; } } as any, {} as any); await expect(lifecycle.close(true, async () => { await p.settle(); throw 0; })).rejects.toThrow(); expect({ released, disposed }).toEqual({ released: 0, disposed: 1 }); const c = createSessionCoordinator(f.backend); expect((await f.backend.read('a')).events).toHaveLength(2); await c.close(); });
it('refuses path replacement after reading the original descriptor', async () => {
    const f = await fixture();
    let replaced = false;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
        const h = await actualOpen(...args);
        if (args[0] === f.path) {
            const read = h.read.bind(h);
            h.read = (async (...a: any[]) => {
                if (!replaced) {
                    replaced = true;
                    await fs.rename(f.path, f.path + '.old');
                    await fs.writeFile(f.path, 'replacement');
                }
                return (read as any)(...a);
            }) as typeof h.read;
        }
        return h;
    });
    await expect(f.backend.read('a')).rejects.toThrow('changed');
});
it('uses bounded positional short reads across multibyte text and a record larger than one chunk', async () => {
    const f = await fixture();
    const event = { type: 'user/message', text: '雪'.repeat(50000) };
    await fs.appendFile(f.path, JSON.stringify(event));
    let reads = 0;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
        const h = await actualOpen(...args);
        if (args[0] === f.path) {
            const read = h.read.bind(h);
            h.read = (async (buffer: Buffer, offset: number, length: number, position: number) => { reads++; expect(length).toBeLessThanOrEqual(65536); return read(buffer, offset, Math.min(length, 4093), position); }) as typeof h.read;
        }
        return h;
    });
    expect((await f.backend.read('a')).events.at(-1)).toEqual(event);
    expect(reads).toBeGreaterThan(30);
});
it.each([1, 2, 3, 4, 5])('preserves pre6 format%s malformed-middle stopping and valid final-line behavior', async (version) => { const f = await fixture(); await fs.writeFile(f.path, JSON.stringify({ formatVersion: version, sessionId: 'a' }) + '\n{"type":"user/message","text":"first"}\n{broken\n{"type":"user/message","text":"last"}'); expect((await f.backend.read('a')).events).toEqual([{ type: 'user/message', text: 'first' }]); });
it('matches managed legacy bytes with an explicit separator', async () => { const f = await fixture(), legacy = Buffer.from('{"type":"user/message","text":"雪","seq":0}'), journal = { version: 1 as const, legacyBodyBytes: legacy.length, legacyEventCount: 1, legacyPrefixDigest: legacyPrefixDigest(1, legacy), separatorBytes: 1 as const }; const frame = encodeFactBatch('after', journal.legacyPrefixDigest, [{ type: 'plan/mode', mode: 'on', seq: 1 }]); const body = Buffer.concat([legacy, Buffer.from('\n'), frame.bytes]); await fs.writeFile(f.path, Buffer.concat([Buffer.from(JSON.stringify({ formatVersion: 14, sessionId: 'a', journal }) + '\n'), body])); expect((await f.backend.read('a')).events).toEqual(readFactJournal(body, journal, 14).events); });
it('new coordinator construction cannot reopen admission while original close still joins a read', async () => { const f = await fixture(), first = createSessionCoordinator(f.backend), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); vi.mocked(fs.open).mockImplementation(async (...args) => { const h = await actualOpen(...args); if (args[0] === f.path) {
    entered.resolve();
    await release.promise;
} return h; }); const reading = f.backend.read('a'); void reading.catch(() => { }); await entered.promise; const closing = first.close(); const second = createSessionCoordinator(f.backend); const secondRead = f.backend.read('a'); void secondRead.catch(() => { }); await new Promise<void>(resolve => setImmediate(resolve)); release.resolve(); const outcome = await secondRead.then(() => ({ ok: true, error: undefined }), error => ({ ok: false, error })); await Promise.allSettled([reading, closing]); expect(outcome.ok).toBe(false); vi.mocked(fs.open).mockImplementation(actualOpen); expect((await f.backend.read('a')).events).toHaveLength(1); await second.close(); });
