import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { validateReleaseVersion } from "./release-version.mjs"

function inside(parent, child) {
  const tail = relative(parent, child)
  return !tail || tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function resolvePackagePaths(packageRoot, environment = process.env) {
  const repoRoot = resolve(packageRoot, "../..")
  const releaseLabel = environment.IH_DESKTOP_RELEASE_LABEL ?? "release"
  if (!/^release(?:-[a-z0-9-]+)?$/.test(releaseLabel)) throw new Error("invalid release folder label")
  const releaseDir = resolve(packageRoot, releaseLabel)
  if (dirname(releaseDir) !== packageRoot) throw new Error("release folder escaped the Desktop package")
  const explicit = environment.IH_DESKTOP_GATEWAY_DIR
  if (explicit !== undefined && (!isAbsolute(explicit) || /[\r\n\0"]/.test(explicit))) throw new Error("explicit gateway directory must be an absolute path without quotes or control characters")
  const gatewayDir = explicit === undefined ? join(packageRoot, ".gateway-dist") : resolve(explicit)
  if (!existsSync(gatewayDir) || !lstatSync(gatewayDir).isDirectory()) throw new Error(`gateway directory must be an existing runtime directory: ${gatewayDir}`)
  if (!samePath(realpathSync(gatewayDir), gatewayDir) || lstatSync(gatewayDir).isSymbolicLink()) throw new Error("gateway directory must be canonical, not a link or linked ancestor")
  if (!inside(realpathSync(repoRoot), gatewayDir) || samePath(realpathSync(repoRoot), gatewayDir)) throw new Error("gateway directory must remain inside the repository")
  if (existsSync(releaseDir) && (!lstatSync(releaseDir).isDirectory() || lstatSync(releaseDir).isSymbolicLink() || !samePath(realpathSync(releaseDir), releaseDir))) throw new Error("release output must be a canonical plain directory")
  // This fence runs before package-app is allowed to remove the release folder.
  if (inside(releaseDir, gatewayDir) || inside(gatewayDir, releaseDir)) throw new Error("gateway input and release output must not overlap")
  return { gatewayDir, releaseDir, appDir: join(releaseDir, "I-harness"), outDir: join(packageRoot, "out") }
}

export function validateGatewayRuntime(gatewayDir, version) {
  validateReleaseVersion(version)
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), entry = lstatSync(path)
      if (entry.isSymbolicLink()) throw new Error(`gateway runtime contains a link: ${path}`)
      if (entry.isDirectory()) walk(path)
      else if (!entry.isFile()) throw new Error(`unsupported gateway runtime entry: ${path}`)
    }
  }
  walk(gatewayDir)
  const requireFile = file => {
    const path = join(gatewayDir, file)
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size === 0) throw new Error(`missing or empty gateway runtime file: ${file}`)
    return path
  }
  const manifest = file => JSON.parse(readFileSync(requireFile(file), "utf8"))
  const gateway = manifest("cli/package.json")
  if (gateway.name !== "@i-harness/desktop-gateway" || gateway.version !== version) throw new Error("gateway manifest identity or version differs from the Desktop app")
  for (const file of ["cli/src/cli.ts", "cli/src/host.ts", "node_modules/tsx/dist/loader.mjs"]) requireFile(file)
  for (const name of ["tsx", ...Object.keys(gateway.dependencies ?? {})]) {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw new Error(`invalid gateway dependency name: ${name}`)
    if (manifest(`node_modules/${name}/package.json`).name !== name) throw new Error(`gateway dependency manifest mismatch: ${name}`)
  }
}
