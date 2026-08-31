// LSP tools: `lsp` (goToDefinition/findReferences/hover) + `lsp_diagnostics`
// (on-demand textDocument/diagnostic pull with an optional cursor-line filter).
// Both tools read the workspace only (no mutation) — marked isReadOnly +
// isConcurrencySafe (the instance serializes its own queue).
import { readFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { LspCallHierarchyItem, LspInstance, LspOperation, LspQuery } from "./instance.ts"
import { formatDiagnostics, formatHover, formatLocations, formatSymbols } from "./render.ts"

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
    // Derive the extension from the BASENAME so extensionless files error with
    // ".<no extension>" instead of the whole path's last dot segment.
    const base = basename(filePath)
    const dot = base.lastIndexOf(".")
    const ext = dot >= 0 ? base.slice(dot + 1) : "no extension"
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
        "Query a language server for precise code navigation. operation is one of goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, callHierarchy, incomingCalls, outgoingCalls. line and character are one-based UTF-16 cursor coordinates.",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["goToDefinition", "findReferences", "hover", "documentSymbol", "workspaceSymbol", "callHierarchy", "incomingCalls", "outgoingCalls"] },
          file_path: { type: "string" },
          line: { type: "number", minimum: 1 },
          character: { type: "number", minimum: 1 },
          query: { type: "string" },
          item: { type: "object", description: "callHierarchy 結果的整枚 item（incomingCalls/outgoingCalls 必填）" },
        },
        required: ["operation"],
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async execute(args: { operation: string; file_path?: string; line?: number; character?: number; query?: string; item?: unknown }, exec: ToolExec) {
        const operation = args.operation as LspOperation
        const needsPosition = operation === "goToDefinition" || operation === "findReferences" || operation === "hover" || operation === "callHierarchy"
        // 各 op 的必需參數缺 → 錯誤訊息指明（fail-loud）。
        if ((needsPosition || operation === "documentSymbol") && typeof args.file_path !== "string") {
          throw new Error(`lsp(${config.serverName}): operation ${operation} requires file_path`)
        }
        if (needsPosition && (typeof args.line !== "number" || typeof args.character !== "number")) {
          throw new Error(`lsp(${config.serverName}): operation ${operation} requires line and character`)
        }
        if (operation === "workspaceSymbol" && typeof args.query !== "string") {
          throw new Error(`lsp(${config.serverName}): workspaceSymbol requires query`)
        }
        if ((operation === "incomingCalls" || operation === "outgoingCalls") && (typeof args.item !== "object" || args.item === null)) {
          throw new Error(`lsp(${config.serverName}): ${operation} requires item (an object from a callHierarchy result)`)
        }
        const filePath = operation === "workspaceSymbol" || operation === "incomingCalls" || operation === "outgoingCalls"
          ? undefined
          : resolve(workspaceRoot, args.file_path!)
        if (filePath !== undefined) assertServesFile(config, filePath)
        const source = filePath !== undefined ? await readFile(filePath, "utf-8") : ""
        const query: LspQuery =
          operation === "documentSymbol"
            ? { operation, filePath: filePath! }
            : operation === "workspaceSymbol"
              ? { operation, query: args.query! }
              : operation === "callHierarchy"
                ? { operation, filePath: filePath!, line: args.line!, character: args.character! }
                : operation === "incomingCalls" || operation === "outgoingCalls"
                  ? { operation, item: args.item as LspCallHierarchyItem }
                  : { operation, filePath: filePath!, line: args.line!, character: args.character! }
        const result = await instance.query(query, source, exec.abortSignal)
        if (result.kind === "locations") return formatLocations(result, { workspaceRoot })
        if (result.kind === "hover") return formatHover(result, { workspaceRoot })
        if (result.kind === "symbols") return result.symbols.length === 0 ? "No symbols." : formatSymbols(result.symbols, { workspaceRoot })
        if (result.kind === "callHierarchy") return { items: result.items }
        if (result.kind === "calls") {
          // 結構化回傳：單個 site 用 formatLocations 的 "file:line:ch" 字串表示（模型不必回填來回 JSON）。
          return {
            direction: result.direction,
            target: { name: result.target.name, uri: result.target.uri },
            calls: result.calls.map((c) => ({
              from: { name: c.item.name, uri: c.item.uri },
              at: c.fromRanges[0] !== undefined ? formatLocations({ kind: "locations", locations: [{ uri: c.item.uri, range: c.fromRanges[0] }] }, { workspaceRoot }) : "?",
            })),
          }
        }
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
          line: { type: "number", minimum: 1 },
          character: { type: "number", minimum: 1 },
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
        // Cursor filter (1-based args → 0-based cursor): line present → keep
        // diagnostics whose range overlaps the cursor line; when character is
        // ALSO present → exact cursor-range filter, inclusive containment in
        // BOTH dimensions (the diagnostic must span the cursor character);
        // character alone is ignored.
        const cursorLine = args.line !== undefined ? args.line - 1 : undefined
        const cursorChar = args.line !== undefined && args.character !== undefined ? args.character - 1 : undefined
        const filtered =
          cursorLine !== undefined
            ? diagnostics.filter((d) => {
                if (d.range.start.line > cursorLine || d.range.end.line < cursorLine) return false
                if (cursorChar === undefined) return true
                return d.range.start.character <= cursorChar && d.range.end.character >= cursorChar
              })
            : diagnostics
        return formatDiagnostics(filtered, { workspaceRoot })
      },
    },
  ]
}
