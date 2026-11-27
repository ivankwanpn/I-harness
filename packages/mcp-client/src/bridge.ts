import type { Tool, ToolExec, ToolRegistry } from "@i-harness/core-tools"
import { declareToolResultOutcome, declareToolResultPresentation } from '@i-harness/core-tools'
import { diagnosticsFor } from "@i-harness/diagnostics"
import { publicToolName } from "./naming.ts"
import type { ConnectedMcpClient, McpTool } from "./client.ts"
import { MAX_CURSOR_LENGTH, MAX_TOOL_ITEMS, MAX_TOOL_PAGES, type McpServerConfig } from "./types.ts"
import { McpCatalogError } from "./errors.ts"

// W6 T6: ONE module-scope handle for this file's reports; the phase is
// `mount` because each is the MCP seam's own report about mounting a server:
// a tool the config blocks, a blocked/unlisted name, and a refused catalogue
// rollback. With nothing installed the handle delegates to console.warn
// verbatim (one argument), so unset mode is the pre-migration bytes.
const d = diagnosticsFor("mount")

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
      if (declareToolResultOutcome(exec, result.isError === true ? 'failed' : 'succeeded')) {
        declareToolResultPresentation(exec, 'mcp')
        return result
      }
      if (result.isError) {
        const text = JSON.stringify(result.content)
        throw new Error(`tool error: ${text}`)
      }
      return result.content
    },
  }
}

/** The disposer belongs to this registry and this particular tool definition. */
export function registerMcpTool(tools: ToolRegistry, tool: Tool): () => void {
  const name = tool.name
  tools.register(tool)
  return () => {
    if (tools.get(name) === tool) tools.unregister(name)
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
  const catalogue = await readToolCatalogue((cursor, opts) => client.listTools(cursor, opts), config)
  return installToolCatalogue(catalogue, client, tools, config, previous)
}

/** Fetch the whole list without changing the registry. */
export async function readToolCatalogue(listPage: ConnectedMcpClient["listTools"], config: McpServerConfig, signal?: AbortSignal) {
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
  // the REMAINING total: timeout = min(remaining, toolCallTimeoutMs), and
  // maxTotalTimeout = remaining alongside it.
  // MEASURED (SDK 1.30.0): `maxTotalTimeout` is INERT — the SDK reads it only
  // when the request options set `resetTimeoutOnProgress`, which these are not —
  // so the effective capper is `timeout`, and the bound must NOT be attributed
  // to it. It still rides along: a supported field, sent so the intent travels
  // with the request.
  // So a single hanging page cannot outlive the budget. NOTE: that bound holds
  // on the production path when these opts reach the selected generation.
  const deadline = Date.now() + (config.catalogTimeoutMs ?? 60_000)
  const pageTimeoutCap = config.toolCallTimeoutMs ?? 60_000
  let cursor: string | undefined
  let pages = 0
  const seenCursors = new Set<string>()
  let items = 0
  do {
    signal?.throwIfAborted()
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new McpCatalogError("timeout", `mcp-client(${serverName}): catalogue drain exceeded its timeout`)
    }
    const response = await listPage(cursor, {
      timeout: Math.min(remaining, pageTimeoutCap),
      maxTotalTimeout: remaining,
      ...(signal ? { signal } : {}),
    })
    signal?.throwIfAborted()
    for (const tool of response.tools) {
      listedNames.add(tool.name)
      if (blocked.has(tool.name)) {
        d.warn(`mcp-client(${serverName}): tool "${tool.name}" is blocked by config — not registered`)
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
    if (!listedNames.has(name)) d.warn(`mcp-client(${serverName}): "${name}" is in blockedTools/directTools but the server never lists it`)
  }

  return { serverName, direct, next }
}

/** The registry swap and the caller's publication of its disposers are synchronous. */
export function installToolCatalogue(
  catalogue: Awaited<ReturnType<typeof readToolCatalogue>>,
  client: ConnectedMcpClient,
  tools: ToolRegistry,
  config: McpServerConfig,
  previous: Map<string, () => void>,
): Map<string, () => void> {
  const { serverName, direct, next } = catalogue
  for (const dispose of previous.values()) dispose()
  const disposers = new Map<string, () => void>()
  try {
    for (const [publicName, { rawName, tool }] of next) {
      const exposure = direct.size > 0 && !direct.has(tool.name) ? "deferred" : "direct"
      const definition = createMcpTool(client, publicName, rawName, tool, config, exposure)
      disposers.set(publicName, registerMcpTool(tools, definition))
    }
  } catch (err) {
    // rollback: unregister everything registered so far in this generation
    for (const d of disposers.values()) d()
    d.warn(`mcp-client(${serverName}): registry conflict, rolled back — ${String(err)}`)
    if (previous.size === 0) {
      // Initial sync: fail closed per spec §3.4 — the conflict propagates so
      // the parent mount/agent rejects instead of silently running empty.
      throw err instanceof Error ? err : new Error(String(err))
    }
    return new Map()
  }
  return disposers
}
