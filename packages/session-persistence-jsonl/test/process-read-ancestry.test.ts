import { lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session';
import { createJsonlBackend } from '../src/index.ts';
import { lookupJsonlProcessRead } from '../src/backend-factory.ts';

async function nativeIdentity(path: string) {
    const stat = await lstat(path, { bigint: true });
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

for (const selected of ['absent-document', 'present-document', 'session'] as const) it(`binds the full original parent chain for a nested ${selected}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-path-chain-')), backend = createJsonlBackend(root);
    const nested = join(root, 'a', 'b', 'c', 'd'), key = 'a/b/c/d/selected', id = selected === 'session' ? 'a/b/c/d/s' : 's';
    try {
        await mkdir(nested, { recursive: true });
        await backend.create(id, { sessionId: id, formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        if (selected === 'present-document') await backend.putDocument(key, { value: 'original' });
        const keys = selected === 'session' ? [] : [key], capability = lookupJsonlProcessRead(backend)!;
        const stable = await capability.capture(id, keys);
        if (selected !== 'session') expect(stable.documents.get(key)).toEqual(selected === 'absent-document' ? { kind: 'absent' } : { kind: 'present', value: { value: 'original' } });
        await stable.check(); await stable.finish(); // Distinct nested paths under one shared root remain supported.
        const checked = await capability.capture(id, keys), finished = await capability.capture(id, keys);
        const rootBefore = await nativeIdentity(root), upperBefore = await nativeIdentity(join(root, 'a'));
        const file = selected === 'session' ? join(nested, 's.jsonl') : join(nested, 'selected.doc.jsonl');
        const originalFile = selected === 'absent-document' ? undefined : { identity: await nativeIdentity(file), bytes: await readFile(file) };

        await rename(join(root, 'a', 'b', 'c'), join(root, 'a', 'b', 'old-c'));
        await mkdir(join(root, 'a', 'b', 'c'));
        await rename(join(root, 'a', 'b', 'old-c', 'd'), nested);

        // Replace only a below-root ancestor. Root and upper directory metadata,
        // and the selected original file's native identity/bytes, stay exact.
        expect(await nativeIdentity(root)).toEqual(rootBefore);
        expect(await nativeIdentity(join(root, 'a'))).toEqual(upperBefore);
        if (originalFile) {
            expect(await nativeIdentity(file)).toEqual(originalFile.identity);
            expect(await readFile(file)).toEqual(originalFile.bytes);
        }
        await expect(checked.check()).rejects.toThrow('PROCESS_READ_UNAVAILABLE');
        await expect(finished.finish()).rejects.toThrow('PROCESS_READ_UNAVAILABLE');
        const fresh = await capability.capture(id, keys); await fresh.finish();
    } finally { await rm(root, { recursive: true, force: true }); }
});
