import type { Tool } from "@i-harness/core-tools"
import type { SessionQuery } from "./index.ts"

export function createSessionQueryTools(query: SessionQuery): Tool[] {
  const sessionSearch: Tool = {
    name: "session_search",
    description: "full-text search over persisted session transcripts (event-level hits, BM25 relevance, snippets). Returns JSON hits.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        session_id: { type: "string" },
        subtree_of: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async (args: { query: string; session_id?: string; subtree_of?: string; limit?: number }) => {
      const hits = await query.search(args.query, {
        sessionId: args.session_id,
        subtreeOf: args.subtree_of,
        limit: args.limit,
      })
      return { hits }
    },
  }

  const lineageTool: Tool = {
    name: "lineage",
    description: "query the session hierarchy: ancestors (nearest-first), descendants (BFS), or children. Returns JSON nodes.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        direction: { type: "string", enum: ["ancestors", "descendants", "children"] },
        depth: { type: "integer" },
      },
      required: ["session_id"],
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async (args: { session_id: string; direction?: "ancestors" | "descendants" | "children"; depth?: number }) => {
      const nodes = await query.lineage(args.session_id, { direction: args.direction ?? "children", depth: args.depth })
      return { nodes }
    },
  }

  return [sessionSearch, lineageTool]
}
