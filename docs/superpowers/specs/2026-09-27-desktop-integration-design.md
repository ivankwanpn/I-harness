# Desktop backend integration expansion

## Authorization and package ownership
The user approved the previously reported Desktop integration gaps on 2026-09-27: extend the existing package whenever its responsibility already exists; create a package under packages only for a genuinely new backend responsibility. This supersedes the previous missing-contract approval hold. Development stays in D:/frontend-test, manual operations in D:/agent-complete/playground, no GitHub push. Visual acceptance remains deferred.

## Architecture
Keep renderer → validated Desktop IPC → workspace gateway → owning backend package. Provider/model configuration belongs to provider-runtime/settings/credentials; plugins to plugin-registry/core-plugin; PTY to terminal; session operations to session-persistence/session-executor/rewind. Desktop owns UI state and native window/browser presentation. Do not move agent execution into the renderer or Electron main.

Each integration is an independently tested slice. First expose the existing redacted provider directory, then configuration and live model selection. Continue with session management, plugin management and terminal. Inspect browser integration separately and create a backend package only where inspection confirms no existing owner. Provider account usage, quota resets and OAuth are explicitly excluded from this round by the user; do not implement these flows. No own subscriptions, servers, remote workspace, cloud sync or multi-tenancy.

## Provider slice
desktop/provider/directory returns the existing ProviderRuntime.directory data: route id/display name, declared protocol, auth presence/source, models and discovery capability. It never returns API keys or credential documents. Add desktop-provider capability only when runtime is mounted. Require initialized wire and known local workspace. Reads perform no provider discovery/network call and do not persist settings.

Configuration writes will call existing runtime operations with explicit validated fields. Desktop must preserve unset versus null/clear semantics, existing model context overrides, and provider defaults. Multiple workspace gateways share settings files: before enabling edits, establish cross-process serialization/reload in the existing owning package so one window cannot overwrite another's settings. API keys remain write-only UI fields; never echo their content in responses, errors or logs. Discovery is explicit and cancellable.

Session selection uses the existing session/model/set protocol and service rebind boundary. Respect busy/compaction gates, validate resolution before persistence, preserve protocol's transient nature and test failed persistence/rebind ordering. No special GPT context/billing policy.

## Verification
Provider directory: real isolated host handshake and read, no secret in serialized reply, missing-runtime capability absent, uninitialized access denied, scoped IPC rejects unknown workspace. Follow-up configuration tests cover invalid fields, omitted/clear semantics, failed writes and concurrent instances. UI tests cover load/error/retry, selection and pending edits. Native packaging gates follow changes to dependencies; visual checks stay separately deferred.

