import type { DesktopExecutionView } from '../execution.ts';
export type SurfaceStamp = Readonly<{
    epoch: string;
    revision: number;
}>;
export type ExecutionSurfaceQuery = Readonly<{
    surface: 'execution';
    sessionId: string;
}>;
export type SurfaceLease = Readonly<{
    subscriptionId: string;
    requestKey: string;
    scope: ExecutionSurfaceQuery;
    stamp: SurfaceStamp;
}>;
export type SurfaceNotice = Readonly<{
    subscriptionId: string;
    stamp: SurfaceStamp;
    kind: 'invalidate' | 'reset' | 'retired';
    reason?: 'source-unavailable' | 'scope-changed' | 'owner-retired' | 'overflow';
}>;
export type ExecutionSurfaceSnapshot = {
    kind: 'snapshot';
    subscriptionId: string;
    stamp: SurfaceStamp;
    value: DesktopExecutionView;
} | {
    kind: 'reset';
    subscriptionId: string;
    stamp: SurfaceStamp;
} | {
    kind: 'unavailable';
    subscriptionId: string;
    stamp: SurfaceStamp;
    reason: 'source-unavailable' | 'owner-retired';
};
