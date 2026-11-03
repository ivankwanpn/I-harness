import { seedHash } from './seed-digest.ts'
import type { SessionEventView } from '../managed/types.ts'
export function bootstrapInitialInputDigest(event: SessionEventView, startedAt: number, expiresAt: number): string {
  const { seq: _, ...input } = event
  return seedHash('ih.bootstrap.initial-input.v1', { input, startedAt, expiresAt })
}
