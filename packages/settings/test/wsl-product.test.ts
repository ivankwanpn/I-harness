import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { normalizeSettings, SettingsStore, createLayeredStore } from '../src/index.ts';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true }); });
it('defaults new configuration to cached web and Ubuntu without changing native backend', () => {
    expect(normalizeSettings(undefined)).toMatchObject({ windowsSandboxBackend: 'legacy', webSearchMode: 'cached', wslExecution: { distribution: 'Ubuntu', networkAccess: false, workspaceDependencies: true } });
});
it('preserves prior live fetch for old documents and normalizes invalid WSL fields', () => {
    expect(normalizeSettings({ sandboxMode: 'read-only' }).webSearchMode).toBe('live');
    expect(normalizeSettings({ windowsSandboxBackend: 'wsl', webSearchMode: 'indexed', wslExecution: { distribution: ' Debian ', networkAccess: true, workspaceDependencies: false } })).toMatchObject({ windowsSandboxBackend: 'wsl', webSearchMode: 'indexed', wslExecution: { distribution: 'Debian', networkAccess: true, workspaceDependencies: false } });
    expect(normalizeSettings({ webSearchMode: 'unknown', wslExecution: { distribution: 'bad\u0000name', networkAccess: 'true' } })).toMatchObject({ webSearchMode: 'cached', wslExecution: { distribution: 'Ubuntu', networkAccess: false, workspaceDependencies: true } });
});
it('roundtrips WSL fields and migrates older live policy on an unrelated write', async () => {
    await mkdir(resolve('.tmp'), { recursive: true });
    const root = await mkdtemp(resolve('.tmp/wsl-product-settings-store-'));
    roots.push(root);
    const path = join(root, 'settings.json');
    await writeFile(path, JSON.stringify({ sandboxMode: 'read-only', plugins: { webSearch: false } }));
    const old = new SettingsStore({ path });
    await old.load();
    await old.set({ fontSize: 16 });
    expect(JSON.parse(await readFile(path, 'utf8')).webSearchMode).toBe('live');
    await old.set({ windowsSandboxBackend: 'wsl', wslExecution: { distribution: 'Debian', networkAccess: true, workspaceDependencies: false }, webSearchMode: 'disabled' });
    const next = new SettingsStore({ path });
    expect(await next.load()).toMatchObject({ windowsSandboxBackend: 'wsl', webSearchMode: 'disabled', wslExecution: { distribution: 'Debian', networkAccess: true, workspaceDependencies: false }, plugins: { webSearch: false } });
});
it('keeps new layered stores cached across their first unrelated write and preserves older live layers', async () => {
    await mkdir(resolve('.tmp'), { recursive: true });
    const root = await mkdtemp(resolve('.tmp/wsl-product-settings-layered-'));
    roots.push(root);
    const path = join(root, 'settings.json'), store = createLayeredStore({ files: [path], watchIntervalMs: false });
    expect((await store.load()).webSearchMode).toBe('cached');
    await store.set({ fontSize: 16 });
    expect((await store.set({ model: 'fixture' })).webSearchMode).toBe('cached');
    expect((await store.reloadFromDisk()).webSearchMode).toBe('cached');
    await writeFile(path, JSON.stringify({ fontSize: 14 }));
    expect((await store.reloadFromDisk()).webSearchMode).toBe('live');
    await store.set({ fontSize: 18 });
    expect((await store.reloadFromDisk()).webSearchMode).toBe('live');
});
