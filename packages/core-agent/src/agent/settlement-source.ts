import type { SettlementFacts, ProducerFactOutcome, CapturedSettlementFact } from '@i-harness/core-session';
import { delegateFactSettlementSource } from '@i-harness/core-session';
/** A source delegated before work retains its own drain through failure. A
 * successful close drops that handle instead of retaining completed outputs. */
export function trackSettlementSource(parent: SettlementFacts<ProducerFactOutcome>, drain: () => Promise<void>, released: () => void): SettlementFacts<ProducerFactOutcome> {
    let active = true, closing: Promise<void> | undefined;
    const assertOpen = () => {
        parent.assertHeld();
        if (!active)
            throw Object.assign(new Error('Settlement source is closed'), { code: 'FACT_CLOSED' });
    };
    const captured = (handle: CapturedSettlementFact<ProducerFactOutcome>): CapturedSettlementFact<ProducerFactOutcome> => ({
        admit() {
            assertOpen();
            return handle.admit();
        }, reconcile() {
            assertOpen();
            return handle.reconcile();
        }, observe() {
            assertOpen();
            return handle.observe();
        }, retryAbsent() {
            assertOpen();
            return handle.retryAbsent();
        },
    });
    return delegateFactSettlementSource(parent, {
        assertHeld: assertOpen,
        retention: {
            capture(event) {
                assertOpen();
                return captured(parent.retention.capture(event));
            }
        },
        rewind: {
            capture(event) {
                assertOpen();
                return captured(parent.rewind.capture(event));
            }
        },
        requireRecovery() {
            assertOpen();
            parent.requireRecovery();
        },
        close() {
            if (!active)
                return Promise.resolve();
            if (closing)
                return closing;
            const pending = Promise.resolve().then(drain).then(() => {
                active = false;
                released();
            });
            closing = pending;
            void pending.catch(() => {
                if (closing === pending)
                    closing = undefined;
            });
            return pending;
        },
        tools: {
            result(event) {
                assertOpen();
                return parent.tools.result(event);
            },
            captureResult(event) {
                assertOpen();
                return captured(parent.tools.captureResult(event));
            },
        },
        code: {
            record(event) {
                assertOpen();
                return parent.code.record(event);
            }, capture(event) {
                assertOpen();
                return captured(parent.code.capture(event));
            }
        },
        delivery: {
            record(event) {
                assertOpen();
                return parent.delivery.record(event);
            }, capture(event) {
                assertOpen();
                return captured(parent.delivery.capture(event));
            }
        },
        lifecycle: {
            lifecycle(event) {
                assertOpen();
                return parent.lifecycle.lifecycle(event);
            },
            usage(event) {
                assertOpen();
                return parent.lifecycle.usage(event);
            },
            auditAssistant(event) {
                assertOpen();
                return parent.lifecycle.auditAssistant(event);
            },
        },
    });
}
