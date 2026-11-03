import { afterEach, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
// @ts-expect-error The packaging helper runs directly as native ESM JavaScript.
import { copyRuntimePackage, runtimePackageRoot } from "../scripts/runtime-copy.mjs"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const roots: string[] = []
const owner = "Desktop production main import closure test"
type Chunk = { fileName: string; isEntry: boolean; imports: string[]; dynamicImports: string[] }
type Resolution = { chunk: string; specifier: string; resolved?: string; error?: string }

afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(dirname(root)).toBe(tmpdir())
    expect(readFileSync(join(root, ".test-owner"), "utf8")).toBe(owner)
    rmSync(root, { recursive: true, force: true })
  }
})

it("resolves the production main bundle from the shipped app layout without workspace packages", () => {
  const root = mkdtempSync(join(tmpdir(), "ih-desktop-main-")); roots.push(root)
  writeFileSync(join(root, ".test-owner"), owner)
  const app = join(root, "resources/app"), main = join(app, "out/main"), report = join(root, "main-imports.json")
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, "package.json"), JSON.stringify({ type: "module", main: "./out/main/index.js" }))
  const built = spawnSync(process.execPath, [join(packageRoot, "test/build-main-fixture.mjs"), main, report], {
    cwd: packageRoot, encoding: "utf8", windowsHide: true, timeout: 30_000,
  })
  expect(built.status, `${built.error?.message ?? ""}\n${built.stdout}\n${built.stderr}`).toBe(0)
  const chunks = JSON.parse(readFileSync(report, "utf8")) as Chunk[]
  const localChunks = new Set(chunks.map(chunk => chunk.fileName))
  const externalImports = [...new Set(chunks.flatMap(chunk => [...chunk.imports, ...chunk.dynamicImports]).filter(name => !localChunks.has(name)))].sort()
  // These are runtime-owned dependencies, so bundling them would break the
  // Electron API or Koffi's native loader even if workspace resolution passed.
  expect(externalImports).toContain("electron")
  expect(externalImports).toContain("koffi")
  const koffi = runtimePackageRoot("koffi", packageRoot)
  for (const name of ["koffi", `@koromix/koffi-${process.platform}-${process.arch}`]) {
    copyRuntimePackage(name === "koffi" ? koffi : runtimePackageRoot(name, koffi), join(app, "node_modules", ...name.split("/")))
  }
  expect(existsSync(join(app, "node_modules/@i-harness"))).toBe(false)

  const resolutions: Resolution[] = []
  for (const chunk of chunks) {
    const imports = [...new Set([...chunk.imports, ...chunk.dynamicImports])]
    for (const name of imports.filter(name => localChunks.has(name))) expect(existsSync(join(main, name)), name).toBe(true)
    const resolver = join(dirname(join(main, chunk.fileName)), ".resolve-main-imports.mjs")
    // Running beside the emitted chunk uses Node's ESM resolver in an isolated
    // OS temp directory. Resolve only: never execute the app or start services.
    writeFileSync(resolver, `import { existsSync } from "node:fs"; import { fileURLToPath } from "node:url"; import { isAbsolute, relative } from "node:path";
const app = ${JSON.stringify(app)}; const results = [];
for (const specifier of ${JSON.stringify(imports.filter(name => !localChunks.has(name)))}) {
  if (specifier === "electron" || specifier.startsWith("electron/")) { results.push({ specifier, resolved: "electron:runtime" }); continue; }
  try {
    const resolved = import.meta.resolve(specifier);
    if (resolved.startsWith("file:")) {
      const file = fileURLToPath(resolved), inside = relative(app, file);
      if (!existsSync(file) || inside.startsWith("..") || isAbsolute(inside)) throw new Error("resolved outside shipped app or missing: " + resolved);
    }
    results.push({ specifier, resolved });
  } catch (error) { results.push({ specifier, error: error.code ?? error.message }); }
}
console.log(JSON.stringify(results));
`)
    const checked = spawnSync(process.execPath, [resolver], {
      cwd: root, env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" }, encoding: "utf8", windowsHide: true, timeout: 10_000,
    })
    expect(checked.status, `${checked.error?.message ?? ""}\n${checked.stderr}`).toBe(0)
    resolutions.push(...(JSON.parse(checked.stdout) as Omit<Resolution, "chunk">[]).map(result => ({ chunk: chunk.fileName, ...result })))
  }
  console.info("Production main external imports:", externalImports)
  expect(resolutions.filter(result => result.error), JSON.stringify(resolutions, null, 2)).toEqual([])
}, 45_000)
