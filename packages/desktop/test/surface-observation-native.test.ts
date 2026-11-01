import { expect, it, vi } from 'vitest';
import { createNativeSurfaceObservation } from '../src/main/surface-observation.ts';
import type { WorkspaceRuntime } from '../src/main/sdk-runtime.ts';
import { createWorkspaceRuntimeManager } from '../src/main/sdk-runtime.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
it('issues native serial keys, retries a lost ACK with the same key and refuses foreign window and replaced runtime tokens', async () => {
    let count = 0;
    const request = vi.fn(async (method: string, p: any) => { if (method.endsWith('subscribe') && !method.endsWith('unsubscribe')) {
        if (++count === 1)
            throw Error('request timed out');
        return { subscriptionId: 'token', requestKey: p.requestKey, scope: { surface: 'execution', sessionId: p.sessionId }, stamp: { epoch: 'epoch', revision: 0 } };
    } return { unsubscribed: true }; });
    const runtime = { client: { request }, info: { capabilities: { 'desktop-surface-events': ['1'] } } } as unknown as WorkspaceRuntime;
    let current = runtime;
    const a = createNativeSurfaceObservation(async () => runtime, () => current, () => { }), b = createNativeSurfaceObservation(async () => runtime, () => current, () => { });
    try {
        const lease = await a.request({ kind: 'desktop/surface/subscribe', workspaceId: 'w', sessionId: 's', surface: 'execution' }) as any;
        expect(request.mock.calls.slice(0, 2).map(([, p]) => p.requestKey)).toEqual(['r1:1', 'r1:1']);
        await expect(b.request({ kind: 'desktop/surface/snapshot', workspaceId: 'w', subscriptionId: lease.subscriptionId, epoch: 'epoch' })).rejects.toThrow('window token');
        current = { ...runtime };
        await expect(a.request({ kind: 'desktop/surface/snapshot', workspaceId: 'w', subscriptionId: 'token', epoch: 'epoch' })).rejects.toThrow('runtime retired');
    }
    finally {
        current = runtime;
        await a.close();
        await b.close();
    }
});
it('retains disconnected native cleanup after client.close fulfills until the exact original launched exit', async () => {
    const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'surface-exit-')), exited = Promise.withResolvers<void>();
    const request = vi.fn(async (method: string, p: any) => method === 'desktop/surface/subscribe' ? { subscriptionId: 'old-token', requestKey: p.requestKey, scope: { surface: 'execution', sessionId: 's' }, stamp: { epoch: 'old-epoch', revision: 0 } } : { unsubscribed: true }), client = { initialize: async () => ({ protocolVersion: 3, capabilities: { 'desktop-surface-events': ['1'] } }), request, onNotification: () => () => { }, close: vi.fn(async () => { }) };
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: root, launch: () => ({ client: client as never, exited: exited.promise }) }), workspace = { id: 'w', label: 'fixture', path: root }, owner = createNativeSurfaceObservation(() => manager.get(workspace), id => manager.peek!(id), () => { });
    try {
        await owner.request({ kind: 'desktop/surface/subscribe', workspaceId: 'w', surface: 'execution', sessionId: 's' });
        await manager.invalidate!('w');
        expect(client.close).toHaveBeenCalledTimes(1);
        const before = request.mock.calls.length;
        let settled = false;
        const closing = owner.close().then(() => { settled = true; });
        await new Promise(resolve => setImmediate(resolve));
        expect(settled).toBe(false);
        await expect(owner.request({ kind: 'desktop/surface/snapshot', workspaceId: 'w', subscriptionId: 'old-token', epoch: 'old-epoch' })).rejects.toThrow();
        expect(request.mock.calls).toHaveLength(before);
        exited.resolve();
        await closing;
        expect(settled).toBe(true);
        expect(request.mock.calls).toHaveLength(before);
    }
    finally {
        exited.resolve();
        await owner.close();
        await manager.close();
        await rm(root, { recursive: true, force: true });
    }
});
it('charges native pending runtime acquisitions before awaits and refuses renderer keys', async () => {
    const ready = Promise.withResolvers<WorkspaceRuntime>(), owner = createNativeSurfaceObservation(() => ready.promise, () => undefined, () => { });
    const flights = Array.from({ length: 32 }, () => owner.request({ kind: 'desktop/surface/subscribe', workspaceId: 'w', sessionId: 's', surface: 'execution' }).catch(error => error));
    await expect(owner.request({ kind: 'desktop/surface/subscribe', workspaceId: 'w', sessionId: 's', surface: 'execution' })).rejects.toThrow();
    await expect(owner.request({ kind: 'desktop/surface/subscribe', workspaceId: 'w', sessionId: 's', surface: 'execution', requestKey: 'r1:99' })).rejects.toThrow('fields');
    ready.reject(Error('original runtime unavailable'));
    await Promise.all(flights);
    await owner.close();
});
