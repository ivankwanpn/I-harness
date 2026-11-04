/** A-11: user/owner abort is a cancellation contract, not an opaque failure.
 * Callers can distinguish it by `code` instead of matching the message text. */
export function agentAbortedError(): Error & { code: "AGENT_ABORTED" } {
  return Object.assign(new Error("agent aborted"), { code: "AGENT_ABORTED" as const })
}
