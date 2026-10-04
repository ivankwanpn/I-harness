#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(packageRoot, "..", "..")
const sourceManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
const appName = "I-harness Desktop"
export const testOwner = "I-harness.Desktop.Installer.Test.v1"
export const testMarker = ".ih-desktop-installer-test-owner.ini"

function absolutePath(value, label) {
  if (!isAbsolute(value) || /[\r\n\0"]/.test(value)) throw new Error(`${label} must be an absolute path without quotes or control characters`)
  return resolve(value)
}

function requireFile(root, path) {
  const target = join(root, path)
  if (!existsSync(target) || !lstatSync(target).isFile() || statSync(target).size === 0) throw new Error(`missing or empty payload file: ${path}`)
  return target
}

function manifestAt(root, path) {
  const target = requireFile(root, path)
  try { return JSON.parse(readFileSync(target, "utf8")) }
  catch { throw new Error(`invalid payload manifest: ${path}`) }
}

export function validatePayload(input) {
  const appDir = absolutePath(input, "app directory")
  if (!existsSync(appDir) || !lstatSync(appDir).isDirectory() || lstatSync(appDir).isSymbolicLink()) throw new Error("app directory must be an existing plain directory, not a link")
  const files = [], directories = []
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name)
      const entry = lstatSync(absolute)
      if (entry.isSymbolicLink()) throw new Error(`payload contains a link: ${relative(appDir, absolute)}`)
      if (/[\r\n\0"]/.test(name)) throw new Error(`unsupported payload filename: ${name}`)
      if (entry.isDirectory()) { directories.push(relative(appDir, absolute)); walk(absolute) }
      else if (entry.isFile()) files.push({ path: relative(appDir, absolute), bytes: entry.size })
      else throw new Error(`unsupported payload entry: ${relative(appDir, absolute)}`)
    }
  }
  walk(appDir)
  const required = [
    `${appName}.exe`, "version", "chrome_100_percent.pak", "chrome_200_percent.pak",
    "d3dcompiler_47.dll", "dxcompiler.dll", "dxil.dll", "ffmpeg.dll", "icudtl.dat",
    "resources.pak", "v8_context_snapshot.bin", "snapshot_blob.bin", "vk_swiftshader.dll",
    "vulkan-1.dll", "LICENSE", "LICENSES.chromium.html", "locales/en-US.pak",
    "resources/app/out/main/index.js", "resources/app/out/preload/index.cjs", "resources/app/out/renderer/index.html",
    "resources/app/out/main/attachment-reader-worker.mjs", "resources/app/out/main/pdf.worker.mjs",
    "resources/app/out/main/node_modules/@napi-rs/canvas/package.json",
    "resources/app/LICENSE", "resources/app/THIRD_PARTY_NOTICES",
    "resources/app/licenses/opencode/LICENSE", "resources/app/licenses/zcode/LICENSE",
    "resources/gateway/cli/src/cli.ts", "resources/gateway/cli/src/host.ts",
    "resources/gateway/node_modules/tsx/package.json", "resources/gateway/node_modules/tsx/dist/loader.mjs",
  ]
  for (const path of required) requireFile(appDir, path)
  for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
    const path = join("resources", "app", "out", "main", directory)
    if (!files.some(file => file.path.startsWith(`${path}${sep}`))) throw new Error(`missing or empty payload directory: ${path}`)
  }
  const executable = openSync(join(appDir, `${appName}.exe`), "r")
  try {
    const header = Buffer.alloc(2)
    readSync(executable, header, 0, 2, 0)
    if (header.toString("ascii") !== "MZ") throw new Error("Desktop executable is not a Windows executable")
  } finally { closeSync(executable) }
  const app = manifestAt(appDir, "resources/app/package.json")
  if (app.name !== "@i-harness/desktop" || app.productName !== appName || app.main !== "./out/main/index.js" || app.type !== "module") throw new Error("payload app manifest does not identify the Desktop entry point")
  if (app.version !== sourceManifest.version || !/^\d+\.\d+\.\d+$/.test(app.version)) throw new Error(`payload version ${app.version} differs from Desktop source version ${sourceManifest.version}, or is unsupported`)
  const electronVersion = readFileSync(join(appDir, "version"), "utf8").trim()
  if (electronVersion !== sourceManifest.devDependencies.electron) throw new Error(`Electron version ${electronVersion} differs from ${sourceManifest.devDependencies.electron}`)
  const gateway = manifestAt(appDir, "resources/gateway/cli/package.json")
  if (gateway.name !== "@i-harness/desktop-gateway" || gateway.version !== app.version) throw new Error("gateway manifest identity or version differs from the Desktop app")
  for (const name of Object.keys(gateway.dependencies ?? {})) {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw new Error(`invalid gateway dependency name: ${name}`)
    const dependency = manifestAt(appDir, `resources/gateway/node_modules/${name}/package.json`)
    if (dependency.name !== name) throw new Error(`gateway dependency manifest mismatch: ${name}`)
  }
  return { appDir, version: app.version, electronVersion, files, directories, fileCount: files.length, payloadBytes: files.reduce((sum, file) => sum + file.bytes, 0) }
}

