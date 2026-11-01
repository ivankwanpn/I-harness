// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopBridge, DesktopEvent } from '../src/shared/bridge.ts';
import { useExecutionObservation } from '../src/renderer/observation/use-observation.ts';
afterEach(cleanup);
function fixture(limited = false) {
    let listener: (event: DesktopEvent) => void = () => { }, hidden = false, subscriptions = 0, reads = 0, revision = 0;
    const old = Promise.withResolvers<unknown>(), second = Promise.withResolvers<unknown>(), close = Promise.withResolvers<void>(), mutation = Promise.withResolvers<void>();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    const value = (source: string, live = true) => ({ sessionId: 's', live, cells: [{ id: 'cell', source, live, canTerminate: live }] });
    const snapshot = (source: string, version: number, id = 'lease1') => ({ kind: 'snapshot', subscriptionId: id, stamp: { epoch: 'epoch' + id.slice(-1), revision: version }, value: value(source) });
    const request = vi.fn(async (p: any): Promise<unknown> => {
        if (p.kind === 'desktop/capabilities')
            return limited ? {} : { 'desktop-surface-events': ['1'] };
        if (p.kind === 'desktop/surface/subscribe') {
            const n = ++subscriptions;
            return { subscriptionId: 'lease' + n, requestKey: 'r1:' + n, scope: { surface: 'execution', sessionId: p.sessionId }, stamp: { epoch: 'epoch' + n, revision } };
        }
        if (p.kind === 'desktop/surface/unsubscribe') {
            if (p.subscriptionId === 'lease1')
                await close.promise;
            return { unsubscribed: true };
        }
        reads++;
        if (reads === 2)
            return old.promise;
        if (reads === 3)
            return second.promise;
        return limited ? value('initial') : snapshot('initial', 0);
    });
    const bridge: DesktopBridge = { request, onEvent(fn) { listener = fn; return () => { listener = () => { }; }; } }, run = vi.fn(() => mutation.promise);
    function Pane({ id = 's' }: {
        id?: string;
    }) { const view = useExecutionObservation(bridge, 'w', id, 0); return <><p>{view.state?.cells[0]?.source}</p><p>{view.error}</p><button disabled={!view.state?.cells[0]?.canTerminate} onClick={() => void view.act(run)}>stop</button><button onClick={() => void view.refresh()}>refresh</button></>; }
    const mounted = render(<Pane />);
    const settle = async () => { for (let i = 0; i < 8; i++)
        await act(async () => { await Promise.resolve(); }); };
    return { mounted, request, run, old, second, close, mutation, value, snapshot, settle, scope(id: string) { mounted.rerender(<Pane id={id}/>); }, get reads() { return reads; }, get subscriptions() { return subscriptions; }, async initial() { await settle(); expect(screen.getByText('initial')).toBeTruthy(); fireEvent.click(screen.getByText('refresh')); await settle(); expect(reads).toBe(2); }, notice(version: number) { revision = version; act(() => listener({ kind: 'sdk/notification', workspaceId: 'w', method: 'desktop/surface/changed', params: { subscriptionId: 'lease1', stamp: { epoch: 'epoch1', revision: version }, kind: 'invalidate' } })); }, visibility(next: boolean) { act(() => { hidden = next; document.dispatchEvent(new Event('visibilitychange')); }); }, ready() { act(() => { listener({ kind: 'sdk/disconnected', workspaceId: 'w', message: 'old connection' }); listener({ kind: 'sdk/ready', method: 'sdk/ready', workspaceId: 'w', runtimeGeneration: 1 }); }); }, async finish() { old.resolve(snapshot('late old', 0)); second.resolve(snapshot('late second', revision, 'lease2')); close.resolve(); mutation.resolve(); mounted.unmount(); await settle(); } };
}
it.each([false, true])('preserves newer notice across an older response, with still-changing second attempt=%s', async (changing) => {
    const f = fixture();
    try {
        await f.initial();
        f.notice(1);
        expect((screen.getByText('stop') as HTMLButtonElement).disabled).toBe(true);
        await act(async () => { f.old.resolve(f.snapshot('obsolete', 0)); });
        await f.settle();
        expect(f.reads).toBe(3);
        expect(screen.queryByText('obsolete')).toBeNull();
        if (changing)
            f.notice(2);
        await act(async () => { f.second.resolve(f.snapshot('new value', 1)); });
        await f.settle();
        expect(f.reads).toBe(3);
        if (changing) {
            expect(screen.queryByText('new value')).toBeNull();
            expect(screen.getByText(/Execution is updating/)).toBeTruthy();
            expect((screen.getByText('stop') as HTMLButtonElement).disabled).toBe(true);
        }
        else
            expect(screen.getByText('new value')).toBeTruthy();
    }
    finally {
        await f.finish();
    }
});
it.each([false, true].flatMap(limited => ['read-first', 'show-first'].map(order => ({ limited, order }))))('retains finite visibility resume with limited=$limited and $order', async ({ limited, order }) => {
    const f = fixture(limited);
    try {
        await f.initial();
        f.visibility(true);
        await f.settle();
        if (!limited)
            expect(f.request).toHaveBeenCalledWith({ kind: 'desktop/surface/unsubscribe', workspaceId: 'w', subscriptionId: 'lease1' });
        if (order === 'read-first') {
            await act(async () => { f.old.resolve(limited ? f.value('obsolete') : f.snapshot('obsolete', 0)); });
            await f.settle();
        }
        f.visibility(false);
        f.visibility(false);
        fireEvent.click(screen.getByText('refresh'));
        await f.settle();
        expect(f.subscriptions).toBe(limited ? 0 : 1);
        f.close.resolve();
        await f.settle();
        if (order === 'show-first') {
            expect(f.reads).toBe(2);
            await act(async () => { f.old.resolve(limited ? f.value('obsolete') : f.snapshot('obsolete', 0)); });
        }
        await f.settle();
        expect(f.reads).toBe(3);
        expect(f.subscriptions).toBe(limited ? 0 : 2);
        expect(screen.queryByText('obsolete')).toBeNull();
        await act(async () => { f.second.resolve(limited ? f.value('resumed') : f.snapshot('resumed', 0, 'lease2')); });
        await f.settle();
        expect(screen.getByText('resumed')).toBeTruthy();
        expect(f.reads).toBe(3);
    }
    finally {
        await f.finish();
    }
});
it('does not let an old visibility demand reacquire after a scope change', async () => {
    const f = fixture();
    try {
        await f.initial();
        f.visibility(true);
        f.visibility(false);
        f.scope('other');
        f.close.resolve();
        await f.settle();
        expect(f.subscriptions).toBe(2);
        expect(f.reads).toBe(3);
        await act(async () => { f.second.resolve({ ...f.snapshot('other current', 0, 'lease2'), value: { ...f.value('other current'), sessionId: 'other' } }); f.old.resolve(f.snapshot('obsolete scope', 99)); });
        await f.settle();
        expect(screen.getByText('other current')).toBeTruthy();
        expect(screen.queryByText('obsolete scope')).toBeNull();
        expect(f.request.mock.calls.filter(([p]) => p.kind === 'desktop/surface/subscribe').map(([p]) => p.sessionId)).toEqual(['s', 'other']);
        expect(f.reads).toBe(3);
    }
    finally {
        await f.finish();
    }
});
it.each(['Stop', 'reconnect'])('coalesces visibility resume with %s precedence while the old read is held', async (boundary) => {
    const f = fixture();
    try {
        await f.initial();
        if (boundary === 'Stop')
            fireEvent.click(screen.getByText('stop'));
        f.visibility(true);
        f.visibility(false);
        if (boundary === 'reconnect')
            f.ready();
        f.close.resolve();
        await act(async () => { f.old.resolve(f.snapshot('obsolete', 0)); });
        await f.settle();
        if (boundary === 'Stop') {
            expect(f.reads).toBe(2);
            f.mutation.resolve();
        }
        await f.settle();
        expect(f.subscriptions).toBe(2);
        expect(f.reads).toBe(3);
        await act(async () => { f.second.resolve(f.snapshot('resumed', 0, 'lease2')); });
        await f.settle();
        expect(screen.getByText('resumed')).toBeTruthy();
        expect(f.reads).toBe(3);
        expect(f.run).toHaveBeenCalledTimes(boundary === 'Stop' ? 1 : 0);
    }
    finally {
        await f.finish();
    }
});
