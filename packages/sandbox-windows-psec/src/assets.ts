import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// The CLI bundle ships this package's assets in one fixed sibling directory.
// Source and Desktop package trees retain the package-owned location.
export const packageAssetRoot = resolve(dirname(fileURLToPath(import.meta.url)),
  process.env.I_HARNESS_DIST === "1" ? "sandbox-windows-psec" : "..")
