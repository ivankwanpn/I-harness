$ErrorActionPreference='Stop'
function M([string]$name,[string]$what,[string[]]$inv,[string]$fp,$consts,[string[]]$ev,[string[]]$mods){
  [ordered]@{ name=$name; what=$what; invariants=$inv; failurePolicy=$fp; constants=$consts; evidence=$ev; modules=$mods; verified=$true }
}
function C([string]$n,[string]$v,[string]$e){ [ordered]@{ name=$n; value=$v; evidence=$e } }

$ops=@(
 (M 'analytics-event-manifest-and-pii-sanitisation' `
  'The event metadata layer is FULLY IMPLEMENTED even though the sink is not. metadata.ts builds shared enrichment (session, interactive flag, client type, parent session, model, betas, platform, WSL/distro, VCS, repo remote hash, teammate/agent identity), sanitises MCP tool names to ''mcp_tool'' unless the server is on the official registry or the entrypoint is local-agent, gates tool-detail logging behind OTEL_LOG_TOOL_DETAILS, and enumerates tool-usage fields. Two marker types (AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS and the PII_TAGGED variant) carry developer intent at the type level, and stripProtoFields() removes _PROTO_* keys before any general-access fanout. logOTelEvent() adds event name/timestamp/monotonic sequence, prompt id and workspace host paths, with user prompts redacted unless OTEL_LOG_USER_PROMPTS.' `
  @('Metadata strings must be explicitly verified as non-code/non-filepath before use - the marker type enforces this at compile time','_PROTO_* (PII-tagged) keys must be stripped from any general-access sink','User prompt content must be redacted unless OTEL_LOG_USER_PROMPTS is set') `
  'fail-soft - enrichment degrades to whatever is available; a missing OTel event logger warns once and drops the event' `
  @((C 'MCP tool redaction value' "'mcp_tool'" 'src/services/analytics/metadata.ts:71'),(C 'tool-details env gate' 'OTEL_LOG_TOOL_DETAILS' 'src/services/analytics/metadata.ts:84')) `
  @('src/services/analytics/index.ts:19-58','src/services/analytics/metadata.ts:54-120','src/utils/telemetry/events.ts:17-19,21-75') `
  @('src/services/analytics/metadata.ts','src/services/analytics/index.ts','src/utils/telemetry/events.ts')),

 (M 'analytics-sink-fanout' `
  'PRESENT-BUT-INERT. The public API surface is intact but EVERY terminal operation is a no-op: attachAnalyticsSink() discards its argument and never attaches, logEvent()/logEventAsync() only void their arguments (the file comments say analytics is permanently disabled after a cloud-feature removal), initializeAnalyticsSink()/initializeAnalyticsGates() do nothing, the Datadog exporter''s initializeDatadog is a constant false with no-op trackDatadogEvent/shutdownDatadog, and the 1P event logger''s is1PEventLoggingEnabled() is a constant false with no-op logEventTo1P/shouldSampleEvent/shutdown1PEventLogging. The GrowthBook client that used to supply feature flags and dynamic configs is likewise a stub module whose every getter returns its caller-supplied default. Consequences that propagate into other domains: getFeatureValue_CACHED_MAY_BE_STALE(''tengu_otk_slot_v1'', false) is permanently false so the max-token slot cap never applies; checkStatsigFeatureGate_CACHED_MAY_BE_STALE is permanently false so strict tool schemas, token-efficient-tools betas, and the streaming tool executor gate are never selected; tengu_auto_mode_config allow-lists are empty. isAnalyticsDisabled() (test env, Bedrock/Vertex/Foundry, privacy level) remains an independent, still-live guard.' `
  @('Call sites must keep preserving the logEvent(name, metadata) signature even though it is a no-op','Do not restore a sink without re-auditing the removed user-attribute transmission') `
  'fail-open - every analytics operation silently succeeds and no event ever leaves the process; there is no queue, no retry and no error surface' `
  @((C 'isGrowthBookEnabled' 'false' 'src/services/analytics/growthbook.ts:41-43'),(C 'is1PEventLoggingEnabled' 'false' 'src/services/analytics/firstPartyEventLogger.ts:55-57'),(C 'initializeDatadog' 'async () => false' 'src/services/analytics/datadog.ts:8')) `
  @('src/services/analytics/index.ts:95-100,108-133','src/services/analytics/sink.ts:49-59','src/services/analytics/datadog.ts:8-33','src/services/analytics/firstPartyEventLogger.ts:25-57','src/services/analytics/growthbook.ts:41-43,130-136,157-162','src/services/analytics/config.ts:19-27','src/services/api/adapters/messagesAdapter.ts:476-478') `
  @('src/services/analytics')),

 (M 'opentelemetry-exporters-and-session-tracing' `
  'A REAL OTEL pipeline, unlike the analytics sink. bootstrapTelemetry() copies ANT_OTEL_* variables into the standard OTEL_* names for ant users and defaults the metric temporality to delta; parseExporterTypes() implements the spec rule that none means no auto-configured exporter. Console/OTLP/Prometheus readers, log processors and span processors are DYNAMICALLY imported per signal so an unused protocol costs nothing at startup. sessionTracing.ts builds interaction, llm_request, tool and hook spans on an AsyncLocalStorage context with WeakRef-held active spans plus an explicit strong-span map and a 30-minute TTL, and logOTelEvent routes records to a LoggerProvider held in bootstrap state; betaSessionTracing adds content attributes behind a beta gate. Perfetto tracing exists but is gated inert (see inertMechanisms).' `
  @('OTLP exporter packages are dynamically imported inside the protocol switch - never statically, or startup pays for every protocol','Span contexts must survive GC while active (ALS strong ref plus explicit strongSpans map)') `
  'fail-soft - a telemetry init failure is caught and logged; logOTelEvent with no logger warns once and drops, and test env drops unconditionally' `
  @((C 'DEFAULT_METRICS_EXPORT_INTERVAL_MS' '60000' 'src/utils/telemetry/instrumentation.ts:63'),(C 'DEFAULT_LOGS_EXPORT_INTERVAL_MS' '5000' 'src/utils/telemetry/instrumentation.ts:64'),(C 'SPAN_TTL_MS' '30 * 60 * 1000' 'src/utils/telemetry/sessionTracing.ts:79')) `
  @('src/utils/telemetry/instrumentation.ts:63-65,81-122,124-140','src/utils/telemetry/sessionTracing.ts:1-80','src/utils/telemetry/events.ts:21-75','src/utils/telemetry/perfettoTracing.ts:253-284') `
  @('src/utils/telemetry','src/bootstrap/state.ts')),

 (M 'cost-and-token-accounting' `
  'Session accounting is centralized in bootstrap state and surfaced through cost-tracker.ts: total cost USD, API duration with and without retries, tool duration, wall duration, lines added/removed, per-model usage (input/output/cache-read/cache-creation/web-search/costUSD/contextWindow/maxOutputTokens), plus OTEL counters for cost and each token class. Usage merging (updateUsage) is careful that message_delta ZEROS never clobber message_start input counts, and accumulateUsage sums across turns while taking the most recent service tier/geo/iterations/speed. Cost state is persisted into project config and restored only when the session id matches, so /resume reports the original totals; the cost hook flushes on process exit. Complementary tokenEstimation.ts counts tokens via the provider-native API with Bedrock/Vertex-specific paths and its own VCR wrapper.' `
  @('Input/cache token counts from message_start must not be overwritten by explicit zeros in message_delta','Persisted cost state is only restored when the stored session id equals the current one') `
  'fail-soft - unknown models set a hasUnknownModelCost flag and the cost report is annotated rather than failing; restore returns false when the session does not match' `
  @((C 'TOKEN_COUNT_THINKING_BUDGET' '1024' 'src/services/tokenEstimation.ts:34'),(C 'TOKEN_COUNT_MAX_TOKENS' '2048' 'src/services/tokenEstimation.ts:35')) `
  @('src/cost-tracker.ts:82-132,172-243,273-299','src/costHook.ts:5-17','src/services/api/claude.ts:2521-2613','src/services/tokenEstimation.ts:32-90','src/query/effects/productionEvaluateStopTelemetry.ts:9-37') `
  @('src/cost-tracker.ts','src/costHook.ts','src/services/api/logging.ts','src/services/tokenEstimation.ts')),

 (M 'doctor-and-installation-diagnostics' `
  'getCurrentInstallationType() classifies the running install (development, bun-package via CLAUDE_CODE_INSTALL_ROOT, native/package-manager via bundled mode and brew/winget/mise/asdf/pacman/deb/rpm/apk detection, npm-local, npm-global, unknown) and returns warnings/recommendations plus ripgrep status. /doctor renders screens/Doctor.tsx over that data, /status opens the Settings screen on the Status tab, /cost prints the formatted cost report, and diagnosticTracking.ts is a separate IDE-facing service that tracks baseline vs post-edit diagnostics over the IDE MCP client and summarises changes.' `
  @('Installation detection must not assume a writable global prefix - permission checks are permissive when the install type is unknown') `
  'fail-soft - every detection branch degrades to unknown with warnings rather than throwing; diagnostic tracking no-ops when the MCP client is not connected' `
  @((C 'InstallationType union' 'npm-global | npm-local | native | bun-package | package-manager | development | unknown' 'src/utils/doctorDiagnostic.ts:28-36')) `
  @('src/utils/doctorDiagnostic.ts:28-100','src/commands/doctor/index.ts:4-12','src/commands/status/index.ts:1-12','src/commands/cost/cost.ts:1-6','src/services/diagnosticTracking.ts:12-140','src/utils/autoUpdater.ts:26-66') `
  @('src/utils/doctorDiagnostic.ts','src/utils/doctorContextWarnings.ts','src/commands/doctor','src/commands/status','src/commands/cost','src/services/diagnosticTracking.ts')),

 (M 'crash-and-shutdown-handling' `
  'gracefulShutdown.ts installs the process-level crash surface: uncaughtException and unhandledRejection handlers that record name/message/stack through the PII-free diagnostics log and emit analytics events, plus a cleanup registry run on exit, terminal-mode restoration (mouse tracking, alt-screen, kitty keyboard, tab status), sync and async shutdown entry points with a timeout failsafe, and an orphan-detection interval. preventSleep.ts keeps macOS awake with a self-healing caffeinate subprocess (5-minute timeout, restarted every 4 minutes, ref-counted) so a SIGKILL cannot leave the machine pinned awake.' `
  @('Crash handlers must log no PII - error name always, message truncated to 2000 chars, stack to 4000','Terminal escape sequences must be written synchronously before process.exit') `
  'fail-soft - a shutdown failure falls through to forceExit after best-effort terminal cleanup; crash handlers observe and log but do not change the exit path' `
  @((C 'CAFFEINATE_TIMEOUT_SECONDS' '300' 'src/services/preventSleep.ts:21'),(C 'RESTART_INTERVAL_MS' '4 * 60 * 1000' 'src/services/preventSleep.ts:25'),(C 'orphan check interval' '30000 ms, unref d' 'src/utils/gracefulShutdown.ts:294-295')) `
  @('src/utils/gracefulShutdown.ts:47-110,299-333,336-359','src/services/preventSleep.ts:19-50') `
  @('src/utils/gracefulShutdown.ts','src/services/preventSleep.ts','src/utils/cleanupRegistry.ts')),

 (M 'distribution-and-packaging' `
  'Distribution is Windows-native and script-driven rather than an in-app updater. bin/claude.ts is the launcher: it resolves the install root from its own path, sets CLAUDE_CODE_INSTALL_ROOT, and imports src/bootstrap-entry.ts. installer/archive-payload.ts is the packaging primitive used by the NSIS build: it refuses symlinks and unsupported entries, rejects any archive path that is absolute, drive-qualified, or contains . or .., refuses to write the archive inside the source tree, deduplicates hardlinks by dev:ino, and on extract asserts the extracted count equals the entry count. installer/build.ps1 and installer/cc-custom.nsi drive the build, and a compiled setup executable plus .sha256 ship under installer/dist/. localInstaller.ts still manages a legacy local-npm wrapper, and nativeInstaller/packageManagers.ts plus pidLock.ts provide package-manager detection and a lock file. The in-app auto-updater is gone (see inertMechanisms).' `
  @('The payload archive must be written outside the source directory','No archive path may escape the extraction root - the zip-slip guard is mandatory on both create and extract') `
  'fail-closed - unsafe archive paths, symlinks, unsupported entries, empty archives and count mismatches all throw; local install setup returns false on error and logs' `
  @((C 'payload layout' 'collectFiles sorts entries by name for deterministic archives' 'installer/archive-payload.ts:22'),(C 'install root env' 'CLAUDE_CODE_INSTALL_ROOT' 'bin/claude.ts:8')) `
  @('bin/claude.ts:1-10','installer/archive-payload.ts:8-18,41-86,88-104,106-141','src/utils/localInstaller.ts:19-100','src/utils/autoUpdater.ts:1-67') `
  @('bin','installer','shims','src/utils/localInstaller.ts','src/utils/nativeInstaller','src/utils/autoUpdater.ts')),

 (M 'vcr-fixture-replay-and-benchmark-harness' `
  'vcr.ts is a record/replay fixture layer keyed by a SHA-1 of the serialized input. It is active in test env and for FORCE_VCR ant runs; a hit returns the cached fixture, a miss records it (or, in CI without VCR_RECORD=1, FAILS LOUDLY with instructions), and directories are created on demand. Streaming and token-count variants wrap the non-streaming one. Separately, src/query/adapters/transcript.bench.ts is the only *.bench.ts in the tree: a perf_hooks micro-benchmark comparing incremental transcript writes against legacy full-array scans and reporting scan/copy counts and peak retained references.' `
  @('Fixture filenames are content-addressed - changing the input invalidates the fixture rather than silently reusing it','CI must not silently record new fixtures; a miss throws unless VCR_RECORD is set') `
  'mixed - inactive outside test/FORCE_VCR (pass-through); a missing fixture in CI throws (fail-closed); a missing fixture locally is recorded (fail-soft)' `
  @((C 'fixture hash length' '12 hex chars of SHA-1' 'src/services/vcr.ts:49-52'),(C 'fixture root env' 'CLAUDE_CODE_TEST_FIXTURES_ROOT' 'src/services/vcr.ts:54')) `
  @('src/services/vcr.ts:23-80','src/query/adapters/transcript.bench.ts:1-40') `
  @('src/services/vcr.ts','src/query/adapters/transcript.bench.ts'))
)
$ops | ConvertTo-Json -Depth 20 | Out-File (Join-Path 'D:\I-harness-main\docs\audit\data\_dsh_scratch' 'ops.json') -Encoding utf8
'ops entries: ' + $ops.Count
