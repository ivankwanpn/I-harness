# Live plugin enablement

User correction: enabling/disabling plugins and slash commands must affect existing agents immediately, following the behavior inspected in D:/deepseek-harness. This replaces the previous fresh-assembly-only rule. No GitHub push; change existing owning packages in D:/frontend-test. Hook trust remains independent of enablement.

## Reference findings
DSH plugin-marketplace setPluginEnabled updates loader patch rows and moves skill directories. app-boot watchUserPatches re-reads patches, updates the existing Include, awaits loader/fiber settlement and reports inactive entries. Skills have live filesystem discovery. Commands are plugin-owned registrations with disposal. Our implementation uses equivalent ownership and update semantics through our existing packages, not Cordis/private dependencies.

## Contract
- Mutation acknowledgement waits for the local host's existing assemblies to consume current registry inputs. Other workspace hosts observe state-file changes and converge without restart.
- Keep the same Session and Agent instances, history, model binding and active turn. Capability changes appear to subsequent command dispatches and model steps; an already-started call may finish or be aborted by its original transport shutdown.
- Skills use updated overlay roots. MCP connections are diffed by server/config; unchanged servers remain mounted. Removed servers unregister their tools and close transports. Plugin roles and prompt commands are owned registrations, removable without deleting unrelated user declarations. Hooks gain a real disposer and retain the existing trust checks.
- Serialize refreshes and disposal. Failed mounts are reported; do not label a saved but unapplied state as a successful live update.
- Refresh command discovery in the composer; disabled commands disappear and cannot execute from stale UI.

## Verification
Tests must use the same already-created assembly before/after enable and disable, check identity/history retention and command/skill/role/MCP visibility, verify unchanged MCP does not reconnect, and exercise hook disposal plus cross-host observation. Test UI command selection/update and update the old restart-required copy. Run owning package tests/typechecks, review, full gate and refresh portable delivery after implementation. Visual checks remain deferred under existing browser restriction.
