#!/usr/bin/env node
// Fails if the committed catalog is missing any registered tool.
import { readFileSync } from "node:fs"

const [, , registeredJsonPath, catalogMdPath] = process.argv
const registered = JSON.parse(readFileSync(registeredJsonPath, "utf-8")) as Array<{ name: string }>
const catalogText = readFileSync(catalogMdPath, "utf-8")

const missing = registered.filter((t) => !catalogText.includes(`| ${t.name} |`)).map((t) => t.name)
if (missing.length > 0) {
  console.error(`catalog completeness: missing tools: ${missing.join(", ")}`)
  process.exit(1)
}
console.log(`catalog complete (${registered.length} tools)`)
