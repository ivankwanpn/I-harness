/** M51 B1: marker for a RE-DISPATCH of an already-admitted `tools/execute`
 * dispatch (guard-retry re-enters the cascade after a TOOL_TIMEOUT so the
 * timeout guard re-arms). Handlers whose semantics are once-per-logical-call
 * (hooks pre-tool/post-tool) must skip their own run when it is set — the
 * frame that already ran the pair owns the single one. A SYMBOL, so the marker
 * can never leak into tool args or a serialized log line. */
export const CASCADE_REDISPATCH: symbol = Symbol.for("i-harness.cascade.redispatch")

/** Mark a cascade payload as a re-dispatch frame (see CASCADE_REDISPATCH). */
export function markCascadeRedispatch(payload: unknown): void {
  (payload as Record<PropertyKey, unknown>)[CASCADE_REDISPATCH] = true
}

/** True when the cascade payload is a re-dispatch frame (see CASCADE_REDISPATCH). */
export function isCascadeRedispatch(payload: unknown): boolean {
  return (payload as Record<PropertyKey, unknown>)[CASCADE_REDISPATCH] === true
}