export function validateTestRoot(input) {
  const testRoot = absolutePath(input, "test root")
  const parent = join(repoRoot, ".tmp")
  const ownedRelative = relative(parent, testRoot)
  if (!ownedRelative || ownedRelative.startsWith(`..${sep}`) || ownedRelative === ".." || isAbsolute(ownedRelative)) throw new Error("test root must be inside the repository .tmp directory")
  if (!existsSync(testRoot) || lstatSync(testRoot).isSymbolicLink() || realpathSync(testRoot).toLowerCase() !== testRoot.toLowerCase()) throw new Error("test root must be an existing plain owned directory")
  const marker = readFileSync(join(testRoot, testMarker), "utf8")
  const token = /^Token=([a-f0-9-]{36})$/m.exec(marker)?.[1]
  if (!marker.split(/\r?\n/).includes(`Owner=${testOwner}`) || !token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(token)) throw new Error("test root ownership marker is missing or invalid")
  return { testRoot, token }
}

function nsisString(value) { return value.replaceAll("$", () => "$$").replaceAll('"', '$\\"').replaceAll("/", "\\") }
function hashFile(path) { return createHash("sha256").update(readFileSync(path)).digest("hex") }
function compilerPath(explicit) {
  const candidates = explicit ? [absolutePath(explicit, "NSIS compiler")] : [
    ...(process.env.IH_NSIS_MAKENSIS ? [absolutePath(process.env.IH_NSIS_MAKENSIS, "NSIS compiler")] : []),
    join(repoRoot, "build", "tools", "makensis", "makensis.exe"),
    join(repoRoot, "build", "tools", "nsis-3.11", "nsis-3.11", "makensis.exe"),
    ...(spawnSync("where.exe", ["makensis.exe"], { encoding: "utf8", windowsHide: true }).stdout?.trim().split(/\r?\n/).filter(Boolean) ?? []),
  ]
  const compiler = candidates.find(path => existsSync(path) && lstatSync(path).isFile())
  if (!compiler) throw new Error("NSIS 3 compiler not found; pass --nsis <absolute makensis.exe> from the official NSIS archive")
  const result = spawnSync(compiler, ["/VERSION"], { encoding: "utf8", windowsHide: true })
  if (result.status !== 0 || !/^v?3\.\d+/.test(result.stdout.trim())) throw new Error("NSIS 3 compiler version check failed")
  return { path: compiler, version: result.stdout.trim(), sha256: hashFile(compiler) }
}

