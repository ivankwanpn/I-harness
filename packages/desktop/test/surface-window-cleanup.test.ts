import { expect, it, vi } from 'vitest';
import { registerDesktopIpc, closeDesktopSurfaceWindows } from '../src/main/ipc.ts';
import type { DesktopIpcDependencies } from '../src/main/ipc.ts';
it('owns two original window routes, closes a pending ACK, retains exact failure debt and drains independent windows', async () => {
    const ack = Promise.withResolvers<any>(), entered = Promise.withResolvers<void>(), fault = Object.freeze({ original: 'unsubscribe-debt' });
    let fails = 2, handler: any;
    const request = vi.fn(async (method: string, p: any) => {
        if (method === 'desktop/surface/subscribe') {
            const lease = { subscriptionId: p.requestKey, requestKey: p.requestKey, scope: { surface: 'execution', sessionId: p.sessionId }, stamp: { epoch: 'epoch-' + p.requestKey, revision: 0 } };
            if (p.sessionId === 'first') {
                entered.resolve();
                return ack.promise.then(() => lease);
            }
            return lease;
        }
        if (method === 'desktop/surface/unsubscribe' && p.subscriptionId === 'r1:1' && fails-- > 0)
            throw fault;
        return { unsubscribed: true };
    });
    const runtime = { client: { request }, info: { capabilities: { 'desktop-surface-events': ['1'] } } }, deps = { catalog: { get: () => ({ id: 'w', path: process.env.IH_CONFIG_DIR!, label: 'fixture' }) }, runtimes: { get: async () => runtime, peek: () => runtime, onEvent: () => () => { } } } as unknown as DesktopIpcDependencies;
    const ipc = { handle(_channel: string, fn: any) { if (handler)
            throw Error('duplicate IPC handler'); handler = fn; }, removeHandler() { handler = undefined; } }, first = { isDestroyed: () => false, webContents: { send() { } } }, second = { isDestroyed: () => false, webContents: { send() { } } };
    const closeFirst = registerDesktopIpc(first as never, deps, ipc), closeSecond = registerDesktopIpc(second as never, deps, ipc);
    try {
        const pending = handler({ sender: first.webContents }, { kind: 'desktop/surface/subscribe', workspaceId: 'w', surface: 'execution', sessionId: 'first' });
        void pending.catch(() => { });
        await entered.promise;
        let done = false;
        const closing = closeFirst().finally(() => { done = true; });
        void closing.catch(() => { });
        await Promise.resolve();
        expect(done).toBe(false);
        await expect(handler({ sender: first.webContents }, { kind: 'desktop/surface/snapshot', workspaceId: 'w', subscriptionId: 'r1:1', epoch: 'epoch-r1:1' })).rejects.toThrow('untrusted');
        ack.resolve({});
        await expect(pending).rejects.toThrow();
        await expect(closing).rejects.toMatchObject({ errors: [fault] });
        const lease = await handler({ sender: second.webContents }, { kind: 'desktop/surface/subscribe', workspaceId: 'w', surface: 'execution', sessionId: 'second' });
        await expect(closeDesktopSurfaceWindows()).rejects.toThrow('cleanup incomplete');
        expect(request).toHaveBeenCalledWith('desktop/surface/unsubscribe', { subscriptionId: lease.subscriptionId },30_000);
        expect(request.mock.calls.filter(([method]) => method === 'desktop/surface/subscribe')).toHaveLength(2);
        await closeDesktopSurfaceWindows();
        expect(handler).toBeUndefined();
        expect(request.mock.calls.filter(([method]) => method === 'desktop/surface/subscribe')).toHaveLength(2);
    }
    finally {
        fails = 0;
        ack.resolve({});
        await closeFirst();
        await closeSecond();
        await closeDesktopSurfaceWindows();
    }
});
