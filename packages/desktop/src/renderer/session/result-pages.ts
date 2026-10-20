import type { ResultPageQuery, ResultPageResult } from "@i-harness/sdk"

/** Bound presentation capability; never persisted in a timeline row. */
export interface RecordedResultReader {
  readonly workspaceId: string
  readonly sessionId: string
  readPage(query: ResultPageQuery): Promise<ResultPageResult>
}
