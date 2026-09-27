import { readFile, rename, writeFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { acquireSessionLock } from "@i-harness/fs-lock"
import { validateMcpConfig, type McpServerConfig } from "./types.ts"

export type PublicMcpConfig = Omit<Extract<McpServerConfig, { transport: "stdio" }>, "env"> | Omit<Extract<McpServerConfig, { transport: "streamable-http" }>, "headers" | "auth">
export interface McpSecretPatch { env?: Record<string, string | null>; headers?: Record<string, string | null> }
interface Entry { enabled: boolean; revision: number; config: McpServerConfig }
interface McpConfigRow { enabled: boolean; revision: number; config: PublicMcpConfig; secretKeys: string[] }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP configuration object")
  return value as Record<string, unknown>
}
function string(value: unknown, max = 4096): value is string { return typeof value === "string" && value.length <= max && !value.includes("\0") }
function map(value: unknown, patch = false): Record<string, string | null> {
  const input = record(value)
  if (Object.keys(input).length > 128) throw new Error("Too many MCP private fields")
  for (const [key, value] of Object.entries(input)) if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key) || (!string(value, 16384) && !(patch && value === null))) throw new Error("Invalid MCP private field")
  return input as Record<string, string | null>
}
function parse(value: unknown): PublicMcpConfig {
  const input = record(value)
  const common = ["transport", "serverName", "toolCallTimeoutMs", "catalogMaxItems", "catalogTimeoutMs", "failOnStartupError", "reconnect", "roots", "blockedTools", "directTools"]
  const fields = input.transport === "stdio" ? [...common, "command", "args", "cwd"] : [...common, "url"]
  if (!["stdio", "streamable-http"].includes(String(input.transport)) || Object.keys(input).some((key) => !fields.includes(key))) throw new Error("Unsupported MCP configuration field")
  if (!string(input.serverName, 64) || input.serverName.startsWith("plugin:")) throw new Error("Invalid or reserved MCP server name")
  if (input.transport === "stdio") {
    if (!string(input.command) || !input.command.trim() || !Array.isArray(input.args) || input.args.length > 128 || input.args.some((value) => !string(value))) throw new Error("Invalid MCP command or arguments")
    if (input.cwd !== undefined && (!string(input.cwd) || !input.cwd.trim())) throw new Error("Invalid MCP working directory")
  } else {
    if (!string(input.url, 8192)) throw new Error("Invalid MCP URL")
    let url: URL
    try { url = new URL(input.url) } catch { throw new Error("Invalid MCP URL") }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("MCP URL must use HTTP(S) without embedded credentials")
  }
  if (input.failOnStartupError !== undefined && typeof input.failOnStartupError !== "boolean") throw new Error("Invalid MCP startup preference")
  if (input.reconnect !== undefined && Object.keys(record(input.reconnect)).some((key) => !["enabled", "initialDelayMs", "maxDelayMs", "maxRetries"].includes(key))) throw new Error("Invalid MCP reconnect configuration")
  validateMcpConfig(input as unknown as McpServerConfig)
  return JSON.parse(JSON.stringify(input)) as PublicMcpConfig
}
function publicRow(row: Entry): McpConfigRow {
  if (row.config.transport === "stdio") {
    const { env, ...config } = row.config
    return { enabled: row.enabled, revision: row.revision, config, secretKeys: Object.keys(env ?? {}) }
  }
  const { headers, auth: _auth, ...config } = row.config
  return { enabled: row.enabled, revision: row.revision, config, secretKeys: Object.keys(headers ?? {}) }
}

/** Versioned local configuration; loading never connects or executes a server.
 * Private env/header values are returned only by active(), for backend mounting. */
export function createMcpConfigStore(path: string) {
  const file = resolve(path)
  const lockPath = `${process.platform === "win32" ? file.toLowerCase() : file}.lock`
  async function run<T>(operation: (rows: Entry[]) => T, write = false): Promise<T> {
    const lock = await acquireSessionLock({ lockPath, deadlineMs: 10000 })
    try {
      let raw: unknown
      try { raw = JSON.parse(await readFile(file, "utf8")) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read MCP settings document"); raw = { version: 1, servers: [] } }
      const doc = record(raw)
      if (doc.version !== 1 || !Array.isArray(doc.servers) || doc.servers.length > 100) throw new Error("Invalid MCP settings document")
      const rows = doc.servers.map((value): Entry => {
        const row = record(value), full = record(row.config)
        const { env, headers, ...publicConfig } = full
        const config = parse(publicConfig)
        if (typeof row.enabled !== "boolean" || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1) throw new Error("Invalid MCP settings entry")
        if (env !== undefined && config.transport !== "stdio" || headers !== undefined && config.transport !== "streamable-http") throw new Error("Invalid private MCP field")
        return { enabled: row.enabled, revision: row.revision as number, config: { ...config, ...(env === undefined ? {} : { env: map(env) as Record<string, string> }), ...(headers === undefined ? {} : { headers: map(headers) as Record<string, string> }) } }
      })
      if (new Set(rows.map((row) => row.config.serverName)).size !== rows.length) throw new Error("Duplicate MCP server names")
      const result = operation(rows)
      if (rows.length > 100) throw new Error("MCP server limit reached")
      if (write) {
        const temporary = `${file}.${randomUUID()}.tmp`
        try { await writeFile(temporary, JSON.stringify({ version: 1, servers: rows }, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, file) }
        finally { await rm(temporary, { force: true }) }
      }
      return result
    } finally { await lock.release() }
  }
  return {
    list: () => run((rows) => rows.map(publicRow)),
    active: () => run((rows) => rows.filter((row) => row.enabled).map((row) => row.config)),
    async save(value: unknown, secrets?: McpSecretPatch, expectedRevision?: number) {
      const config = parse(value)
      if (secrets !== undefined && Object.keys(record(secrets)).some((key) => key !== (config.transport === "stdio" ? "env" : "headers"))) throw new Error("Invalid MCP secret patch")
      const secretPatch = config.transport === "stdio" ? secrets?.env : secrets?.headers
      if (secretPatch !== undefined) map(secretPatch, true)
      return run((rows) => {
        const index = rows.findIndex((row) => row.config.serverName === config.serverName), old = rows[index]
        if (expectedRevision !== undefined && expectedRevision !== (old?.revision ?? 0)) throw new Error("MCP settings changed; reload before saving")
        const values: Record<string, string> = { ...(config.transport === "stdio" && old?.config.transport === "stdio" ? old.config.env : config.transport === "streamable-http" && old?.config.transport === "streamable-http" ? old.config.headers : {}) }
        for (const [key, value] of Object.entries(secretPatch ?? {})) { if (value === null) delete values[key]; else values[key] = value }
        map(values)
        const next: Entry = { enabled: old?.enabled ?? false, revision: (old?.revision ?? 0) + 1, config: { ...config, ...(config.transport === "stdio" ? { env: values } : { headers: values }) } }
        if (old) rows[index] = next; else rows.push(next)
        return publicRow(next)
      }, true)
    },
    setEnabled: (name: string, enabled: boolean) => run((rows) => { const row = rows.find((row) => row.config.serverName === name); if (!row || typeof enabled !== "boolean") throw new Error("Unknown MCP server or invalid flag"); row.enabled = enabled; return publicRow(row) }, true),
    remove: (name: string) => run((rows) => { const index = rows.findIndex((row) => row.config.serverName === name); if (index < 0) throw new Error("Unknown MCP server"); rows.splice(index, 1) }, true),
  }
}
