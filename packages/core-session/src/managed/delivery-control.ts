import type { SessionView, SessionEventView } from './types.ts';
import { readDeliveries } from '../conversation/delivery.ts';
const controls = new WeakMap<object, {
  through: number;
  retired: boolean;
  debt: Set<object>;
}>();
const ports = new WeakMap<object, ReturnType<typeof createDeliveryControl>>();
export function assertDeliveryIssue(view: SessionView, events: readonly SessionEventView[]): void {
  ports.get(view)?.assert(events);
}
const stale = (): never => {
  throw Object.assign(new Error('Delivery precondition is stale'), { code: 'FACT_PRECONDITION_STALE' });
};
/** Construction is private to actual owner composition. No caller DTO binds it. */
export function createDeliveryControl(view: SessionView) {
  if (controls.has(view))
    throw new TypeError('Delivery control already bound');
  const control = { through: -1, retired: false, debt: new Set<object>() };
  controls.set(view, control);
  const port = {
    revoke() {
      control.through = Math.max(control.through, view.events.length - 1);
      const token = {};
      control.debt.add(token);
      return () => {
        control.debt.delete(token);
      };
    }, retire() {
      control.retired = true;
    }, assert(events: readonly SessionEventView[]) {
      const durable = readDeliveries(view), active = durable.activeGeneration();
      const current = () => {
        if (control.retired || control.debt.size > 0 || active === undefined || active.openedSeq <= control.through)
          stale();
      };
      for (const event of events) {
        if (event.type === 'agent/delivery-generation' && event.op === 'open' && (control.retired || control.debt.size > 0 || event.originInputSeq <= control.through))
          stale();
        if (event.type === 'agent/delivery-source' || event.type === 'agent/delivery-received')
          current();
        if (event.type === 'agent/input/promoted' && isBoundDeliveryInput(view, event.inputId) && !isDeliveryExecutable(view, event.inputId))
          stale();
        if (event.type === 'context/action' && event.op === 'open' && event.purpose === 'main') {
          const origin = event.origin;
          const raw = origin.kind === 'input' ? view.events[origin.seq] : undefined;
          const id = origin.kind === 'observation-input' ? origin.inputId : raw?.type === 'user/message' ? raw.input?.inputId : undefined;
          if (id && isBoundDeliveryInput(view, id))
            current();
        }
      }
    }
  };
  ports.set(view, port);
  return port;
}
export function isBoundDeliveryInput(view: SessionView, inputId: string): boolean {
  return view.events.some(e => e.type === 'agent/delivery-received' && e.inputId === inputId);
}
export function isDeliveryExecutable(view: SessionView, inputId: string): boolean {
  const admission = view.events.findLast(e => e.type === 'agent/input/admitted' && e.inputId === inputId);
  if (admission?.type !== 'agent/input/admitted')
    return false;
  if (admission.provenance?.producer === 'session.notification' && admission.synthetic?.display?.kind === 'task')
    return false;
  if (!isBoundDeliveryInput(view, inputId))
    return admission.provenance?.producer !== 'session.delivery.subagent';
  const state = readDeliveries(view), control = controls.get(view), active = state.activeGeneration();
  return state.isEligible(inputId) && !!active && !control?.retired && !control?.debt.size && active.openedSeq > (control?.through ?? -1);
}
