import type { DesktopBridge, DesktopEvent } from '../../src/shared/bridge.ts';
import type { ExecutionRequest } from '../../../desktop-gateway/src/execution.ts';
type Request = (request: ExecutionRequest) => Promise<unknown>;
const fixtures = new WeakMap<Request, {
    bridge: DesktopBridge;
    publish(): void;
}>();
/** Explicit subscription protocol fixture for pre-existing presentation oracles. */
export function executionObservationFixture(read: Request): DesktopBridge {
    const existing = fixtures.get(read);
    if (existing)
        return existing.bridge;
    let next = 0, revision = 0;
    const leases = new Map<string, {
        workspaceId: string;
        sessionId: string;
        epoch: string;
    }>(), listeners = new Set<(event: DesktopEvent) => void>();
    const bridge: DesktopBridge = { onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); }, async request(request) {
            if(request.kind==='desktop/capabilities')return {'desktop-surface-events':['1']}
            if (request.kind === 'desktop/surface/subscribe') {
                const subscriptionId = 'fixture-' + ++next, epoch = 'epoch-' + next;
                leases.set(subscriptionId, { workspaceId: request.workspaceId, sessionId: request.sessionId, epoch });
                return { subscriptionId, requestKey: 'r1:' + next, scope: { surface: 'execution', sessionId: request.sessionId }, stamp: { epoch, revision } };
            }
            if (request.kind === 'desktop/surface/unsubscribe') {
                leases.delete(request.subscriptionId);
                return { unsubscribed: true };
            }
            if (request.kind === 'desktop/surface/snapshot') {
                const lease = leases.get(request.subscriptionId);
                if (!lease)
                    throw Error('Unknown fixture lease');
                const value = await read({ kind: 'desktop/session/execution/read', workspaceId: request.workspaceId, sessionId: lease.sessionId, offset: request.offset, limit: request.limit });
                return { kind: 'snapshot', subscriptionId: request.subscriptionId, stamp: { epoch: lease.epoch, revision }, value };
            }
            return read(request as ExecutionRequest);
        } };
    fixtures.set(read, { bridge, publish() { revision++; for (const [subscriptionId, lease] of leases)
            for (const listener of listeners)
                listener({ kind: 'sdk/notification', workspaceId: lease.workspaceId, method: 'desktop/surface/changed', params: { subscriptionId, stamp: { epoch: lease.epoch, revision }, kind: 'invalidate' } }); } });
    return bridge;
}
export function publishExecutionChange(read: Request) { fixtures.get(read)!.publish(); }
