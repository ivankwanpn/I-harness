import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAgentSettings } from '../src/agent-settings.ts';
import { createWslSettings } from '../src/wsl-settings.ts';
const roots: string[] = [];
async function fixture() { await mkdir(resolve('.tmp'), { recursive: true }); const root = await mkdtemp(resolve('.tmp/wsl-product-settings-gateway-')); roots.push(root); return join(root, 'settings.json'); }
afterEach(async () => { for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true }); });
const startup = { windowsSandboxBackend: 'legacy' as const, sandboxMode: 'workspace-write' as const, autoCompaction: true, approvalMode: 'dangerous' as const, wslExecution: { distribution: 'Ubuntu', networkAccess: false, workspaceDependencies: true }, webSearchMode: 'cached' as const };
it('drains an explicit repair before closing and refuses later work', async () => {
    const path = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const adapter = createWslSettings(path, { repairDependencies: async () => { entered.resolve(); await release.promise; return { status: 'available', detail: 'ready' }; } });
    const repairing = adapter.repair();
    await entered.promise;
    let drained = false;
    const closing = adapter.close().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(adapter.repair()).rejects.toThrow(/closed/i);
    release.resolve();
    await Promise.all([repairing, closing]);
    expect(drained).toBe(true);
});
it('applies captured defaults for new assemblies and reports existing execution unchanged', async () => {
    const path = await fixture();
    const wsl = vi.fn();
    const web = vi.fn();
    const backend = vi.fn();
    const settings = createAgentSettings(path, startup, { onWindowsSandboxBackendChanged: backend, onWslExecutionChanged: wsl, onWebSearchModeChanged: web, executionStatus: async () => [{ sessionId: 'running', status: { backend: 'legacy' } }] });
    const next = await settings.configure({ windowsSandboxBackend: 'wsl', wslExecution: { distribution: 'Debian', networkAccess: true, workspaceDependencies: false }, webSearchMode: 'indexed' });
    expect(next).toMatchObject({ saved: { windowsSandboxBackend: 'wsl', webSearchMode: 'indexed' }, effective: { windowsSandboxBackend: 'wsl', wslExecution: { distribution: 'Debian', networkAccess: true, workspaceDependencies: false } }, restartRequired: false, executions: [{ sessionId: 'running', status: { backend: 'legacy' } }] });
    expect(backend).toHaveBeenCalledWith('wsl');
    expect(wsl).toHaveBeenCalledWith({ distribution: 'Debian', networkAccess: true, workspaceDependencies: false });
    expect(web).toHaveBeenCalledWith('indexed');
    expect(JSON.parse(await readFile(path, 'utf8')).webSearchMode).toBe('indexed');
});
it('keeps a saved web choice pending without a real callback and validates nested fields', async () => {
    const path = await fixture();
    const settings = createAgentSettings(path, startup);
    expect(await settings.configure({ webSearchMode: 'disabled' })).toMatchObject({ saved: { webSearchMode: 'disabled' }, effective: { webSearchMode: 'cached' }, restartRequired: true });
    for (const patch of [{ wslExecution: { distribution: 'Ubuntu', networkAccess: 'yes', workspaceDependencies: true } }, { wslExecution: { distribution: '', networkAccess: false, workspaceDependencies: true } }, { wslExecution: { distribution: 'Ubuntu', networkAccess: false, workspaceDependencies: true, extra: 1 } }, { webSearchMode: 'automatic' }])
        await expect(settings.configure(patch)).rejects.toThrow();
    await writeFile(path, JSON.stringify({ windowsSandboxBackend: 'wsl', wslExecution: { distribution: 'Ubuntu', networkAccess: 'yes' }, webSearchMode: 'disabled' }));
    await expect(settings.state()).rejects.toThrow(/WSL/i);
});

