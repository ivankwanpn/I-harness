export type ModelReviewTarget =
  | { kind: "working" }
  | { kind: "base"; branch: string }
  | { kind: "commit"; sha: string }

export type ModelReviewLayer = "staged" | "unstaged" | "untracked" | "committed"

export interface ModelReviewFile {
  path: string
  layer: ModelReviewLayer
  disposition: "text" | "binary" | "unavailable" | "omitted"
  text?: string
  truncated?: boolean
}

export interface ModelReviewSnapshot {
  fingerprint: string
  target: ModelReviewTarget
  head: string
  base: string
  end?: string
  capturedAt: string
  files: ModelReviewFile[]
  listingTruncated: boolean
}

export interface ModelReviewFinding {
  title: string
  detail: string
  file: number
  line: number
}

export interface ModelReviewResult {
  summary: string
  findings: ModelReviewFinding[]
}

export interface ModelReviewJob {
  id: string
  status: "prepared" | "running" | "completed" | "failed" | "cancelled"
  snapshot: ModelReviewSnapshot
  model?: string
  startedAt: string
  finishedAt?: string
  result?: ModelReviewResult
  error?: string
}

export type ModelReviewRecord = Omit<ModelReviewJob, "snapshot" | "result"> & {
  target: ModelReviewTarget
  head: string
  base: string
}
