# Desktop host reproducibility and conversation management — 2026-10-11

## Scope and source evidence

This work follows the external third-round report
`I-HARNESS-ENV-TEST-REPORT-fc8a428.md`, based on main commit
`fc8a428b8ac578e9e740a342f2d39d56b65f3293`. The report and its clone were read
as evidence, without changing or executing that clone. The installed app,
settings and real conversation data are outside the test fixtures. Desktop and
gateway version remain 0.1.7.

The follow-up request adds verification of Execution and Permissions settings
and a visual revision of Manage Conversations. The management design retains
the existing operation permissions and storage scope, with a wider responsive
dialog, a fixed toolbar and compact rows. Conversation identity is secondary
information, while title, project and update time have priority.

## Causes reproduced before repair

- The PowerShell availability guard launched bare `pwsh`. With only the
  Windows system directory on PATH, it reproduced `Windows helper: executable
  path must be absolute`. The production PowerShell tool already resolves the
  installed runtime, including Windows PowerShell 5.1. The guard now uses that
  same resolver and disposes its execution service; all seven workspace-cwd
  cases pass, including the controlled PATH regression.
- Putting the actual WindowsApps PowerShell alias first on PATH reproduced the
  full Desktop child-authority fixture's 20-second timeout. Discovery repeatedly
  started an alias whose canonical executable identity cannot be read. Probe
  calls accumulated during prompt/context construction and child steps. Checking
  identity before launching a discovery probe excludes that unusable alias
  without caching stale executable choices or changing the deadline.
  The controlled run recorded 348 alias probes taking 57,033 ms cumulatively;
  after repair, the same eleven tests passed with zero alias probes. The
  [sanitized reproduction record](evidence/2026-10-11-host-fixture-reproduction.json)
  preserves the boundary timings and regression outcomes for comparison.
- The external Code Mode `only` failure is a transport rejection, not a timeout:
  its loopback port was rejected by the prior `mixed` fixture's global fetch
  guard. A timed-out asynchronous test still awaited host cleanup, leaving its
  guard installed while the next fixture started. The fixture transport must
  remain local and isolated even while a prior fixture is closing.
  Each host now owns an exact-origin transport, including redirect rejection.
  The Code Mode model deliberately requests zero-yield execution and waits
  through `code_wait` until completion. Pending host creation is registered
  before awaiting it; cleanup fences new creation and drains every owner even
  when one close fails, before removing fixture files.
