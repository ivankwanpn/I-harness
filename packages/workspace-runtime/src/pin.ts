/** Verified against the official release's signed SHASUMS on 2026-10-09.
 * https://nodejs.org/download/release/v22.23.3/SHASUMS256.txt
 * https://nodejs.org/en/blog/release/v22.23.3
 * This pin changes only through a reviewed source update, never remote metadata.
 */
export const NODE_PIN = Object.freeze({
  version: "22.23.3", npmVersion: "10.9.9", architecture: "x64",
  archiveRoot: "node-v22.23.3-linux-x64",
  archiveFile: "node-v22.23.3-linux-x64.tar.gz",
  sha256: "1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af",
  url: "https://nodejs.org/download/release/v22.23.3/node-v22.23.3-linux-x64.tar.gz",
})
export const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024
export const MAX_EXPANDED_BYTES = 256 * 1024 * 1024
export const MAX_ARCHIVE_ENTRIES = 10_000
export const WRAPPERS: Readonly<Record<string, Buffer>> = Object.freeze(Object.fromEntries(["npm", "npx"].map(name => [
  `bin/${name}`,
  Buffer.from(`#!/bin/sh\nbasedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1\nexec "$basedir/node" "$basedir/../lib/node_modules/npm/bin/${name}-cli.js" "$@"\n`),
])))
