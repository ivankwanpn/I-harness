# Desktop plugin marketplace integration

Approved scope: use existing plugin-registry/core-plugin and session-executor. No provider account usage/reset/OAuth. Local checkout only, no push, visual verification deferred.

## Design
Registry remains under the harness configuration home's plugins directory, shared by workspace gateways. Serialize cooperating gateway reads/writes through the existing fs-lock primitive in plugin-registry. Gateway exposes catalog/sources and explicit source add/refresh/remove and plugin install/uninstall/enable/disable. No network fetch or installation merely from opening the UI; official marketplace is an explicit add action.

Each fresh assembly reads current registry inputs. Existing converters map MCP and subagent declarations; skill overlays go into the existing skills option. Commands and trusted hooks must be wired through existing interaction/hooks APIs, with skipped/conflicting declarations visible. Enabling affects future assembly construction; never silently mutate a running task. UI describes that boundary, surfaces failures and confirms destructive removals.

## Tasks
- [x] Serialized registry adapter and local-fixture lifecycle tests.
- [ ] Gateway wire, capabilities, IPC validation, operation shutdown tracking.
- [x] Assembly input callback in session-executor; mount skills/MCP/roles/commands/hooks using existing APIs. Command execution and disposal tests pass; broader mount integration tests remain required.
- [ ] Marketplace UI: source management, catalog search, installed/enabled status, capability/conflict details and lifecycle controls.
- [ ] Real gateway and mount tests, concurrency checks, review, package verification.

Backend checkpoint: plugin-registry/managed reuses the existing registry and OS file lock, orders cooperating gateway operations, validates state strictly before running them and drains accepted jobs on close. Corrupt state cannot be silently overwritten by a Desktop mutation. Local fixture test covers source/add/install/enable/runtime inputs/disable across two registry instances; no external fetch or plugin process was run. Gateway command adapter added, but deliberately not advertised by the host until actual assembly mount integration is present. Next: dynamic assembly inputs and commands/hooks/MCP/roles mount, then host wire and UI.

Runtime checkpoint: session-executor now takes a fresh trusted extension snapshot per newly built assembly, awaits mount and owns async cleanup. A host prompt transformation uses interaction's parser/registered prompt command expansion before submitting to the agent lane. Gateway composes existing skill overlays, MCP config conversion and restricted subagent roles; registers commands; mounts plugin hooks through the existing trust store without auto-grant. Per-session diagnostics are bounded and exposed with registry state. Successful host mounts now advertise desktop-plugins and expose state/mutate routes. Test proves plugin command expansion is the durable prompt and extension snapshots/cleanup occur once per assembly. Gateway host5tests + command-mount test + extension lifecycle test and both typechecks passed. Desktop IPC/UI, actual marketplace round-trip, broader MCP/hook cases and final review remain unfinished.
