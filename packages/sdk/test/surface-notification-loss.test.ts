import { expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { HarnessClient } from '../src/client.ts';
import { encodeFrame } from '../src/protocol.ts';
it('fences a failed surface consumer through its original failure owner while still delivering to independent later listeners', async () => {
    const input = new PassThrough(), output = new PassThrough(), client = new HarnessClient(input, output), fault = Object.freeze({ original: 'sink' }), failed = vi.fn(), seen = vi.fn(), thrower = vi.fn(() => { throw fault; });
    client.onNotification(thrower, failed);
    client.onNotification(seen);
    try {
        input.write(encodeFrame({ jsonrpc: '2.0', method: 'desktop/surface/changed', params: { subscriptionId: 's', stamp: { epoch: 'e', revision: 1 }, kind: 'invalidate' } }));
        await new Promise(resolve => setImmediate(resolve));
        expect(failed).toHaveBeenCalledWith(fault);
        expect(seen).toHaveBeenCalledTimes(1);
        input.write(encodeFrame({ jsonrpc: '2.0', method: 'desktop/surface/changed', params: { subscriptionId: 's', stamp: { epoch: 'e', revision: 2 }, kind: 'retired' } }));
        await new Promise(resolve => setImmediate(resolve));
        expect(thrower).toHaveBeenCalledTimes(1);
        expect(seen).toHaveBeenCalledTimes(2);
    }
    finally {
        await client.close();
        input.destroy();
        output.destroy();
    }
});
