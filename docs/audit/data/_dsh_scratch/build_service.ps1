$ErrorActionPreference='Stop'
function M([string]$name,[string]$what,[string[]]$inv,[string]$fp,$consts,[string[]]$ev,[string[]]$mods){
  [ordered]@{ name=$name; what=$what; invariants=$inv; failurePolicy=$fp; constants=$consts; evidence=$ev; modules=$mods; verified=$true }
}
function C([string]$n,[string]$v,[string]$e){ [ordered]@{ name=$n; value=$v; evidence=$e } }

$service=@(
 (M 'stdio-sdk-control-protocol' `
  'StructuredIO is the bidirectional stdio wire contract for SDK hosts. Inbound NDJSON lines are normalised, dispatched by type, and either yielded as conversational input or consumed as a control_response resolving a pending request; control requests of subtype initialize, can_use_tool, hook_callback, elicitation, mcp_message, interrupt and the broader SDKControlOtherRequest list are supported. Outbound control_requests are enqueued on a SINGLE-writer stream so they cannot overtake queued stream events; abort produces a control_cancel_request and rejects the pending promise immediately without waiting for host acknowledgement. Late/duplicate control_response deliveries are deduplicated by tool_use id (LRU-bounded at 1000) to avoid duplicate assistant messages and API 400s.' `
  @('Exactly one writer drains the outbound stream - sendRequest and print.ts both enqueue rather than writing directly','Every control_response must close command lifecycle, including orphans and duplicates','A malformed stdin line is fatal (process.exit(1)) - never silently skipped') `
  'mixed - an unparseable stdin line exits the process (fail-closed); missing/unsupported control subtypes get an error response rather than a hang (fail-soft); stream close rejects all pending permission requests' `
  @((C 'MAX_RESOLVED_TOOL_USE_IDS' '1000' 'src/cli/structuredIO.ts:132'),(C 'sandbox permission tool name' "'SandboxNetworkAccess'" 'src/cli/structuredIO.ts:61')) `
  @('src/cli/structuredIO.ts:61,132,134-164,267-293,317-447,449-515,517-643,715-737','src/entrypoints/sdk/controlTypes.ts:88-93,160-191') `
  @('src/cli/structuredIO.ts','src/entrypoints/sdk/controlTypes.ts','src/entrypoints/sdk/controlSchemas.ts')),

 (M 'stream-json-headless-output-contract' `
  'runHeadless() implements --print and the --output-format contract: text (default, prints lastMessage.result by subtype), json (prints the single terminal result, or the full array with --verbose), and stream-json (writes every message as one NDJSON line, REQUIRES --verbose, and installs a stdout guard before the first write). Message accumulation is deliberately conditional - the full array is only retained for json + verbose, otherwise only the last message is kept in memory. Serialisation goes through ndjsonSafeStringify, which escapes U+2028/U+2029 so a line-splitting receiver can never truncate a JSON string; the stdout guard buffers process.stdout.write, JSON-parses each complete line, and diverts non-JSON lines to stderr tagged [stdout-guard].' `
  @('--output-format=stream-json without --verbose is a hard error','Nothing may reach stdout in stream-json mode that is not one complete JSON line','Exactly one terminal result message is emitted, including on fatal error paths') `
  'fail-closed - non-JSON stdout is diverted rather than emitted; a missing terminal result throws No messages returned; unhandled run errors emit a result/error_during_execution message then gracefulShutdownSync(1)' `
  @((C 'STDOUT_GUARD_MARKER' "'[stdout-guard]'" 'src/utils/streamJsonStdoutGuard.ts:8'),(C 'JS_LINE_TERMINATORS' '\u2028 and \u2029' 'src/cli/ndjsonSafeStringify.ts:16')) `
  @('src/cli/print.ts:419-455,535-544,789-918,2230-2272,4136-4154','src/cli/ndjsonSafeStringify.ts:16-32','src/utils/streamJsonStdoutGuard.ts:8-110','src/cli/exit.ts:19-31') `
  @('src/cli/print.ts','src/cli/ndjsonSafeStringify.ts','src/utils/streamJsonStdoutGuard.ts','src/cli/exit.ts')),

 (M 'direct-connect-websocket-client' `
  'createDirectConnectSession() POSTs {cwd, dangerously_skip_permissions?} to ${serverUrl}/sessions with an optional Authorization: Bearer <authToken>, validates the reply against a Zod schema requiring session_id and ws_url, and returns a DirectConnectConfig. DirectConnectSessionManager then opens a WebSocket and speaks the same NDJSON dialect as StructuredIO: it forwards SDKMessages, handles control_request/can_use_tool by calling back into the UI, answers unsupported can_use_tool subtypes and unknown subtypes with an error control_response, and can send SDKUserMessage, control_response and interrupt frames. This is a PURE CLIENT: there is no counterpart server implementation anywhere in this tree, so the bearer token''s validation side is entirely outside the source and service auth is unverifiable here.' `
  @('Wire payload shapes must match --input-format stream-json (SDKUserMessage) and StructuredIO (control_response / control_request) exactly','The auth token is supplied by the caller - there is no server-side validation code in this tree to verify it against') `
  'fail-soft - session creation throws DirectConnectError on network/HTTP/schema failure; after connect, sends to a non-OPEN socket are dropped and return false, and socket errors are surfaced as a callback' `
  @((C 'connect response schema' '{session_id: string, ws_url: string, work_dir?: string}' 'src/server/types.ts:5-11')) `
  @('src/server/createDirectConnectSession.ts:26-88','src/server/directConnectManager.ts:43-122,124-211','src/server/types.ts:5-65','src/server/permissionMessages.ts:6-19') `
  @('src/server','src/hooks/useDirectConnect.ts')),

 (M 'ssh-remote-session-transport' `
  'createSSHSession() probes the remote host over ssh with a hardened single-quoted shell script that must resolve cc-custom or claude-custom on PATH and print binary + PWD, then launches exec <binary> -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio plus permission flags. SSHSessionManager frames the child stdout into lines, ignores non-JSON chatter, treats control_request/can_use_tool as permission prompts, and sends SDKUserMessage/control_response/interrupt frames over stdin; stderr is retained as a 64 KiB tail for diagnostics. createLocalSSHSession() runs the same protocol against the local launcher with CLAUDE_CODE_ENTRYPOINT=sdk-cli.' `
  @('The remote host string is rejected if empty, leading-dash, or containing NUL/CR/LF - an argument-injection guard','All remote path/binary arguments are POSIX single-quoted') `
  'fail-closed - probe failure (missing binary, non-zero ssh exit, unparseable output) throws SSHSessionError before any session exists; after connect, non-JSON stdout lines are logged and dropped' `
  @((C 'STDERR_TAIL_LIMIT' '64 * 1024 bytes' 'src/ssh/SSHSessionManager.ts:28'),(C 'remote CLI args' '-p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio' 'src/ssh/createSSHSession.ts:87-97')) `
  @('src/ssh/createSSHSession.ts:50-81,83-106,108-162,164-216','src/ssh/SSHSessionManager.ts:39-94,96-211') `
  @('src/ssh')),

 (M 'in-process-mcp-stdio-server' `
  'startMCPServer() exposes the CLI''s own tool set to external MCP clients over StdioServerTransport. ListTools converts each tool Zod input/output schema to JSON Schema (skipping non-object-root output schemas), CallTool builds a synthetic ToolUseContext with an EMPTY permission context, validates input, calls the tool with hasPermissionsToUseTool, and stringifies the result; errors are logged and returned as isError text content. Only the review command is exposed as an MCP command.' `
  @('Each call gets a fresh empty ToolPermissionContext - no session permission state leaks to MCP callers','readFileState is an LRU-bounded cache (100 files) so a long-lived server cannot grow unbounded') `
  'fail-soft - tool errors are converted to {isError:true, content:[text]} rather than crashing the server' `
  @((C 'READ_FILE_STATE_CACHE_SIZE' '100' 'src/entrypoints/mcp.ts:42'),(C 'MCP server name' "'claude/tengu'" 'src/entrypoints/mcp.ts:49')) `
  @('src/entrypoints/mcp.ts:35-57,59-97,99-188,190-196') `
  @('src/entrypoints/mcp.ts')),

 (M 'sdk-typed-wire-schemas' `
  'The typed SDK contract: coreTypes.generated.ts declares the full SDKMessage union (user, user-replay, assistant with seven error kinds, result success/error with four error subtypes, system, partial-assistant stream_event, tool_progress, auth_status, files_persisted, task notifications/started/progress, session_state_changed, tool_use_summary, rate_limit_event, elicitation_complete, prompt_suggestion) plus ModelUsage. controlTypes.ts declares the control envelope types and a runtime isSDKMessage() type guard used by BOTH the direct-connect and SSH consumers to reject non-SDK frames. controlSchemas.ts mirrors the control protocol as Zod schemas built through lazySchema to avoid eager circular initialisation, and aggregates the StdoutMessageSchema/StdinMessageSchema unions.' `
  @('isSDKMessage() must list every message type a consumer is expected to forward; anything else is dropped','Control schemas stay lazy (lazySchema) because the request-inner union is self-referential') `
  'fail-closed at the schema boundary (parse failures reject the pending request), fail-soft for unknown frame types (skipped)' `
  @((C 'SDKAssistantMessageError kinds' 'authentication_failed, billing_error, rate_limit, invalid_request, server_error, unknown, max_output_tokens' 'src/entrypoints/sdk/coreTypes.generated.ts:58-65'),(C 'SDKResultError subtypes' 'error_during_execution, error_max_turns, error_max_budget_usd, error_max_structured_output_retries' 'src/entrypoints/sdk/coreTypes.generated.ts:120-124')) `
  @('src/entrypoints/sdk/coreTypes.generated.ts:10-27,58-65,100-150','src/entrypoints/sdk/controlTypes.ts:160-191','src/entrypoints/sdk/controlSchemas.ts:1-45,570-659','src/entrypoints/sdk/runtimeTypes.ts:9-35') `
  @('src/entrypoints/sdk','src/entrypoints/agentSdkTypes.ts'))
)
$service | ConvertTo-Json -Depth 20 | Out-File (Join-Path 'D:\I-harness-main\docs\audit\data\_dsh_scratch' 'service.json') -Encoding utf8
'service entries: ' + $service.Count