- Launching the original ConPTY INT test from an owned process with
  `SetConsoleCtrlHandler(NULL, TRUE)` reproduced its 15-second wait failure:
  `INT_READY` appeared but `INT_RECEIVED` did not. The ignore-Ctrl+C attribute is
  inherited by children. The helper now clears that inherited attribute only
  before launching its owned ConPTY process. The ETX signal transport, suspended
  launch and Job ownership remain intact. An owned candidate received SIGINT,
  exited with the fixture's code 23 and settled its process tree and I/O.
  [Microsoft's console-control contract](https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler)
  documents the inherited attribute.
  The external launcher's attribute was not directly observed; this establishes
  a matching controlled cause, not the identity of that external ancestor.
  Regression launchers use retained native complete-tree Job ownership, with
  one absolute eight-second body deadline and a cleanup budget. A delayed ready
  marker plus missing acknowledgement settles before the outer deadline. An
  outer timeout kills the owned controller and its nested child while honestly
  retaining incomplete inner-cleanup evidence. Recorded PIDs only provide
  observations and never authorize termination.
- ApprovalRuleManager compared only workspace IDs when a mutation completed.
  An A→B→A visit could let the first A request display its failure and unlock a
  newer A operation. A controlled pending-request regression reproduced both
  ownership problems. A visit generation now fences reloads, errors and lock
  release. The current operation retains its busy state until its own reply.

## Conversation management

Manage Conversations now uses a 900px responsive dialog with a bounded list.
Its scope disclosure, active/archived tabs and batch toolbar remain fixed while
rows scroll. Rows show titles, known projects, reported timestamps and turn
counts; IDs and individual actions are in the More menu. The active listing does
not report timestamps, so the UI displays its project and turn count instead of
inventing activity dates. Archived rows retain their reported timestamps.

The list scrollbar uses the conversation view's rounded thumb, symmetric 16px
inset and hidden arrows. Rename, archive, restore, fork, rewind, move and deletion
retain their existing capability, confirmation and source-folder requirements.
The 100-session batch limit remains enforced. Rejected stale single/batch
operations cannot update a later A→B→A visit. Portaled menus retain composition
safe Escape, arrow navigation and focus restoration. A removed destination or a
disabled preferred item falls back to the first enabled menu item without
silently selecting or moving to another project.

Independent review found and prompted corrections to the removed-project focus
fallback, fixture deadline budgeting and PID-based defensive cleanup. Those
findings were fixed and independently rechecked before complete verification.

## Actual packaged desktop checks

Seventeen actual Electron checks passed against the final packaged 0.1.7 app,
using isolated settings, profile and workspace, and only a local fixture model.
They cover bounded archived rows, fixed controls during scrolling, scrollbar
appearance, native keyboard menu navigation, persisted rename, confirmed batch
move, restored archive state and an 800×640 viewport. The setting checks verify
Context Mode and Code Context save/application, backend defaults preserving an
existing legacy binding, full-access approval/sandbox pairing and narrowing,
absolute PowerShell selection, and saved versus captured Code Mode.

The run recorded three local model requests and no paid or external provider
calls. Test-controller errors (an Electron arrow-key name, a confirmation label
and selector quoting/loading) were corrected without relaxing product
assertions; the same final app and fixture retained already completed cases.
Screenshots were inspected after refreshing the hidden window's compositor.
The entry shim was removed and the original app manifest restored after exit.

WSL's installed Ubuntu distribution reports WSL2 and Stopped. The GUI checks
establish WSL selection and saving, not successful Linux command execution.
Fresh native qualification remains historical evidence from one host:
39 passed, zero failed, four unsupported, experimental and incomplete. It is
not promoted to a general security or platform-support claim.

## Verification record

Fresh `pnpm verify:all` completed with **6,134 passed, 21 existing skips, zero
failed**, with all **78 of 78** workspace projects reporting. Typecheck exited
zero; all six e2e files passed; the reachability gate passed at 423 rows with no
new allowlist exemptions. The complete command used the repository's serial
workspace scheduling and two Vitest workers. Desktop reported 1,145 passed and
three existing skips; Desktop gateway reported 427 passed.

The terminal regressions were also exercised under Node 22.23.2 and 24.15.0.
Normal inherited INT, delayed readiness/missing acknowledgement, and forced
outer timeout pass under both runtimes. Rust native tests passed 27 cases;
fresh native qualification reported 39 passed, zero failed and four unsupported.
Native source and asset identities match the helper
`4d4e990b8050628f6004c14fa7632e1f9bd71a3233b237c365ed86590726afb6`,
protocol `6b0d187edb52222b72bbdc5b6aa777113dd9ac19fa2a5cfa5251013f19e35991`
and unchanged MSYS template
`6fa3b1f2fc15868cd09e873cef625c6ced400f36c0c67c2c92ce9282231ce186`.
All eighteen native source hashes were independently checked.

The separate `packages/desktop/release-0-1-7-host-management` output contains
the installation candidate, portable ZIP, inspected screenshots, complete
verification log, packaged UI record and payload validation. Runtime source,
compiled output, native assets, qualification record and every portable ZIP
entry are checked against the unpacked payload. The packaged manifest must have
the original `./out/main/index.js` entry, with no QA entry file remaining.
The complete verifier rebuilds the attachment reader from the repository cwd;
its esbuild module-path labels differ from the package-cwd distribution build.
The package is refreshed with that exact verified worker before regenerating
the ZIP and installer, so delivered bytes agree with the tested output.

These results establish the repaired conditions and this candidate on the
current host. They do not establish that the external clone or installed user
app has already rerun the fixes; the external report and user data remain
untouched.
