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
}
export interface ContextReadResult {
  ref: ContextResultRef; text: string; offset: number; nextOffset: number|null; eof: boolean;
}
export interface ContextSearchResult {
  hits: { ref: ContextResultRef; text: string; offset: number; endOffset: number }[];
  partial: boolean; reasons: string[];
}
export interface ContextOutputService {
  configure(patch: Partial<ContextOutputConfig>): Promise<ContextOutputStatus>;
  status(): ContextOutputStatus;
  capture(input: ContextCapture, signal?: AbortSignal, producer?: (access:{maxBytes:number;signal:AbortSignal})=>Promise<{text:string;complete:boolean;originalBytes?:number}>): Promise<ContextResultRef|undefined>;
  read(access: ContextAccess, query: { refId: string; offset?: number; maxBytes?: number }): Promise<ContextReadResult>;
  search(access: ContextAccess, query: { query: string; refIds?: string[]; limit?: number; maxBytes?: number }): Promise<ContextSearchResult>;
  grant(access: ContextAccess, refIds: string[], targetSessionId: string): Promise<void>;
  clear(sessionId?: string): Promise<ContextOutputStatus>;
  close(): Promise<void>;
}
export interface ContextOutputOptions {
  root: string; workspaceId: string; config?: Partial<ContextOutputConfig>;
  authorize?: (access: ContextAccess, ref: ContextResultRef) => boolean|Promise<boolean>;
}
