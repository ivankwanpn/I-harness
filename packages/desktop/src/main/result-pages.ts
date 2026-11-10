import { parseResultPageQuery } from "@i-harness/sdk/results"
import type { ResultPageResult } from "@i-harness/sdk"
import type { WorkspaceRuntime } from "./sdk-runtime.ts"

/** Preflight precedes the resolver: resolving a workspace can start Gateway. */
export async function dispatchResultReadRequest(input: Record<string, unknown>, runtimeForKnownWorkspace: (workspaceId: string) => Promise<WorkspaceRuntime>): Promise<ResultPageResult> {
  const { kind, workspaceId, sessionId, ...fields } = input
  const validScope = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 1024 && !value.includes("\0")
  const query = parseResultPageQuery(fields)
  if (kind !== "session/result/read" || !validScope(workspaceId) || !validScope(sessionId) || !query) throw new Error("Invalid result page request")
  const runtime = await runtimeForKnownWorkspace(workspaceId)
  if (!runtime.info.capabilities["session-result-read"]?.includes(query.viaCatalog ? "2" : "1")) throw new Error("Result page reading unavailable")
  return runtime.client.request("session/result/read", { sessionId, ...query }) as Promise<ResultPageResult>
}
