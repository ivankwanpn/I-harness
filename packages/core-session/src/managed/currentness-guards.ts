/** Dependency-neutral constructor association. No paths, authority or successful
 * check results are stored here; an executor recognizes only its exact guards. */
type Guard = () => void
export type OriginalCurrentnessExecutor = Readonly<{
  compose(guards: readonly Guard[]): Guard
  immediate(check: Guard): void
}>
const guards = new WeakMap<Guard, OriginalCurrentnessExecutor>()
export function associateOriginalCurrentnessGuard(guard: Guard, executor: OriginalCurrentnessExecutor): void {
  const previous = guards.get(guard)
  if (previous && previous !== executor) throw TypeError('Original currentness executor changed')
  guards.set(guard, executor)
}
/** Only exact guards from one original executor can yield an enrolled output. */
export function composeOriginalCurrentnessGuards(...checks: readonly Guard[]): Guard | undefined {
  const executor = checks.length ? guards.get(checks[0]!) : undefined
  if (!executor || checks.some(check => guards.get(check) !== executor)) return
  return executor.compose(checks)
}
/** An unknown dependency is never borrowed into an original batching interval. */
export function runUnassociatedCurrentnessChecks(...checks: readonly Guard[]): void {
  const executor = checks.map(check => guards.get(check)).find(value => value !== undefined)
  const run = () => { for (const check of checks) check() }
  if (executor) executor.immediate(run)
  else run()
}
