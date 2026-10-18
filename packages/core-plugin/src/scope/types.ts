import type { CascadeHandler } from "../types.ts"

// Internal scope plumbing used to walk the ancestor chain. Only reachable
// through the createScope closure (not part of the public surface): every
// scope exposes its local guard check, its recorded decision and its local
// cascade handlers so ancestors and descendants can compose without leaking
// their maps.
export interface InternalScope {
  parentScope: InternalScope | null
  checkLocalGuards(event: string, exec: unknown): string | undefined
  resolveLocalDecision(event: string): unknown | undefined
  localCascades(event: string): CascadeHandler<unknown, unknown>[]
}

export type ServiceStore = Map<string, unknown>
