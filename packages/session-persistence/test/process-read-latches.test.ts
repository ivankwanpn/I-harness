import { describe, expect, it } from 'vitest';
import { createProcessReadLatches } from '../src/coordinator/process-read-latches.ts';

describe('process read mutation latches', () => {
    it('irreversibly invalidates a cold reader on a matching mutation, without blocking the writer', () => {
        const latches = createProcessReadLatches();
        const reader = latches.capture({ sessionId: 's', documentKeys: ['k'], mode: 'cold' });
        const token = latches.beginMutation({ sessionIds: ['s'], documentKeys: [], kind: 'other' });
        expect(() => reader.assertCurrent()).toThrow();
        token.end('settled');
        expect(() => reader.assertCurrent()).toThrow();
        expect(() => latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' })).not.toThrow();
    });

    it('retains unknown debt and rejects duplicate terminal settlement', () => {
        const latches = createProcessReadLatches();
        const token = latches.beginMutation({ sessionIds: [], documentKeys: ['k'], kind: 'other' });
        token.end('unknown');
        expect(() => token.end('settled')).toThrow();
        expect(() => latches.capture({ sessionId: 's', documentKeys: ['k'], mode: 'cold' })).toThrow();
    });

    it('permits a settled same-owner append unless a guard encountered it in flight', () => {
        const latches = createProcessReadLatches(), owner = {};
        const reader = latches.capture({ sessionId: 's', documentKeys: [], mode: 'managed', managedOwner: owner });
        const token = latches.beginMutation({ sessionIds: ['s'], documentKeys: [], kind: 'managed-append', managedOwner: owner });
        expect(() => reader.assertCurrent()).toThrow();
        token.end('settled');
        expect(() => reader.assertCurrent()).toThrow();
        const next = latches.capture({ sessionId: 's', documentKeys: [], mode: 'managed', managedOwner: owner });
        const second = latches.beginMutation({ sessionIds: ['s'], documentKeys: [], kind: 'managed-append', managedOwner: owner });
        second.end('settled');
        next.assertCurrent();
        reader.retire();
        expect(() => reader.assertCurrent()).toThrow();
    });

    it('counts overlapping tokens and leaves unrelated keys available', () => {
        const latches = createProcessReadLatches();
        const first = latches.beginMutation({ sessionIds: ['s'], documentKeys: ['k'], kind: 'other' });
        const second = latches.beginMutation({ sessionIds: ['s'], documentKeys: ['k'], kind: 'other' });
        expect(() => latches.capture({ sessionId: 'other', documentKeys: ['other'], mode: 'cold' })).not.toThrow();
        first.end('settled');
        expect(() => latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' })).toThrow();
        expect(() => latches.capture({ sessionId: 'other', documentKeys: ['k'], mode: 'cold' })).toThrow();
        second.end('settled');
        expect(() => latches.capture({ sessionId: 's', documentKeys: ['k'], mode: 'cold' })).not.toThrow();
    });

    it('invalidates verified readers even for a same-owner append and closes admission', () => {
        const latches = createProcessReadLatches(), owner = {};
        const reader = latches.capture({ sessionId: 's', documentKeys: [], mode: 'managed', managedOwner: owner });
        reader.markVerified();
        const token = latches.beginMutation({ sessionIds: ['s'], documentKeys: [], kind: 'managed-append', managedOwner: owner });
        token.end('settled');
        expect(() => reader.assertCurrent()).toThrow();
        latches.closeAdmission();
        expect(() => latches.capture({ sessionId: 'other', documentKeys: [], mode: 'cold' })).toThrow();
    });

    it('rejects copied token and reader receivers without consuming the originals', () => {
        const latches = createProcessReadLatches();
        const reader = latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' });
        expect(() => ({ ...reader }).assertCurrent()).toThrow();
        reader.assertCurrent();
        const token = latches.beginMutation({ sessionIds: ['other'], documentKeys: [], kind: 'other' });
        expect(() => ({ ...token }).end('settled')).toThrow();
        token.end('settled');
    });

    it('copies admission keys and poisons a managed reader on an unknown append', () => {
        const latches = createProcessReadLatches(), owner = {}, keys = ['k'], sessions = ['s'];
        const reader = latches.capture({ sessionId: 's', documentKeys: keys, mode: 'managed', managedOwner: owner });
        keys[0] = 'other';
        const token = latches.beginMutation({ sessionIds: sessions, documentKeys: [], kind: 'managed-append', managedOwner: owner });
        sessions[0] = 'other';
        token.end('unknown');
        expect(() => reader.assertCurrent()).toThrow();
        expect(() => latches.capture({ sessionId: 's', documentKeys: [], mode: 'managed', managedOwner: owner })).toThrow();
        const docReader = latches.capture({ sessionId: 'another', documentKeys: ['k'], mode: 'cold' });
        const docWrite = latches.beginMutation({ sessionIds: [], documentKeys: ['k'], kind: 'other' });
        docWrite.end('settled');
        expect(() => docReader.assertCurrent()).toThrow();
    });

    it('rejects a foreign owner append and retirement cannot revive a reader', () => {
        const latches = createProcessReadLatches();
        const reader = latches.capture({ sessionId: 's', documentKeys: [], mode: 'managed', managedOwner: {} });
        const token = latches.beginMutation({ sessionIds: ['s'], documentKeys: [], kind: 'managed-append', managedOwner: {} });
        token.end('settled');
        expect(() => reader.assertCurrent()).toThrow();
        reader.retire();
        reader.retire();
        expect(() => reader.markVerified()).toThrow();
    });
});
