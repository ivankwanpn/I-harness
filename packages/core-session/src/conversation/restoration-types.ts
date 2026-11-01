import type { SessionEventView } from '../managed/types.ts';
import type { ImageInput } from '../images.ts';
import type { PruneRecord } from '../projection/pruning.ts';
/** Internal nominal read views. Their constructors retain all mutable folds. */
declare const sourceCoordinates: unique symbol;
declare const pruneDependencies: unique symbol;
export interface ConversationSourceCoordinateView {
    readonly eventCount: number;
    readonly [sourceCoordinates]: never;
}
export interface ConversationPruneDependencyView {
    readonly eventCount: number;
    readonly [pruneDependencies]: never;
}
/** Projection-only selected slots; never a SessionEvent or validation input. */
export interface PreparedPrunedResult {
    readonly kind: 'pruned-result';
    readonly callId: string;
    readonly name: string;
    readonly isError: boolean;
    readonly media: readonly ImageInput[];
    readonly prune: PruneRecord;
    readonly pruneSource: {
        readonly index: ConversationPruneDependencyView;
        readonly callId: string;
    };
}
export type PreparedResultProjection = {
    readonly kind: 'complete-result';
    readonly event: Extract<SessionEventView, {
        type: 'tool/result';
    }>;
} | PreparedPrunedResult;
export interface PreparedConversationArchive {
    readonly length: number;
    assertCurrent(): void;
    /** Missing hydration and expired lifetime are distinct errors, never undefined. */
    preparedEvent(ordinal: number): SessionEventView;
    preparedResult(ordinal: number): PreparedResultProjection;
    settle(): Promise<void>;
}
