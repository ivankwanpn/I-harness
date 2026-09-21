import type { Tool, ToolExec, ToolRegistry } from "@i-harness/core-tools"
import { publicToolName } from "./naming.ts"
import type { ConnectedMcpClient, McpTool } from "./client.ts"
import { MAX_CURSOR_LENGTH, MAX_TOOL_ITEMS, MAX_TOOL_PAGES, type McpServerConfig } from "./types.ts"
import { McpCatalogError } from "./errors.ts"

// Build one generation-local tool definition. Raw name sent on the wire; the
// public name is the model-facing registry name (never parsed back).
// M26-B1c: exposure 標記（direct/deferred）——reg.get 的 Tool 物件承載（registry 表面另有過濾）。
export function createMcpTool(
  client: ConnectedMcpClient,
  publicName: string,
  rawName: string,
  tool: McpTool,
  config: McpServerConfig,
  exposure?: "direct" | "deferred",
): Tool {
  return {
    name: publicName,
    description: tool.description ?? "MCP tool",
    // spec §3.8: this schema came from the REMOTE server verbatim. It is not
    // this repo's contract, so the assertion layer does not govern it — the
    // value layer still checks every keyword it recognises.
    inputSchemaForeign: true,
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    timeoutMs: config.toolCallTimeoutMs,
    ...(exposure !== undefined ? { exposure } : {}),
    async execute(args: unknown, exec: ToolExec) {
      const result = await client.callTool(rawName, args, exec.abortSignal)
      if (result.isError) {
        const text = JSON.stringify(result.content)
        throw new Error(`tool error: ${text}`)
      }
      return result.content
    },
  }
}

// Two-phase sync: fetch (drain cursor, no registry touch) → swap (dispose
// previous generation, register the new one).
//
// Registry-conflict behavior (spec §3.4, fail-closed):
// - initial sync (`previous` empty — no prior generation of this server): the
//   register throw PROPAGATES so the caller (mount, parent agent) can reject —
//   a squatted name must not be silently ignored at startup.
// - re-sync (`previous` populated): roll back to zero tools + log a warning and
//   return an empty map so an ordinary client keeps working.
export async function syncTools(
  client: ConnectedMcpClient,
  tools: ToolRegistry,
  config: McpServerConfig,
  previous: Map<string, () => void> = new Map(),
): Promise<Map<string, () => void>> {
  const serverName = config.serverName
  const next = new Map<string, { rawName: string; tool: McpTool }>()
  // M26-B1c: blocked/direct 過濾（Phase 1 打包：blocked 根本不進 next）。
  const blocked = new Set(config.blockedTools ?? [])
  const direct = new Set(config.directTools ?? [])
  const listedNames = new Set<string>() // Phase 1 逐一累積——供未知清單比對
  // Phase 1: fetch and build the next generation without touching the registry.
  // M6-D1: the cursor is SERVER-supplied, so the walk gets its defensive bounds
  // — a repeated cursor, an oversized cursor, an oversized catalogue (each a
  // McpCatalogError) and the page cap (unchanged: a plain Error at
  // MAX_TOOL_PAGES, which no honest server reaches).
  // M6-D2: the caps bound the WORK the server can make us do; this deadline
  // bounds the TIME it can spend doing it. Computed ONCE at drain start — a
  // server whose every page is merely slow fails inside this one budget, not
  // on a per-page timeout paid once per page — and each page request is handed
  // the REMAINING total (timeout = min(remaining, toolCallTimeoutMs), capped by
  // maxTotalTimeout = remaining), so a single hanging page cannot outlive the
  // budget. NOTE: that bound holds on the production path only because the
  // supervisor's proxy forwards these opts to the generation client — the proxy
  // is what every tool closure and this drain actually call (M6-D3 fixed the
  // proxy that used to drop the second argument).
  const deadline = Date.now() + (config.catalogTimeoutMs ?? 60_000)
  const pageTimeoutCap = config.toolCallTimeoutMs ?? 60_000
  let cursor: string | undefined
  let pages = 0
  const seenCursors = new Set<string>()
  let items = 0
  do {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new McpCatalogError("timeout", `mcp-client(${serverName}): catalogue drain exceeded its timeout`)
    }
    const response = await client.listTools(cursor, {
      timeout: Math.min(remaining, pageTimeoutCap),
      maxTotalTimeout: remaining,
    })
    for (const tool of response.tools) {
      listedNames.add(tool.name)
      if (blocked.has(tool.name)) {
        console.warn(`mcp-client(${serverName}): tool "${tool.name}" is blocked by config — not registered`)
        continue
      }
      const publicName = publicToolName(serverName, tool.name)
      if (next.has(publicName)) {
        throw new Error(`mcp-client(${serverName}): server listed tool "${tool.name}" more than once — invalid tool list`)
      }
      next.set(publicName, { rawName: tool.name, tool })
    }
    cursor = response.nextCursor
    if (cursor !== undefined) {
      // The very first `undefined` is not a cursor; only non-undefined values
      // are compared and remembered.
      if (cursor.length > MAX_CURSOR_LENGTH) {
        throw new McpCatalogError("cursor-cap", `server "${serverName}" returned a ${cursor.length}-char cursor (cap ${MAX_CURSOR_LENGTH})`)
      }
      if (seenCursors.has(cursor)) {
        throw new McpCatalogError("repeated-cursor", `server "${serverName}" repeated cursor "${cursor}" — the walk would never end`)
      }
      seenCursors.add(cursor)
    }
    // Every tool the server LISTED counts, blocked ones included: they were
    // listed, and the listing is the work this bound protects.
    items += response.tools.length
    const itemCap = config.catalogMaxItems ?? MAX_TOOL_ITEMS
    if (items > itemCap) {
      throw new McpCatalogError("items-cap", `server "${serverName}" listed ${items} tools, past the ${itemCap}-item cap`)
    }
    pages += 1
    if (pages > MAX_TOOL_PAGES) throw new Error(`mcp-client(${serverName}): tool list pagination exceeded ${MAX_TOOL_PAGES} pages`)
  } while (cursor !== undefined)
  // M26-B1c: 未知清單警告（拼寫錯誤 fail-loud 但不 fail-close）。
  for (const name of [...blocked, ...direct]) {
    if (!listedNames.has(name)) console.warn(`mcp-client(${serverName}): "${name}" is in blockedTools/directTools but the server never lists it`)
  }

  // Phase 2: swap generations.
  for (const dispose of previous.values()) dispose()
  const disposers = new Map<string, () => void>()
  try {
    for (const [publicName, { rawName, tool }] of next) {
      const exposure = direct.size > 0 && !direct.has(tool.name) ? "deferred" : "direct"
      tools.register(createMcpTool(client, publicName, rawName, tool, config, exposure))
      disposers.set(publicName, () => tools.unregister(publicName))
    }
  } catch (err) {
    // rollback: unregister everything registered so far in this generation
    for (const d of disposers.values()) d()
    console.warn(`mcp-client(${serverName}): registry conflict, rolled back — ${String(err)}`)
    if (previous.size === 0) {
      // Initial sync: fail closed per spec §3.4 — the conflict propagates so
      // the parent mount/agent rejects instead of silently running empty.
      throw err instanceof Error ? err : new Error(String(err))
    }
    return new Map()
  }
  return disposers
}
