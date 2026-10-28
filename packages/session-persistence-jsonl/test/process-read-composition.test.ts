import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createJsonlSessionCoordinator } from '../src/index.ts';
import { createSessionCoordinator } from '@i-harness/session-persistence';
import { createJsonlBackend } from '../src/backend-factory.ts';

it('constructs the genuine composed coordinator while generic construction stays separate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-compose-'));
    const composed = createJsonlSessionCoordinator(root, { lock: { enabled: true } });
    const generic = createSessionCoordinator(createJsonlBackend(root));
    try {
        await composed.create({ sessionId: 's' });
        expect((await composed.snapshot!('s')).session.events).toEqual([]);
        expect('withProcessReadObservation' in generic).toBe(false);
        // Capability remains deliberately unavailable until the complete
        // owner and result-service bridge audit is closed.
        expect('withProcessReadObservation' in composed).toBe(false);
    } finally { await composed.close(); await generic.close(); await rm(root, { recursive: true, force: true }); }
});
