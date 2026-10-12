import { createHash } from "node:crypto"
import type { LLMRequestScope } from "@i-harness/llm-seam"

const hashIdentity = (value: string): string => `ih_${createHash("sha256").update(value).digest("hex").slice(0, 48)}`
const validIdentity = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value)
const threadIdentity = (value: string): string => validIdentity(value) ? value : hashIdentity(value)

/** Bounded per-turn state, never stored on requests, events, usage or disk. The
 * scope object is the lifetime owner; a client rebuild intentionally drops it.
 * An unscoped low-level call has no conversation and cannot inherit state. */
export function createSubscriptionAffinity() {
  let owner: { accountId: string } | undefined
  const turns = new WeakMap<LLMRequestScope, { owner: object; sessionId: string; turnId: string; isSubagent: boolean; token?: string }>()
  return {
    cacheKey: (scope: LLMRequestScope): string => hashIdentity(scope.sessionId),
    prepare(scope: LLMRequestScope | undefined, accountId: string, cacheKey: unknown, cacheOff: boolean, identity = scope) {
      if (owner?.accountId !== accountId) owner = { accountId }
      const headers: Record<string, string> = {}
      if (!scope || !identity) return { headers, capture: (_response: Response, _signal?: AbortSignal) => {} }
      let state = turns.get(scope)
      const sameIdentity = (value: NonNullable<typeof state>, current: LLMRequestScope): boolean => value.sessionId === current.sessionId && value.turnId === current.turnId && value.isSubagent === (current.isSubagent === true)
      if (!state || state.owner !== owner || !sameIdentity(state, identity)) {
        state = { owner, sessionId: identity.sessionId, turnId: identity.turnId, isSubagent: identity.isSubagent === true }
        turns.set(scope, state)
      }
      // Native Codex uses root cache affinity for session-id, but the actual
      // child identity for non-root agents. thread-id always names the session.
      const threadId = threadIdentity(identity.sessionId)
      headers["thread-id"] = threadId
      const affinity = identity.isSubagent ? threadId : cacheKey
      if (!cacheOff && validIdentity(affinity)) headers["session-id"] = affinity
      if (state.token !== undefined) headers["x-codex-turn-state"] = state.token
      const captured = state
      return {
        headers,
        capture(response: Response, signal?: AbortSignal) {
          if (signal?.aborted || captured.owner !== owner || turns.get(scope) !== captured || !sameIdentity(captured, scope) || captured.token !== undefined) return
          const token = response.headers.get("x-codex-turn-state")
          // First VALID value wins (native OnceLock semantics). Bound opaque
          // input, reject controls/non-ASCII and avoid Fetch trimming a value.
          if (token && token.length <= 4096 && /^[\x20-\x7e]+$/.test(token) && token.trim() === token) captured.token = token
        },
      }
    },
  }
}
