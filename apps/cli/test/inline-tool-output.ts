import type { SessionEventView } from '@i-harness/core-session'

/** These CLI fixtures produce small results through the current envelope. */
export function inlineToolOutput<T = unknown>(event: SessionEventView | undefined): T {
  if (event?.type !== 'tool/result' || event.envelope?.retention.kind !== 'inline') {
    throw new Error('Expected an original tool result with inline retention')
  }
  return event.envelope.retention.value as T
}
