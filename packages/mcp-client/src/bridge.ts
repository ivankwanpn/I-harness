import type { Tool, ToolExec, ToolRegistry } from "@i-harness/core-tools"
import { publicToolName } from "./naming.ts"
import type { ConnectedMcpClient, McpTool } from "./client.ts"
import type { McpServerConfig } from "./types.ts"

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
  let cursor: string | undefined
  let pages = 0
  do {
    const response = await client.listTools(cursor)
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
    pages += 1
    if (pages > 100) throw new Error(`mcp-client(${serverName}): tool list pagination exceeded 100 pages`)
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