export function buildInstaller(options) {
  const payload = validatePayload(options.appDir ?? join(packageRoot, "release", appName))
  const isolated = options.testRoot ? validateTestRoot(options.testRoot) : null
  const outDir = absolutePath(options.outDir ?? join(packageRoot, "release"), "output directory")
  const outputRelative = relative(payload.appDir, outDir)
  if (!outputRelative || outputRelative !== ".." && !outputRelative.startsWith(`..${sep}`) && !isAbsolute(outputRelative)) throw new Error("installer output directory must be outside the app payload")
  if (options.validateOnly) {
    const { files, directories, ...summary } = payload
    return summary
  }
  if (process.platform !== "win32") throw new Error("the Desktop Windows installer must be compiled on Windows")
  const identity = createHash("sha256").update(`I-harness.Desktop.Installer.v1\0${hashFile(join(packageRoot, "installer", "desktop.nsi"))}\0${payload.version}\0`)
  for (const file of payload.files) identity.update(`${file.path.replaceAll("\\", "/")}\0${hashFile(join(payload.appDir, file.path))}\n`)
  const payloadId = identity.digest("hex")
  const compiler = compilerPath(options.nsis)
  const staging = join(repoRoot, "build", "desktop-installer", randomUUID())
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(staging, ".build-owner"), "I-harness Desktop installer build v1\n")
  mkdirSync(outDir, { recursive: true })
  const filename = `I-harness-Desktop-Setup-${payload.version}${isolated ? "-test" : ""}.exe`
  const output = join(outDir, filename)
  const installInclude = join(staging, "payload-install.nsh")
  const removeInclude = join(staging, "payload-remove.nsh")
  const directoryInclude = join(staging, "payload-directories.nsh")
  const conflictInclude = join(staging, "payload-conflicts.nsh")
  const orderedFiles = [...payload.files.filter(file => file.path !== `${appName}.exe`), ...payload.files.filter(file => file.path === `${appName}.exe`)]
  writeFileSync(installInclude, orderedFiles.map(file => `SetOutPath "$INSTDIR\\${nsisString(dirname(file.path) === "." ? "" : dirname(file.path))}"\nFile "/oname=${nsisString(file.path.split(sep).at(-1))}" "${join(payload.appDir, file.path)}"`).join("\n") + "\n")
  writeFileSync(removeInclude, payload.files.map(file => `!insertmacro RemoveOwnedFile "${nsisString(file.path)}"`).join("\n") + "\n" + [...payload.directories].sort((a, b) => b.split(sep).length - a.split(sep).length).map(path => `RMDir "$INSTDIR\\${nsisString(path)}"`).join("\n") + "\n")
  writeFileSync(directoryInclude, payload.directories.map(path => `!insertmacro CheckPayloadDirectory "${nsisString(path)}"`).join("\n") + "\n")
  writeFileSync(conflictInclude, payload.files.map(file => `!insertmacro RefuseExistingFile "${nsisString(file.path)}"`).join("\n") + "\n")
  const definitions = {
    APP_VERSION: payload.version, PAYLOAD_ID: payloadId, OUTPUT_FILE: output, PAYLOAD_INSTALL: installInclude,
    PAYLOAD_REMOVE: removeInclude, PAYLOAD_DIRECTORIES: directoryInclude, PAYLOAD_CONFLICTS: conflictInclude,
    ESTIMATED_SIZE: Math.ceil(payload.payloadBytes / 1024),
    ...(isolated ? { TEST_ROOT: isolated.testRoot, TEST_TOKEN: isolated.token, TEST_HOOKS: join(packageRoot, "test", "installer-fixture-hooks.nsh") } : {}),
  }
  const args = ["/NOCONFIG", "/WX", "/V3", "/INPUTCHARSET", "UTF8", ...Object.entries(definitions).map(([key, value]) => `/D${key}=${key === "TEST_ROOT" ? nsisString(String(value)) : value}`), join(packageRoot, "installer", "desktop.nsi")]
  const result = spawnSync(compiler.path, args, { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  writeFileSync(join(staging, "compile.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`)
  if (result.error || result.status !== 0 || !existsSync(output)) throw new Error(`NSIS compile failed (${result.status}): ${result.error?.message ?? result.stderr ?? result.stdout}\nLog: ${join(staging, "compile.log")}`)
  const metadata = {
    schemaVersion: 1, product: appName, version: payload.version, electronVersion: payload.electronVersion,
    appDir: payload.appDir, output, bytes: statSync(output).size, sha256: hashFile(output),
    payloadFiles: payload.fileCount, payloadBytes: payload.payloadBytes,
    payloadId,
    payloadExeSha256: hashFile(join(payload.appDir, `${appName}.exe`)),
    nsis: compiler, isolatedTest: Boolean(isolated), staging, builtAt: new Date().toISOString(),
  }
  writeFileSync(output.replace(/\.exe$/, ".installer-build.json"), `${JSON.stringify(metadata, null, 2)}\n`)
  writeFileSync(`${output}.sha256`, `${metadata.sha256}  ${filename}\n`)
  return metadata
}

function parseArguments(args) {
  const options = {}
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "--validate-only") options.validateOnly = true
    else if (["--app-dir", "--out-dir", "--nsis", "--test-root"].includes(argument)) {
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`)
      options[{ "--app-dir": "appDir", "--out-dir": "outDir", "--nsis": "nsis", "--test-root": "testRoot" }[argument]] = value
    } else throw new Error(`unknown installer argument: ${argument}`)
  }
  return options
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(buildInstaller(parseArguments(process.argv.slice(2))), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
