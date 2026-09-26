# Desktop plugin marketplace integration

Approved scope: use existing plugin-registry/core-plugin and session-executor. No provider account usage/reset/OAuth. Local checkout only, no push, visual verification deferred.

## Design
Registry remains under the harness configuration home's plugins directory, shared by workspace gateways. Serialize cooperating gateway reads/writes through the existing fs-lock primitive in plugin-registry. Gateway exposes catalog/sources and explicit source add/refresh/remove and plugin install/uninstall/enable/disable. No network fetch or installation merely from opening the UI; official marketplace is an explicit add action.

Each fresh assembly reads current registry inputs. Existing converters map MCP and subagent declarations; skill overlays go into the existing skills option. Commands and trusted hooks must be wired through existing interaction/hooks APIs, with skipped/conflicting declarations visible. Enabling affects future assembly construction; never silently mutate a running task. UI describes that boundary, surfaces failures and confirms destructive removals.

## Tasks
- [x] Serialized registry adapter and local-fixture lifecycle tests.
- [ ] Gateway wire, capabilities, IPC validation, operation shutdown tracking.
- [ ] Assembly input callback in session-executor; mount skills/MCP/roles/commands/hooks using existing APIs and verify actual runtime behavior.
- [ ] Marketplace UI: source management, catalog search, installed/enabled status, capability/conflict details and lifecycle controls.
- [ ] Real gateway and mount tests, concurrency checks, review, package verification.

Backend checkpoint: plugin-registry/managed reuses the existing registry and OS file lock, orders cooperating gateway operations, validates state strictly before running them and drains accepted jobs on close. Corrupt state cannot be silently overwritten by a Desktop mutation. Local fixture test covers source/add/install/enable/runtime inputs/disable across two registry instances; no external fetch or plugin process was run. Gateway command adapter added, but deliberately not advertised by the host until actual assembly mount integration is present. Next: dynamic assembly inputs and commands/hooks/MCP/roles mount, then host wire and UI.
