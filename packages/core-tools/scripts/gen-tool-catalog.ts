#!/usr/bin/env node
// Generates the model-visible tool catalog document from a registry snapshot.
// Usage: gen-tool-catalog <tools-json> <out-md>
import { readFileSync, writeFileSync } from "node:fs"

const [, , toolsJsonPath, outMdPath] = process.argv
const tools = JSON.parse(readFileSync(toolsJsonPath, "utf-8")) as Array<{ name: string; description: string; inputSchema: unknown }>

const rows = tools.map((t) => `| ${t.name} | ${t.description} | \`${JSON.stringify(t.inputSchema)}\` |`).join("\n")
const md = `# Tool Catalog\n\n| Name | Description | Schema |\n|---|---|---|\n${rows}\n`
writeFileSync(outMdPath, md, "utf-8")
console.log(`wrote ${outMdPath} (${tools.length} tools)`)
