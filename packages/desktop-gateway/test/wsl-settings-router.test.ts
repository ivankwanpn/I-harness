import { afterEach, expect, it, vi } from 'vitest';
import { createSessionService } from '@i-harness/session-executor';
import { createSdkServer } from '@i-harness/sdk/server';
import { encodeFrame, makeRequest, type RpcMessage } from '@i-harness/sdk';
import { createDesktopRouter, createGatewayWrite } from '../src/router.ts';
import type { DesktopHandlers } from '../src/types.ts';
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0))
    await close(); });
async function fixture(handlers: DesktopHandlers) {
    const sent: RpcMessage[] = [], service = createSessionService({ workspace: process.cwd(), modelPolicy: 'required' });
    const send = (frame: RpcMessage) => sent.push(frame);
    const router = createDesktopRouter(createSdkServer(service, { onWrite: createGatewayWrite(send, handlers) }), send, handlers);
    closers.push(async () => { await router.close(); await service.close(); });
    await router.handleLine(encodeFrame(makeRequest(1, 'initialize', {})));
    return { sent, call: async (method: string, params: unknown = {}) => { await router.handleLine(encodeFrame(makeRequest(sent.length + 1, method, params))); return sent.at(-1); } };
}
it('advertises only wired WSL actions and rejects caller supplied installation targets', async () => {
    const state = { selected: { distribution: 'Ubuntu', networkAccess: false, workspaceDependencies: true }, capabilities: { diagnose: true, repair: false } };
    const handlers = { wslSettings: { state: vi.fn(async () => state), close: async () => {}, diagnose: vi.fn(async () => state), repair: vi.fn(async () => { throw new Error('Managed repair unavailable'); }) } };
    const f = await fixture(handlers);
    expect(f.sent[0]).toMatchObject({ result: { capabilities: { 'desktop-wsl-settings': ['1'] } } });
    expect(await f.call('desktop/wsl/state')).toMatchObject({ result: state });
    expect(await f.call('desktop/wsl/diagnose', { distribution: 'outside' })).toHaveProperty('error');
    expect(handlers.wslSettings.diagnose).not.toHaveBeenCalled();
    expect(await f.call('desktop/wsl/diagnose')).toMatchObject({ result: state });
    expect(await f.call('desktop/wsl/repair')).toMatchObject({ error: { message: 'Managed repair unavailable' } });
});
it('reports an unwired WSL surface as unavailable without creating a session', async () => {
    const f = await fixture({});
    expect(await f.call('desktop/wsl/diagnose')).toMatchObject({ error: { message: 'WSL settings unavailable' } });
});
