import type { ImageInput } from "@i-harness/sdk"
import type { ContextItem } from "@i-harness/desktop-gateway/src/context-picker.ts"
export interface DraftScope { workspaceId: string; identity: string }
export interface DraftTextAttachment { id: number; name: string; text: string; contentType?: string; bytes?: number; truncated?: boolean; reason?: string }
export interface UnsentDraft { prompt: string; references: string[]; images: Array<ImageInput & { id: number }>; texts: DraftTextAttachment[]; contextRefs: ContextItem[]; metadata?: string }
export interface DurableDraft { revision: string | null; draft: UnsentDraft | null; updatedAt?: number }
export type DraftRequest = { kind: "desktop/draft/load"; scope: DraftScope } | { kind: "desktop/draft/save"; scope: DraftScope; expectedRevision: string | null; draft: UnsentDraft } | { kind: "desktop/draft/clear"; scope: DraftScope; expectedRevision: string | null }
export type DraftRequester = (request: DraftRequest) => Promise<DurableDraft>
