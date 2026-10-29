import { AsyncLocalStorage } from 'node:async_hooks'
import type { LLMStreamEvent } from '../index.ts'
import type { PreparedModelRequest, PreparedStreamControl } from './types.ts'
import { assertOwnedPreparedTerminal } from './owned-terminal.ts'
import { readOwnedExecutionConfirmation } from './payload.ts'
import type { ExecutionConfirmation } from './execution.ts'

type Node = { root: Root; terminal: boolean; pending: number }
type Root = { prepared: PreparedModelRequest; nodes: Set<Node>; errors: Array<{ order: number; error: unknown }>; nextOrder: number; sealed: boolean; status: 'open'|'draining'|'settled'|'failed'; done: Promise<void>; resolve(): void; reject(error: unknown): void }
const active = new AsyncLocalStorage<Node>()
const invocations = new WeakMap<OwnedPreparedStreamInvocation, Root>()
const confirmations = new WeakMap<ExecutionConfirmation, Node>()
function method(owner: object, key: PropertyKey): Function | undefined {
  for (let current: object | null = owner; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function' ? descriptor.value.bind(owner) : undefined
  }
  return undefined
}
export interface OwnedPreparedStreamInvocation {
  readonly stream: AsyncIterable<LLMStreamEvent>
  drain(): Promise<void>
  state(): 'open'|'draining'|'settled'|'failed'
}
function check(root: Root) {
  if (!root.sealed || [...root.nodes].some(node => !node.terminal || node.pending)) return
  if (root.status === 'settled' || root.status === 'failed') return
  if (root.errors.length) { root.status = 'failed'; root.reject(new AggregateError(root.errors.sort((a, b) => a.order - b.order).map(item => item.error), 'Owned stream cleanup failed')) }
  else { root.status = 'settled'; root.resolve() }
}
export function assertOwnedStreamAdmission(): void {
  const node = active.getStore()
  if (node && ((node.terminal && !node.pending) || node.root.status === 'settled' || node.root.status === 'failed')) throw new Error('Owned stream context finalized')
}
/** Called only by the original owned terminal constructor. */
export function associateOwnedStream(iterable: AsyncIterable<LLMStreamEvent>): AsyncIterable<LLMStreamEvent> {
  const parent = active.getStore()
  if (!parent) return iterable
  const root = parent.root
  if (parent.terminal && !parent.pending || root.status === 'settled' || root.status === 'failed') throw new Error('Owned stream context finalized')
  const node: Node = { root, terminal: false, pending: 0 }; root.nodes.add(node)
  let iterator: AsyncIterator<LLMStreamEvent>
  try {
    const getIterator = method(iterable, Symbol.asyncIterator)
    if (!getIterator) throw new TypeError('Owned async iterator unavailable')
    iterator = active.run(node, () => getIterator())
  } catch (error) { node.terminal = true; root.errors.push({ order: root.nextOrder++, error }); check(root); throw error }
  let methods: { next: Function | undefined; return: Function | undefined; throw: Function | undefined }
  try { methods = { next: method(iterator, 'next'), return: method(iterator, 'return'), throw: method(iterator, 'throw') } }
  catch (error) { root.errors.push({ order: root.nextOrder++, error }); check(root); throw error }
  const invoke = (name: 'next'|'return'|'throw', argument?: unknown): Promise<IteratorResult<LLMStreamEvent>> => {
    if (node.terminal || root.status === 'settled' || root.status === 'failed') return Promise.reject(new Error('Owned stream node finalized'))
    const operation = methods[name]
    if (!operation) return Promise.reject(new TypeError(`Owned iterator ${name} unavailable`))
    node.pending++
    const order = root.nextOrder++
    let result: Promise<IteratorResult<LLMStreamEvent>>
    try { result = Promise.resolve(active.run(node, () => operation(argument))) }
    catch (error) { result = Promise.reject(error) }
    return result.then(value => { if (value.done) node.terminal = true; return value }, error => { root.errors.push({ order, error }); node.terminal = true; throw error }).finally(() => { node.pending--; check(root) })
  }
  const facade: AsyncIterator<LLMStreamEvent> = { next: () => invoke('next'), return: value => invoke('return', value), throw: error => invoke('throw', error) }
  return { [Symbol.asyncIterator]: () => facade }
}
/** Captured by the original payload, not the consumer callback. */
export function associateOwnedConfirmation(confirmation: ExecutionConfirmation): void {
  const node = active.getStore(); if (node) confirmations.set(confirmation, node)
}
export function openOwnedPreparedStream(prepared: PreparedModelRequest, control: PreparedStreamControl): OwnedPreparedStreamInvocation {
  assertOwnedPreparedTerminal(prepared)
  let resolve!: () => void, reject!: (error: unknown) => void
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no }); void done.catch(() => {})
  const root: Root = { prepared, nodes: new Set(), errors: [], nextOrder: 0, sealed: false, status: 'open', done, resolve, reject }
  const context: Node = { root, terminal: false, pending: 1 }
  let iterator: AsyncIterator<LLMStreamEvent>
  try {
    const iterable = active.run(context, () => prepared.stream(control))
    const getIterator = method(iterable, Symbol.asyncIterator)
    if (!getIterator) throw new TypeError('Owned async iterator unavailable')
    iterator = getIterator()
  } catch (error) {
    root.errors.push({ order: root.nextOrder++, error }); root.sealed = true; check(root)
    iterator = { next: () => Promise.reject(error) }
  }
  let taken = false
  const exposed: AsyncIterable<LLMStreamEvent> = { [Symbol.asyncIterator]() { if (taken) throw new Error('Owned stream already consumed'); taken = true; return {
    next: async () => { try { const result = await iterator.next(); if (result.done) { root.sealed = true; check(root) }; return result } catch (error) { root.sealed = true; check(root); throw error } },
    return: async value => { try { return iterator.return ? await iterator.return(value) : { done: true, value } } finally { root.sealed = true; check(root) } },
    throw: async error => { try { if (iterator.throw) return await iterator.throw(error); throw error } finally { root.sealed = true; check(root) } },
  } } }
  const invocation: OwnedPreparedStreamInvocation = Object.freeze({ stream: exposed, drain() { if (invocations.get(this) !== root) return Promise.reject(new TypeError('Foreign owned stream invocation')); if (active.getStore()?.root === root) return Promise.reject(new Error('Cannot drain inside owned stream')); if (root.status === 'open') root.status = 'draining'; check(root); return root.done }, state() { if (invocations.get(this) !== root) throw new TypeError('Foreign owned stream invocation'); return root.status } })
  invocations.set(invocation, root); return invocation
}
export function readDrainedOwnedExecutionConfirmation(invocation: OwnedPreparedStreamInvocation, confirmation: ExecutionConfirmation, expectedPrepared: PreparedModelRequest) {
  const root = invocations.get(invocation), node = confirmations.get(confirmation)
  if (!root || root.status !== 'settled' || root.prepared !== expectedPrepared || node?.root !== root) return undefined
  return readOwnedExecutionConfirmation(confirmation, expectedPrepared)
}
