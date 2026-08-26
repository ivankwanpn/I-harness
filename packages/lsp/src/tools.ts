// LSP tools: `lsp` (goToDefinition/findReferences/hover) + `lsp_diagnostics`
// (on-demand textDocument/diagnostic pull with an optional cursor-line filter).
// Both tools read the workspace only (no mutation) — marked isReadOnly +
// isConcurrencySafe (the instance serializes its own queue).
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { LspInstance, LspQuery } from "./instance.ts"
import { formatDiagnostics, formatHover, formatLocations } from "./render.ts"

export interface LspToolConfig {
  serverName: string
  command: string
  args: string[]
  cwd: string
  languages: string[]
}

/** True when `filePath`'s extension matches one of `config.languages`
 *  (leading dot stripped, case-insensitive); false otherwise. */
function servesExtension(filePath: string, languages: string[]): boolean {
  const dot = filePath.lastIndexOf(".")
  const ext = dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : ""
  return languages.some((lang) => lang.replace(/^\./, "").toLowerCase() === ext)
}

function assertServesFile(config: LspToolConfig, filePath: string): void {
  if (!servesExtension(filePath, config.languages)) {
    const dot = filePath.lastIndexOf(".")
    const ext = dot >= 0 ? filePath.slice(dot + 1) : filePath
    throw new Error(`LSP_NO_SERVER_FOR_FILE: no mounted server handles .${ext} files`)
  }
}

/** Build the `lsp` + `lsp_diagnostics` tools for one mounted server. The
 *  workspaceRoot is the base for resolving file_path (absolute paths pass
 *  through). execute() forwards exec.abortSignal to the instance. */
export function createLspTools(instance: LspInstance, config: LspToolConfig, workspaceRoot: string): Tool[] {
  return [
    {
      name: "lsp",
      description:
        "Query a language server for precise code navigation. operation is one of goToDefinition, findReferences, hover. line and character are one-based UTF-16 cursor coordinates.",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["goToDefinition", "findReferences", "hover"] },
          file_path: { type: "string" },
          line: { type: "number" },
          character: { type: "number" },
        },
        required: ["operation", "file_path", "line", "character"],
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async execute(args: { operation: LspQuery["operation"]; file_path: string; line: number; character: number }, exec: ToolExec) {
        const filePath = resolve(workspaceRoot, args.file_path)
        assertServesFile(config, filePath)
        const source = await readFile(filePath, "utf-8")
        const result = await instance.query(
          { operation: args.operation, filePath, line: args.line, character: args.character },
          source,
          exec.abortSignal,
        )
        if (result.kind === "locations") return formatLocations(result, { workspaceRoot })
        if (result.kind === "hover") return formatHover(result, { workspaceRoot })
        return "No results."
      },
    },
    {
      name: "lsp_diagnostics",
      description:
        "Get diagnostics for a file (on-demand LSP pull). line is optional (one-based): when present, only diagnostics overlapping the cursor line are shown. character is only used together with line.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          line: { type: "number" },
          character: { type: "number" },
        },
        required: ["file_path"],
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async execute(args: { file_path: string; line?: number; character?: number }, exec: ToolExec) {
        const filePath = resolve(workspaceRoot, args.file_path)
        assertServesFile(config, filePath)
        const source = await readFile(filePath, "utf-8")
        const diagnostics = await instance.diagnostics(filePath, source, exec.abortSignal)
        // Cursor-line filter (1-based line → 0-based cursor): keep diagnostics
        // whose range overlaps the cursor line; character alone is ignored.
        const cursorLine = args.line !== undefined ? args.line - 1 : undefined
        const filtered =
          cursorLine !== undefined
            ? diagnostics.filter((d) => d.range.start.line <= cursorLine && d.range.end.line >= cursorLine)
            : diagnostics
        return formatDiagnostics(filtered, { workspaceRoot })
      },
    },
  ]
}
