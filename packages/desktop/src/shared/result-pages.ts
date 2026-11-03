import type { ResultPageQuery } from "@i-harness/sdk"

export type ResultReadRequest = { kind: "session/result/read"; workspaceId: string; sessionId: string } & ResultPageQuery
