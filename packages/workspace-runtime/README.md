# Managed Linux workspace runtime

This package resolves or repairs an IH-owned Linux Node/npm runtime for a
captured WSL distribution. It does not run apt, sudo, change WSL configuration,
or install global system packages. Python3, Bash, bubblewrap and a usable WSL2
isolation profile remain prerequisites diagnosed by `sandbox-wsl`.

```ts
import { createWorkspaceRuntime } from "@i-harness/workspace-runtime"
const runtime = createWorkspaceRuntime({ cacheRoot: ownedCacheRoot })
const configuration = { distribution: "Ubuntu", workspaceDependencies: true }
const diagnostic = await runtime.diagnose(configuration)
const resolution = await runtime.resolve(configuration, { installIfMissing: true, signal })
// For a user-requested repair, including when system Node/npm already exist:
const repaired = await runtime.repair(configuration, { signal })
```

Results have `status: available | missing | disabled | unavailable` and an
actionable `detail`. Available results distinguish `source: managed | system`.
Managed results include a frozen `runtimePath` containing the inspected Linux
bin path, plus `path` and `nodeVersion`. Hosts pass this path into the captured
`wslExecution` of a new assembly. Existing executions retain their selected
release. Diagnosis does not download. Disabled configuration performs no WSL
inspection, cache read, download, or installation. Resolution uses a verified
managed release when present, otherwise usable system Node/npm; automatic
installation requires enabled workspace dependencies and missing Node/npm.
An explicit enabled repair also prepares the managed release on systems that
already have Node/npm.

The reviewed x64 pin is Node **22.23.3**, with bundled npm **10.9.9**. The fixed
official gzip archive has SHA-256
`1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af`, verified
against [official SHASUMS](https://nodejs.org/download/release/v22.23.3/SHASUMS256.txt)
and the [signed release page](https://nodejs.org/en/blog/release/v22.23.3).
Pins change through source review. Unsupported host architectures refuse.

Downloads use the fixed HTTPS URL without credentials or redirects, a 120-second
deadline, a 96 MiB compressed byte cap, and the pinned digest. Parsing admits at
most 256 MiB expanded bytes, 10,000 tar records, 128 MiB per member, and bounded
paths. Traversal, Windows stream/device paths, case aliases, hardlinks, devices
and unexpected symlinks refuse. The three exact official bin launcher symlinks
are validated and ignored. Only regular Node and npm-tree files are extracted;
regular LF npm/npx wrappers invoke the captured sibling Node executable.

The cache stores the verified compressed archive, immutable uniquely named
release directories, and an atomically promoted version-specific pointer. Each
resolution re-derives expected bytes from the pinned archive and checks the
entire installed tree, rather than trusting a mutable manifest or stale inventory.
Regular file/link counts and directory ancestry are checked. Repair creates a
new release when installed bytes are corrupt, preserving previous release bytes.
On Windows, a corrupt readonly archive is replaced only after checking the owned
root identity and an unaliased regular inode; outside links are never chmodded.
Installers share an OS lease. Lock validation reads metadata rather than its
locked byte, and cancellable acquisition owns at most a 250 ms wait interval.
Abort before download, during download or extraction refuses promotion and
releases the owned lease.

CLI and Desktop use explicit cache roots below their IH configuration directory.
Tests and qualification supply repository-owned `.tmp/wsl-product-integration-*`
roots. Cache pruning is intentionally absent: automatic repair does not remove
releases that a running execution may still have captured.
