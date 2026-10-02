import type { Tool, ToolRegistry } from "@i-harness/core-tools"
import type { CodeModeToolDefinition } from "./types.ts"

export function codeModeName(name: string): string {
  const value = name.replace(/[^a-zA-Z0-9_]/g, "_")
  return /^[0-9]/.test(value) ? `_${value}` : value
}
export function captureCodeModeTools(registry: ToolRegistry): Map<string, Tool> {
  const snapshot = new Map<string, Tool>(), aliases = new Map<string, string>()
  for (const row of [...registry.schemas(), ...registry.deferredSearchIndex()]) {
    const tool = registry.get(row.name)
    if (!tool || tool.exposure === "hidden" || tool.name === "code_exec" || tool.name === "code_wait") continue
    const name = codeModeName(tool.name), existing = aliases.get(name)
    if (!name || existing && existing !== tool.name) throw new Error(`ambiguous Code Mode tool name: ${tool.name}`)
    aliases.set(name, tool.name); snapshot.set(tool.name, tool)
  }
  return snapshot
}
export function codeModeDefinitions(snapshot: Map<string, Tool>): CodeModeToolDefinition[] {
  return [...snapshot.values()].map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.outputSchema === undefined ? {} : { outputSchema: t.outputSchema }) }))
}

const GUIDE = `Run a JavaScript ES module to compose IH tools. Each call has a fresh isolated JS context: no Node, process, filesystem, network, console, or imports. Use tools.<name>(args); punctuation uses underscore aliases. Allowed direct/deferred tools are in ALL_TOOLS with name, description and inputSchema. Inspect ALL_TOOLS to discover omitted schemas. Hidden tools and code_exec/code_wait are unavailable inside JS. Every tool uses existing session policy and approvals; policy refusal terminates the cell even if caught. Ordinary tool errors can be caught.
Helpers: text(value), image(dataURL or MCP image item or ImageInput), audio(dataURL or MCP audio item), store(key, JSONValue), load(key), notify(value), yield_control(), exit(), setTimeout(), clearTimeout(). Only emitted items enter the model result. Images are forwarded as images. Audio is recorded; existing text/image model adapters receive its metadata, not audio inference input. Store is bounded/process-local, committed on successful completion; globals are fresh. Await tools/Promises; unfinished unawaited work is discarded when the module ends. Long cells return status=running and cell_id: use code_wait to collect new output or terminate. Compaction preserves live cells; restart does not replay them. Termination does not undo side effects.
Example: text(await Promise.all([tools.read({path:"README.md"}),tools.read({path:"package.json"})]));
Optional first line: // @exec: {"yield_time_ms":10000,"max_output_tokens":4096}
Selected tool schemas (ALL_TOOLS contains the rest):`
export function codeModeDescription(registry: ToolRegistry): string {
  const declarations: string[] = []
  let bytes = Buffer.byteLength(GUIDE)
  for (const t of captureCodeModeTools(registry).values()) {
    const row = `${codeModeName(t.name)}: ${t.description}\ninputSchema: ${JSON.stringify(t.inputSchema)}`
    if (bytes + Buffer.byteLength(row) > 24_000) continue
    bytes += Buffer.byteLength(row); declarations.push(row)
  }
  return `${GUIDE}\n${declarations.join("\n\n")}`
}
