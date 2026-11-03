/** Own the complete asynchronous submit disposition. Cleanup is attempted for
 * every acquired ingress path; neither reporting nor cleanup can lose callers. */
export async function completeSubmission(
  work: () => Promise<void>,
  closeIngress: () => Promise<void> | undefined,
  settlement: { resolve(): void; reject(error: unknown): void; report(error: unknown): void },
): Promise<void> {
  let failed = false, failure: unknown
  try { await work() } catch (error) { failed = true; failure = error }
  try { await closeIngress() }
  catch (saving) {
    failure = failed ? new AggregateError([failure, saving], 'Input execution settlement requires recovery', { cause: failure }) : saving
    failed = true
  }
  if (!failed) { settlement.resolve(); return }
  try { settlement.report(failure) } catch { /* Diagnostics cannot abandon the original disposition. */ }
  settlement.reject(failure)
}
