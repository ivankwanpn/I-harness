import type { SessionView, SessionEventView } from './types.ts';
import { readDeliveryIndex, type DeliveryReadIndex } from '../conversation/delivery.ts';
import { readOwnedDeliveryState } from './view.ts';
const controls = new WeakMap<object, {
  through: number;
  retired: boolean;
  debt: Set<object>;
}>();
const ports = new WeakMap<object, ReturnType<typeof createDeliveryControl>>();
const listeners = new WeakMap<object, Set<() => void>>();
export function subscribeDeliveryControl(view: SessionView, listener: () => void): () => void {
  let set = listeners.get(view);
  if (!set) { set = new Set(); listeners.set(view, set); }
  set.add(listener);
  return () => { set!.delete(listener); if (!set!.size) listeners.delete(view); };
}
function notify(view: SessionView): void {
  for (const listener of [...(listeners.get(view) ?? [])]) { try { listener(); } catch { /* Observers do not own delivery. */ } }
}
export function assertDeliveryIssue(view: SessionView, events: readonly SessionEventView[]): void {
  ports.get(view)?.assert(events);
}
const stale = (): never => {
  throw Object.assign(new Error('Delivery precondition is stale'), { code: 'FACT_PRECONDITION_STALE' });
};
const observation = (view: SessionView): DeliveryReadIndex => readOwnedDeliveryState(view) ?? readDeliveryIndex(view);
function executable(state: DeliveryReadIndex, inputId: string, control: { through: number; retired: boolean; debt: Set<object> } | undefined) {
  const input = state.input(inputId);
  if (!input || input.kind === 'legacy-task') return false;
  if (!state.isBound(inputId)) return input.kind !== 'delivery';
  const active = state.activeGeneration();
  return state.isEligible(inputId) && !!active && !control?.retired && !control?.debt.size && active.openedSeq > (control?.through ?? -1);
}
/** One original committed observation (or one explicit mutable/unbound replay)
 * for the whole synchronous pending selection, with live revocation still read. */
export function deliveryPredicate(view: SessionView): (inputId: string) => boolean {
  const state = observation(view), control = controls.get(view);
  return inputId => executable(state, inputId, control);
}
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
      notify(view);
      return () => {
        control.debt.delete(token);
        notify(view);
      };
    }, retire() {
      control.retired = true;
      notify(view);
    }, assert(events: readonly SessionEventView[]) {
      // Unrelated groups never need a delivery read. Relevant groups use the
      // original committed index afresh at this actual issuance boundary.
      let durable: DeliveryReadIndex | undefined;
      const read = () => durable ??= observation(view);
      const current = () => {
        const active = read().activeGeneration();
        if (control.retired || control.debt.size > 0 || active === undefined || active.openedSeq <= control.through)
          stale();
      };
      for (const event of events) {
        if (event.type === 'agent/delivery-generation' && event.op === 'open' && (control.retired || control.debt.size > 0 || event.originInputSeq <= control.through))
          stale();
        if (event.type === 'agent/delivery-source' || event.type === 'agent/delivery-received')
          current();
        if (event.type === 'agent/input/promoted' && read().isBound(event.inputId) && !executable(read(), event.inputId, control))
          stale();
        if (event.type === 'context/action' && event.op === 'open' && event.purpose === 'main') {
          const origin = event.origin;
          const id = origin.kind === 'observation-input' ? origin.inputId : origin.kind === 'input' ? read().inputIdAt(origin.seq) : undefined;
          if (id && read().isBound(id))
            current();
        }
      }
    }
  };
  ports.set(view, port);
  return port;
}
export function isBoundDeliveryInput(view: SessionView, inputId: string): boolean {
  return observation(view).isBound(inputId);
}
export function isDeliveryExecutable(view: SessionView, inputId: string): boolean {
  return deliveryPredicate(view)(inputId);
}
