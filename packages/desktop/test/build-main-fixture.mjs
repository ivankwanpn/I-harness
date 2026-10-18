// Build the real production main entry without starting a renderer or gateway.
import { writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveConfig } from "electron-vite"
import { build } from "vite"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const [outDir, reportFile] = process.argv.slice(2)
if (!outDir || !reportFile) throw new Error("expected an output directory and import report path")

process.env.NODE_ENV_ELECTRON_VITE = "production"
const { config } = await resolveConfig({ root: packageRoot, configFile: join(packageRoot, "electron.vite.config.ts"), logLevel: "silent" }, "build", "production")
if (!config?.main) throw new Error("production main config is missing")
// Retain electron-vite's production plugins, entry discovery and externalization.
// Only the destination changes so this test cannot overwrite Desktop's out/.
const result = await build({ ...config.main, build: { ...config.main.build, outDir, emptyOutDir: true } })
const outputs = Array.isArray(result) ? result : [result]
const chunks = outputs.flatMap(output => output.output).filter(item => item.type === "chunk").map(chunk => ({
  fileName: chunk.fileName,
  isEntry: chunk.isEntry,
  imports: chunk.imports,
  dynamicImports: chunk.dynamicImports,
}))
if (!chunks.some(chunk => chunk.isEntry)) throw new Error("production main build emitted no entry chunk")
writeFileSync(reportFile, `${JSON.stringify(chunks, null, 2)}\n`)
