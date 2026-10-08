# WSL2 sandbox experiment acceptance

Client date: 2026-10-08. Branch: `codex/wsl2-sandbox-experiment`, from
`codex/sandbox-package-redesign` at `a78d663e`. This is an opt-in source experiment,
not a Desktop release or a claim that Windows Git Bash now works in native
Windows confinement.

## Result

On the existing Ubuntu WSL2 distribution, IH's actual execution supervisor ran
Linux Bash through the new `@i-harness/sandbox-wsl` backend. Read-only and
workspace-write filesystem effects, controlled network and Windows interop
denials, binary I/O, cancellation, root-exit cleanup and authority revocation
passed the final twelve-case qualification.

Host/runtime inventory: Windows 11 build 26200 x64; Ubuntu WSL2,
`6.6.87.2-microsoft-standard-WSL2`; Ubuntu 24.04.4; installed Python 3 and
bubblewrap 0.9.0. Linux Node and socat were absent. The experiment uses Python
standard library and no-network namespaces, so no Linux package installation
or distribution-wide configuration change was required.

## Implemented boundary

The Windows package captures the worker source in memory and communicates over
a bounded, versioned and nonce-checked control pipe. The Linux worker runs
bubblewrap under a trusted environment and applies requested workload variables
only inside isolation. Directory mounts use consumed descriptors; physical
locations and ancestor identities are revalidated before execution. Writable
inventories reject known hardlink aliases and unsupported layouts.

The workload sees PID/user/mount/network/IPC/UTS namespaces, a private proc/dev
view, dropped capabilities, seccomp restrictions on AF_UNIX/io_uring and masked
WSL interop paths. RO mounts grant no filesystem writes; WW opens only captured
workspace roots plus explicit namespace `/tmp`. Reads follow the existing
caller-readable contract. The guest destroys its owned PID namespace and drains
I/O before acknowledging settlement. The host requires acknowledgement and
launcher closure; neither root exit nor killing a Windows launcher substitutes
for guest cleanup evidence.

Known prelaunch refusal is distinct from failure: it rejects the operation,
closes captured resources and acknowledges empty cleanup. Malformed protocol,
missing acknowledgement or uncertain teardown stays incomplete. Bootstrap and
all native control writes have ten-second deadlines; stuck writes force pipe
EOF and bounded cleanup without inventing successful tree termination.

## Verification

| Check | Recorded result |
| --- | --- |
| Full real Ubuntu worker suite | 32 tests passed; final run 40.640 seconds, exit 0 |
| Full controller suite | 44 tests passed, including six actual Ubuntu integrations |
| Actual supervisor qualification | 12 cases passed, exit 0 |
| Existing requirement/lease/supervisor baseline | 155 tests passed |
| Package and qualification typechecks | Passed |
| Workspace recursive typechecks | Passed; existing task-order cycle warnings remain |
| Public reachability gate | Passed after three individually documented opt-in API declarations; baseline unchanged |
| Production dependency graph | 75 workspace packages, no production cycles; current CLI/Desktop roots reach 73 packages |

The experimental package is intentionally not reachable from default app
construction. Its real consumer is the explicit qualification script. Its
factory/backend/diagnostic names have dated reachability explanations, not a
claim of shipped default wiring.

The final supervisor record is
`.tmp/wsl2-qualification-Gor4SC/qualification.json`. An earlier passing record
is `.tmp/wsl2-qualification-UN53Rf/qualification.json`; the first compiled-policy
failure remains `.tmp/wsl2-qualification-tddIMh/qualification.json` and is not
counted as passing evidence. Worker/controller RED, GREEN and review records
are preserved in `.superpowers/sdd/2026-10-08-wsl2-sandbox-experiment/`.

The full repository test runner and packaged Desktop/installer tests were not
run for this isolated source experiment. This report asserts the listed checks,
not the outcomes of unexecuted platform or product tests.

## Material fixes found by tests and reviews

- An initial mount-source spelling retained directory descriptors in the
  workload. Native `--bind-fd`/`--ro-bind-fd` consumption fixed it; real FD and
  attempted host-mount reopening tests verify refusal.
- Pre-existing file hardlinks could modify a protected inode through a writable
  alias. Bounded no-follow inventories at preparation and commit refuse this.
- Passing task `LD_*` variables to bubblewrap allowed loader behavior before
  isolation. A real protected-sibling loader-write witness failed before the
  fix; trusted launcher environment and in-sandbox environment application close
  that boundary.
- Compiler-normalized Windows paths and original cwd spellings identified the
  same DrvFS directory but failed a string comparison. Verified identity and
  canonical mount spelling replace that comparison, preserving distinct Linux
  case-sensitive directories.
- Cached ancestry did not cover a parent move with unchanged child inode.
  Fresh descriptor-derived physical and ancestor validation closes it. The
  genuine RED witness used a private Linux tmpfs; the DrvFS variant already
  refused on this host and is documented as a behavior check.
- Normal prelaunch refusal previously poisoned cleanup, and blocked native
  control writes could wait before every response deadline. Explicit refusal
  acknowledgement, write deadlines and immediate pipe destruction now have
  focused regressions and truthful incomplete-ownership behavior.

Task reviews accepted the worker and controller after these fixes. Whole-branch
review is the remaining review gate before final branch delivery.

## Reproduce

```powershell
node --import tsx scripts/qualification/wsl2-sandbox/run.mts --distribution Ubuntu
$env:IH_WSL_TEST_DISTRIBUTION = 'Ubuntu'
node node_modules/vitest/vitest.mjs run --root packages/sandbox-wsl --config vitest.config.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/sandbox-wsl/tsconfig.json
```

The qualifier creates a fresh repository-local fixture and preserves its JSON
evidence. See `packages/sandbox-wsl/README.md` for the public construction API
and the worker test command.

## Limits

Only pipes, complete-tree lifetime, RO/WW policy and Linux argv are supported.
No network proxy, PTY, retained tree, unrestricted mode, general read/deny-path
isolation, Desktop settings integration or release packaging is supplied.

The hardlink inventory admits at most 4096 entries, 512 directories, depth 32
and a cooperative two-second scan. Canonical resolution permits 128 ancestor
levels, 8192 examined entries and a cooperative two-second budget per distinct
directory. Larger/changing/hardlinked/special/cross-device layouts refuse;
blocking filesystem operations can exceed cooperative timing. These are
experimental compatibility limits, including for some dependency trees.

Descriptor pinning and final validation are not an atomic host filesystem
snapshot. Concurrent trusted host filesystem changes after the final scan are
outside this experiment's guarantee. This is one-host qualification and does
not establish production security certification or compatibility with every
WSL distribution, Linux toolchain or Windows-backed project layout.
