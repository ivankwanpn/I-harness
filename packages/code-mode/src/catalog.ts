import type { Tool, ToolRegistry } from "@i-harness/core-tools"
import type { CodeModeToolDefinition } from "./types.ts"

export function codeModeName(name: string): string {
  const value = name.replace(/[^a-zA-Z0-9_]/g, "_")
  return /^[0-9]/.test(value) ? `_${value}` : value
}
export const CODE_MODE_ORCHESTRATION_TOOLS = new Set(["code_exec", "code_wait", "code_status"])
export function captureCodeModeTools(registry: ToolRegistry): Map<string, Tool> {
  const snapshot = new Map<string, Tool>(), aliases = new Map<string, string>()
  for (const row of [...registry.schemas(), ...registry.deferredSearchIndex()]) {
    const tool = registry.get(row.name)
    if (!tool || tool.exposure === "hidden" || CODE_MODE_ORCHESTRATION_TOOLS.has(tool.name)) continue
    const name = codeModeName(tool.name), existing = aliases.get(name)
    if (!name || existing && existing !== tool.name) throw new Error(`ambiguous Code Mode tool name: ${tool.name}`)
    aliases.set(name, tool.name); snapshot.set(tool.name, tool)
  }
  return snapshot
}
export function codeModeDefinitions(snapshot: Map<string, Tool>): CodeModeToolDefinition[] {
  return [...snapshot.values()].map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.outputSchema === undefined ? {} : { outputSchema: t.outputSchema }) }))
}

const GUIDE = `Run a JavaScript ES module to compose IH tools in a fresh isolated context: no Node, process, filesystem, network, console, or imports. Call tools.<name>(args); punctuation uses underscore aliases. searchTools(query, limit=8) returns short metadata (max 20). describeTool(name or alias) returns one complete definition up to 16 KiB or a size error. ALL_TOOLS contains the captured authorized catalog. Discovery does not change direct exposure. Hidden tools and code_exec/code_wait/code_status are unavailable inside JS. Existing session policy and approvals apply; policy refusal terminates the cell even if caught. Ordinary tool errors can be caught.
Helpers: text(value), image(dataURL or image item), audio(dataURL or audio item), store(key, JSONValue), load(key), notify(value), yield_control(), exit(), setTimeout(), clearTimeout(). Only emitted items enter the model result. Images are forwarded; audio is recorded as metadata. Bounded JSON store commits after successful completion and resumes from session history; globals are fresh. Long admitted text has a bounded preview and textRetention reference; use context_output_read/search with contextRef when present, or grep with a legacy path. Retrieval uses current role/session policy. Await tools/Promises; unawaited work is discarded at module end. Running cells return cell_id: use code_wait for new output or termination, code_status to recover live IDs. Compaction preserves live cells; restart does not restore continuations. Termination does not undo side effects.
Example: text(await Promise.all([tools.read({path:"README.md"}),tools.read({path:"package.json"})]));
Optional first line: // @exec: {"yield_time_ms":10000,"max_output_tokens":4096}`
export function codeModeDescription(registry: ToolRegistry, mode: "mixed" | "only" = "mixed"): string {
  if (mode === "mixed") return GUIDE
  const declarations: string[] = []
  const heading = "\nSelected direct tool schemas (use describeTool for others):\n"
  let bytes = Buffer.byteLength(GUIDE + heading)
  const captured = captureCodeModeTools(registry)
  for (const schema of registry.schemas()) {
    const t = captured.get(schema.name)
    if (!t) continue
    const row = `${codeModeName(t.name)}: ${t.description}\ninputSchema: ${JSON.stringify(t.inputSchema)}`
    const rowBytes = Buffer.byteLength(row) + (declarations.length ? 2 : 0)
    if (bytes + rowBytes > 24_000) continue
    bytes += rowBytes; declarations.push(row)
  }
  return declarations.length ? `${GUIDE}${heading}${declarations.join("\n\n")}` : GUIDE
}
