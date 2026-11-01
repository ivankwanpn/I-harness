import type { SessionEventView } from '../managed/types.ts'

/** Internal nominal read views. Their constructors retain all mutable folds. */
declare const sourceCoordinates: unique symbol
declare const pruneDependencies: unique symbol
export interface ConversationSourceCoordinateView { readonly eventCount: number; readonly [sourceCoordinates]: never }
export interface ConversationPruneDependencyView { readonly eventCount: number; readonly [pruneDependencies]: never }
export interface PreparedConversationArchive {
  readonly length: number
  assertCurrent(): void
  /** Missing hydration and expired lifetime are distinct errors, never undefined. */
  preparedEvent(ordinal: number): SessionEventView
  settle(): Promise<void>
}