it.each(['windowsSandboxBackend', 'webSearchMode', 'sandboxMode', 'approvalMode'])('rejects array policy values in %s instead of normalizing them to defaults', async (field) => {
    const path = await fixture();
    const values: Record<string, string> = {windowsSandboxBackend: 'wsl', webSearchMode: 'disabled', sandboxMode: 'read-only', approvalMode: 'dangerous'};
    await writeFile(path, JSON.stringify({[field]: [values[field]]}));
    await expect(createAgentSettings(path, startup).state()).rejects.toThrow(/Invalid/i);
});
it('does not probe legacy reads; diagnostics and explicit repair report actual state', async () => {
    const path = await fixture();
    await writeFile(path, JSON.stringify({ windowsSandboxBackend: 'wsl', wslExecution: startup.wslExecution }));
    const inspect = vi.fn(async (distribution: string) => ({ distribution, available: false, detail: 'bubblewrap missing', dependencies: { bash: { available: true }, bubblewrap: { available: false } }, paths: [] }));
    const repair = vi.fn(async () => ({ status: 'available' as const, detail: 'Managed runtime ready' }));
    const adapter = createWslSettings(path, { listDistributions: async () => [{ name: 'Ubuntu', version: 2, state: 'Stopped' }], inspectRuntime: inspect, repairDependencies: repair });
    expect(await adapter.state()).toMatchObject({ selected: startup.wslExecution, capabilities: { diagnose: true, repair: true } });
    expect(inspect).not.toHaveBeenCalled();
    expect(await adapter.diagnose()).toMatchObject({ runtime: { available: false, detail: 'bubblewrap missing' }, distributions: [{ name: 'Ubuntu', version: 2 }] });
    expect(await adapter.repair()).toMatchObject({ managedDependencies: { status: 'available' } });
    expect(repair).toHaveBeenCalledWith(startup.wslExecution);
    await writeFile(path, JSON.stringify({ wslExecution: { ...startup.wslExecution, workspaceDependencies: false } }));
    await expect(adapter.repair()).rejects.toThrow(/disabled/i);
    expect(repair).toHaveBeenCalledTimes(1);
});
it('reports unsupported actions truthfully and preserves diagnostics errors', async () => {
    const path = await fixture();
    const adapter = createWslSettings(path);
    expect(await adapter.state()).toMatchObject({ capabilities: { diagnose: false, repair: false } });
    await expect(adapter.diagnose()).rejects.toThrow(/unavailable/i);
    await expect(adapter.repair()).rejects.toThrow(/unavailable/i);
    const fail = createWslSettings(path, { listDistributions: async () => { throw new Error('WSL unavailable'); }, inspectRuntime: async () => { throw new Error('probe failed'); } });
    await expect(fail.diagnose()).rejects.toThrow('WSL unavailable');
});
it('does not attach diagnostic or repair results to a changed configuration', async () => {
    const path = await fixture();
    await writeFile(path, JSON.stringify({ wslExecution: startup.wslExecution }));
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const adapter = createWslSettings(path, { listDistributions: async () => [{ name: 'Ubuntu', version: 2, state: 'Running' }], inspectRuntime: async (distribution) => ({ distribution, available: true, detail: 'ready', dependencies: {}, paths: [] }), repairDependencies: async () => { entered.resolve(); await gate.promise; return { status: 'available', detail: 'ready' }; } });
    await adapter.diagnose();
    await writeFile(path, JSON.stringify({ wslExecution: { ...startup.wslExecution, workspaceDependencies: false } }));
    expect(await adapter.state()).not.toHaveProperty('runtime');
    await writeFile(path, JSON.stringify({ wslExecution: startup.wslExecution }));
    const repairing = adapter.repair();
    await entered.promise;
    await writeFile(path, JSON.stringify({ wslExecution: { ...startup.wslExecution, distribution: 'Debian' } }));
    gate.resolve();
    expect(await repairing).toMatchObject({ selected: { distribution: 'Debian' } });
    expect(await adapter.state()).not.toHaveProperty('managedDependencies');
});
