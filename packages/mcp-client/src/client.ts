import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { ListResourcesResultSchema, ListToolsResultSchema, ReadResourceResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { createTransport } from "./transport.ts"
import type { McpServerConfig } from "./types.ts"

export interface McpTool {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpCallResult {
  content: unknown[]
  isError?: boolean
  structuredContent?: unknown
}

const RawCallToolResultSchema = z.object({
  content: z.array(z.unknown()),
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
})

export interface ConnectedMcpClient {
  listTools(cursor?: string): Promise<{ tools: McpTool[]; nextCursor?: string }>
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>
  listResources(server?: string, signal?: AbortSignal): Promise<unknown[]>
  readResource(server: string, uri: string, signal?: AbortSignal): Promise<unknown>
  close(): Promise<void>
  /**
   * Generation-death observation point: register a callback fired when the
   * underlying transport closes ON ITS OWN (server death). The SDK Client also
   * fires it for a deliberate close() — the reconnect supervisor distinguishes
   * those with its own guards. Optional so test fakes and custom clients can
   * omit it.
   */
  onDisconnect?(cb: () => void): void
}

export async function createConnectedClient(config: McpServerConfig): Promise<ConnectedMcpClient> {
  const transport = await createTransport(config)
  const client = new Client({ name: "i-harness-mcp-client", version: "0.1.0" })
  const timeout = config.toolCallTimeoutMs ?? 60_000
  // SDK Client (Protocol) fires `onclose` both when the transport dies on its
  // own and when close() is called deliberately — the supervisor treats
  // deliberate closes via its own guards, so this simply notifies observers.
  // Assigned BEFORE connect(): Protocol only reads `onclose` at fire time
  // (never overwrites it during connect), so installing it first leaves no
  // window in which an early transport death goes unobserved.
  const disconnectCallbacks: Array<() => void> = []
  client.onclose = () => {
    for (const cb of [...disconnectCallbacks]) cb()
  }
  await client.connect(transport)

  return {
    // Paginated shape (nextCursor) so syncTools can loop on cursor (Task 4).
    async listTools(cursor) {
      const response = await client.request(
        { method: "tools/list", params: cursor !== undefined ? { cursor } : {} } as never,
        ListToolsResultSchema,
      )
      return {
        tools: response.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        ...(response.nextCursor !== undefined ? { nextCursor: response.nextCursor } : {}),
      }
    },
    async callTool(name, args, signal) {
      const response = await client.request(
        { method: "tools/call", params: { name, arguments: args } } as never,
        RawCallToolResultSchema,
        { timeout, signal },
      )
      return {
        content: response.content,
        ...(response.isError !== undefined ? { isError: response.isError } : {}),
        ...(response.structuredContent !== undefined ? { structuredContent: response.structuredContent } : {}),
      }
    },
    async listResources(_server, signal) {
      const response = await client.request(
        { method: "resources/list", params: {} } as never,
        ListResourcesResultSchema,
        { timeout, signal },
      )
      return response.resources
    },
    async readResource(_server, uri, signal) {
      const response = await client.request(
        { method: "resources/read", params: { uri } } as never,
        ReadResourceResultSchema,
        { timeout, signal },
      )
      return response.contents
    },
    async close() {
      await client.close()
    },
    onDisconnect(cb) {
      disconnectCallbacks.push(cb)
    },
  }
}
