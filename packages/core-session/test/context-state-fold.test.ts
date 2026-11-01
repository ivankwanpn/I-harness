import { expect, it } from 'vitest';
import { createContextStateIndex, deriveContextRecovery, deriveContextBudget } from '../src/projection/context.ts';
import type { Session } from '../src/events/types.ts';
it('incremental recovery retains strongest applicable lane and consumed retry across later transitions', () => {
    const base = { type: 'context/recovery' as const, version: 1 as const, ownerSessionId: 'owner', logicalStepSeq: 0, bindingFingerprint: 'a'.repeat(64), rejectedInputFingerprint: 'b'.repeat(64), modelId: 'model', protocol: 'chat' };
    const session: Session = { formatVersion: 14, events: [{ ...base, recoveryId: 'old', providerId: 'p', state: 'retry-started', seq: 0 }, { ...base, recoveryId: 'new', providerId: 'q', state: 'required', seq: 1 }, { ...base, recoveryId: 'old', providerId: 'p', state: 'blocked', seq: 2 }, { ...base, recoveryId: 'new', providerId: 'q', state: 'resolved', seq: 3 }] };
    const index = createContextStateIndex();
    for (const event of session.events)
        index.stage([event]).commit();
    for (const binding of [undefined, { modelId: 'model', protocol: 'chat' }, { providerId: 'p', modelId: 'model', protocol: 'chat' }, { providerId: 'q', modelId: 'model', protocol: 'chat' }, { providerId: 'p', modelId: 'other', protocol: 'chat' }])
        expect(index.recovery('owner', binding)).toEqual(deriveContextRecovery(session, 'owner', binding));
    expect(index.recovery('owner', { modelId: 'model', protocol: 'chat' })).toMatchObject({ recoveryId: 'old', state: 'blocked', retryConsumed: true });
    expect(index.budget('owner')).toEqual(deriveContextBudget(session, 'owner'));
});
