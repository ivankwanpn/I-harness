export interface ContextOutputConfig {
  enabled: boolean; maxPreviewBytes: number; maxCaptureBytes: number;
  maxReadBytes: number; maxSearchBytes: number; maxDiskBytes: number; retentionDays: number;
}
export interface ContextAccess { sessionId: string; signal?: AbortSignal }
export interface ContextCapture {
  sessionId: string; callId: string; label: string; text: string; complete: boolean;
  source?: { sourceId: string; path?: string; revision?: string; readonly?: boolean };
}
export interface ContextResultRef {
  id: string; workspaceId: string; sessionId: string; callId: string; label: string;
  revision: string; bytes: number; originalBytes: number; complete: boolean; expiresAt: number;
  source?: { sourceId: string; path?: string; revision?: string; readonly?: boolean };
}
export interface ContextOutputStatus {
  enabled: boolean; state: 'disabled'|'ready'|'stopping'|'error'; config: ContextOutputConfig;
  retainedBytes: number; results: number; activeJobs: number; error?: string;
  protectedResults?: number; clearDisposition?: 'cleared' | 'protected';
}
export interface ContextReadResult {
  ref: ContextResultRef; text: string; offset: number; nextOffset: number|null; eof: boolean;
}
export interface ContextSearchResult {
  hits: { ref: ContextResultRef; text: string; offset: number; endOffset: number }[];
  partial: boolean; reasons: string[];
}
export interface ContextOutputService {
  registerLegacyForkTransfer(capture: import('./legacy/fork-types.ts').LegacyForkCapture): import('./legacy/fork-types.ts').LegacyForkTransferScope;
  confirmLegacyForkTransfer(scope: import('./legacy/fork-types.ts').LegacyForkTransferScope, request: import('./legacy/fork-types.ts').LegacyPreparationRequest, current: () => boolean, facts: import('@i-harness/core-session').BootstrapPreparationFacts): Promise<import('./legacy/fork-types.ts').LegacyTransferOutcome>;
  reconcileLegacyForkTransfer(scope: import('./legacy/fork-types.ts').LegacyForkTransferScope, request: import('./legacy/fork-types.ts').LegacyPreparationRequest, facts: import('@i-harness/core-session').BootstrapPreparationFacts): Promise<import('./legacy/fork-types.ts').LegacyTransferOutcome>;
  closeLegacyForkTransfer(scope: import('./legacy/fork-types.ts').LegacyForkTransferScope): Promise<void>;
  readLegacyObserved(access: ContextAccess, query: import('./legacy/fork-types.ts').LegacyReadQuery, observation: import('./legacy/fork-types.ts').LegacyReadObservation): Promise<ContextReadResult>;
  searchLegacyObserved(access: ContextAccess, query: import('./legacy/fork-types.ts').LegacySearchQuery, observation: import('./legacy/fork-types.ts').LegacyReadObservation): Promise<ContextSearchResult>;
  registerSeedDependencyTransfer(access: import('./artifact/bootstrap-transfer.ts').SeedDependencyHostAccess, originalPublication?: 'original-publication'): import('./artifact/bootstrap-transfer.ts').SeedDependencyTransferScope;
  confirmSeedDependencies(scope: import('./artifact/bootstrap-transfer.ts').SeedDependencyTransferScope, request: import('@i-harness/core-session').BootstrapDependencyRequest, current: () => boolean): Promise<import('@i-harness/core-session').BootstrapDependencyOutcome>;
  reconcileSeedDependencies(scope: import('./artifact/bootstrap-transfer.ts').SeedDependencyTransferScope, request: import('@i-harness/core-session').BootstrapDependencyRequest): Promise<import('@i-harness/core-session').BootstrapDependencyOutcome>;
  /** Host composition only; model tools expose read DTOs, never this method. */
  registerResultScope(owner: import('./artifact/types.ts').ArtifactOwner, current: () => boolean): import('./artifact/types.ts').ResultArtifactScope;
  registerResultDependencyScope(owner: import('./artifact/types.ts').ArtifactOwner, current: () => boolean, entries: readonly import('@i-harness/core-session').ResultDependency[]): import('./artifact/types.ts').ResultArtifactScope;
  settleResultDependencyMembership(scope: import('./artifact/types.ts').ResultArtifactScope, ref: import('@i-harness/core-session').ManagedArtifactRef): Promise<import('./artifact/dependency-membership.ts').MembershipSettlement>;
  beginResult(scope: import('./artifact/types.ts').ResultArtifactScope, codec: import('@i-harness/core-session').ResultCodec): Promise<import('./artifact/types.ts').ResultArtifactSink>;
  confirmResultOwner(scope: import('./artifact/types.ts').ResultArtifactScope, ref: import('@i-harness/core-session').ManagedArtifactRef): Promise<void>;
  readResult(access: ContextAccess, query: { ref: import('@i-harness/core-session').ManagedArtifactRef; offset?: number; maxBytes?: number; viaCatalog?: import('@i-harness/core-session').ManagedArtifactRef }): Promise<import('./artifact/types.ts').ManagedArtifactPage>;
  readCodeOutputResult?(access:ContextAccess,query:{ref:import('@i-harness/core-session').ManagedArtifactRef;cursor?:import('@i-harness/core-session').CodeOutputCursor;maxBytes?:number}):Promise<import('./artifact/code-output-reader.ts').CodeOutputPage>;
  readExecResult(access: ContextAccess, query: { ref: import('@i-harness/core-session').ManagedArtifactRef; cursor?: import('@i-harness/core-session').ExecFrameCursor; maxBytes?: number; textView?: boolean; viaCatalog?: import('@i-harness/core-session').ManagedArtifactRef }): Promise<import('./artifact/exec-reader.ts').ExecFramePage>;
  reconcileResult(operationId: string, id: string): Promise<import('./artifact/types.ts').ArtifactSettlement>;
  configure(patch: Partial<ContextOutputConfig>): Promise<ContextOutputStatus>;
  status(): ContextOutputStatus;
  /** Counts of committed managed result artifacts owned by the caller. */
  managedInventory?(access: ContextAccess): Promise<{ results: number; bytes: number }>;
  capture(input: ContextCapture, signal?: AbortSignal, producer?: (access:{maxBytes:number;signal:AbortSignal})=>Promise<{text:string;complete:boolean;originalBytes?:number}>): Promise<ContextResultRef|undefined>;
  read(access: ContextAccess, query: { refId: string; offset?: number; maxBytes?: number }): Promise<ContextReadResult>;
  search(access: ContextAccess, query: { query: string; refIds?: string[]; limit?: number; maxBytes?: number }): Promise<ContextSearchResult>;
  grant(access: ContextAccess, refIds: string[], targetSessionId: string): Promise<void>;
  clear(sessionId?: string): Promise<ContextOutputStatus>;
  close(): Promise<void>;
}
export interface ContextOutputOptions {
  /** Host composition must enable this before publishing legacy transfers. */
  requireObservedLegacyRecipients?: boolean;
  root: string; workspaceId: string; config?: Partial<ContextOutputConfig>;
  authorize?: (access: ContextAccess, ref: ContextResultRef) => boolean|Promise<boolean>;
  authorizeResult?: (access: ContextAccess, source: {
    workspaceId: string; owner: Readonly<import('./artifact/types.ts').ArtifactOwner>; ref: import('@i-harness/core-session').ManagedArtifactRef;
    visibleVia?: import('@i-harness/core-session').ManagedArtifactRef;
  }) => boolean|Promise<boolean>;
  /** Trusted host lifecycle subscription, never supplied through a read tool. */
  documentDeletions?: (listener: (documents: readonly string[]) => Promise<void>) => () => void;
}
