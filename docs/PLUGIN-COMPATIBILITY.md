# Plugin inputs and IH's unified runtime format

I-harness has one runtime representation. Source adapters produce
`RuntimeInputs`; the hook loader produces `HookHandlerSpec` and the runner
consumes that same specification for every supported declaration. A source
format does not create a separate execution, approval, or agent authority path.

The installed-plugin registry identifies the source tree. Native hook documents
retain their version-one parser and semantics. An explicitly identified installed
Claude plugin can supply its `{ hooks: ... }` syntax; the adapter translates it
before execution. An authored/global document cannot opt itself into an installed
plugin identity by adding metadata to its JSON.

## Capability dimensions

| Dimension | Source input | Unified representation and runtime consumer | Boundary |
| --- | --- | --- | --- |
| Skills | Plugin `skills/` and skill Markdown | `RuntimeInputs.skillDirs` → IH skill catalog | Existing instruction ordering and skill lookup apply |
| Commands | Plugin command Markdown | `RuntimeInputs.commandDescriptors` → IH prompt command registry | Commands are prompts; conflicts and capability gates remain enforced |
| MCP | Plugin `.mcp.json`, existing stdio/HTTP declarations | `RuntimeInputs.mcpServerConfigs` → IH MCP mounts | Existing transport, server identity, authorization and cleanup apply |
| Agents | Agent Markdown and its supported tool frontmatter forms | `RuntimeInputs.agentDescriptors` → registered `SubagentRole` | Tool names resolve against actual capabilities; model selection does not manufacture a role or wider tools |
| Hooks | Native version-one handler JSON or supported installed Claude hook JSON | `RuntimeInputs.hookConfigs` → `loadHooksConfig` → `HookHandlerSpec` | Current user grants, script/bundle content, mounted revision and actual caller remain authoritative |

Arbitrary plugin server entries are still not loaded as in-process code. The
separate `executable` advertisement remains unsupported; it is not one of the
five usable dimensions above.

## Source forms

Source entry points and installed plugin source declarations are separate
contracts. A marketplace can be supplied in four existing forms: a local
directory, an HTTP(S) manifest URL, a GitHub `owner/repo` shorthand or a Git URL.
Resolution keeps that order, so an existing local directory wins over a string
that also looks like `owner/repo`. The parser checks
`.claude-plugin/marketplace.json` before the bare `marketplace.json` fallback.

Inside a marketplace, the six object source discriminators below and the
existing string shorthand remain intact. None changes the runtime format:

| Source discriminator | Meaning | Result |
| --- | --- | --- |
| `git-subdir` | A directory inside a pinned or selected Git source | Installed plugin files feed the same `RuntimeInputs` |
| `url` | URL source with its supported integrity pin | Same installed-file boundary |
| `github` | GitHub repository and optional directory | Same installed-file boundary |
| `git` | Git source with supported ref/SHA fields | Same installed-file boundary |
| `directory` | Local directory | Same installed-file boundary |
| `file` | Local file source | Same installed-file boundary |

Existing string path/source shorthands retain their source resolver. Installing
or enabling a source does not approve executable hook contents.

## Synchronous Claude command hooks

| Claude declaration | IH event | Runtime behavior |
| --- | --- | --- |
| `SessionStart` | `session/start` | Existing startup/resume matching, reviewed context and deduplication |
| `SessionEnd` | `session/end` | Lifecycle observer; reason matching when the host supplies it |
| `UserPromptSubmit` | `prompt/submit` | Once per agent submission for Claude commands; native v1 keeps its existing per-step seam |
| `PreToolUse` | `pre-tool` | Tool gate before the actual body |
| `PostToolUse` | `post-tool` | Actual completed output and call identity; Claude block feedback is delivered as context |
| `PermissionRequest` | `permission` | A deny can narrow permission; a Claude allow cannot override IH policy/guards or grant wider authority |
| `Stop` | `stop` | Reviewed continuation feedback before the turn closes |
| `SubagentStop` | `subagent/stop` | Same continuation path using the actual child session, role and owned transcript suffix |
| `Notification` | `notification` | Existing programmatic observer, including explicit notification type matching |

Command strings execute through the native Bash/sh prerequisite with hidden
Windows process windows. Windows Bash resolution selects Git Bash and does not
silently substitute WSL. Script paths use `CLAUDE_PLUGIN_ROOT`, and the actual
project supplies `CLAUDE_PROJECT_DIR`. Python bytecode writes are disabled so
importing the reviewed Python modules does not change their content grant.

Known IH file-tool arguments are presented with Claude's `file_path`/`content`
spellings. Tool aliases use the captured command binding: a selected POSIX shell
can appear as `Bash`, and PowerShell appears as `PowerShell`; a PowerShell binding
cannot match a Bash-only hook. Other IH arguments and the actual IH tool output
retain their underlying values. This is source adaptation into IH's tool
contract, not a promise that every foreign tool schema or tool capability exists.

The input carries the actual call/session identity. Ephemeral root and child
identities remain stable and distinct. Permission metadata reflects plan mode
first, full access as `bypassPermissions`, and normal IH approval as `default`.
These fields are informational and do not grant authority. The standard prompt
field remains `prompt`; `user_prompt` is also supplied for the pinned official
Hookify script's legacy lookup.

Claude JSON decisions normalize to IH's internal hook output. `Stop` and
`SubagentStop` block reasons re-enter the existing agent loop; native v1 Stop
vetoes keep their existing behavior. Normal `maxTurns`, token budget and owner
cancellation continue to apply, and no smaller standalone continuation limit is
introduced. Feedback is explicitly framed as untrusted plugin data in the model
request and retains its plugin origin in the native log. It cannot replace the
user's request or authorize a command.

Each approved subprocess receives an immutable temporary Claude JSONL projection
of the actual session's owned suffix. The projection reads copies, covers at
most 512 recent native events, retains bounded text tails and at most 1 MiB, and
never rewrites the native history. Its file is removed after the subprocess; the
registry removes its temporary directory on dispose. Output, timeout, stdin,
serialization and owner-abort paths terminate and drain the owned subprocess
tree before rejecting.

On Windows, reviewed host scripts use the existing public unrestricted pipe
owner with a retained Job, and the hook call still waits synchronously for root
status, the entire tree, I/O and native resource release. This preserves normal
descendant output after a launcher exits. Timeout/cancellation terminate that
same owned Job; they do not infer a sandbox downgrade, scan arbitrary PIDs or
rewrite the command. POSIX hooks retain their detached process group through
launcher exit. Bare native executables retain PATH/PATHEXT resolution, including
Windows case-insensitive environment overrides and intentional empty values.
Directory candidates do not shadow executable files; relative PATH entries and
native command working directories resolve against the actual child directory.
If the backend reports incomplete I/O, the reader delivers buffered output and
then the diagnostic. The hook requests native resource release before joining
the remaining I/O and preserves the incomplete result instead of reporting
successful completion.

Cancellation after a tool body completed preserves its actual output. A new
post hook does not start after owner cancellation; a post hook already running
is drained on cancellation without relabeling the completed body. Genuine
post-hook failures and policy vetoes retain their existing fail-closed behavior.
Non-durable children record lineage and seed length even without persistence,
so real ephemeral spawns use SubagentStop and an owned transcript suffix while
an explicitly requested model-history fork remains intact.

## Explicit limits and prerequisites

Unsupported declarations receive individual diagnostics. Asynchronous hooks,
`asyncRewake`, prompt/agent/HTTP/MCP hook handler types, conditional `if` forms,
exec-style command argument arrays, unsupported shells and non-blocking
`onFailure` behavior are not executed by this adapter. Unknown events have no
matching IH event. Unsupported output mutations such as `updatedInput`,
permission changes and tool-output replacements fail explicitly instead of
silently changing the prepared operation. IH's native fail-closed tool gates
remain stronger than a foreign hook's non-blocking error convention.

An approved command still needs its executable prerequisites. Missing native
Bash produces an installation diagnostic; command failures include their exit
status and stderr. Hookify needs Python 3. Ralph Loop needs Bash, jq and Perl.
These prerequisites are not silently installed, and a grant does not mean they
are available.

Windows PTY normalization for the audited Git Bash launcher captures its
executable, runtime and configuration before admission. HOME fallback checks
use the actual child working directory and retain the launcher's original HOME
text. This normalization supports ASCII `MSYS=` configuration directives; when
one applies, the prior `MSYS` value must also be ASCII. A non-ASCII prior value
receives an explicit diagnostic because the launcher's Windows ANSI conversion
depends on the host code page. With no applicable directive, that value remains
unchanged. This limit applies to the PTY launcher adapter; command hooks use the
native pipe owner described above.

The PTY adapter binds its single PE import to the selected installed MSYS DLL.
The Windows import-name contract currently requires that absolute DLL path to
be ASCII and shorter than 260 bytes; an unsupported path is rejected before
workload launch. The adapter does not copy an arbitrary DLL into a searchable
directory. Its helper, paired template and required license/source notices are
checked against their recorded digests when building the runtime payload.

## Verified representative plugins

The tests run unmodified runtime scripts from the official
[Hookify and Ralph Loop snapshot](https://github.com/anthropics/claude-plugins-official/tree/b8e53f1c05dff3b6d751297f6527990ffc81c2f4/plugins)
with their Apache-2.0 licenses retained. Hookify blocks an actual independent file
side effect, supplies prompt feedback once, and evaluates the current assistant
transcript before allowing completion. Ralph Loop performs a second mock-model
step, reads the current transcript, recognizes its completion promise and removes
its state file. Tests also exercise child identity, inherited-prefix exclusion,
post-tool results, shell preference changes, grant revocation, cancellation,
serialization errors and workflows longer than eight continuations.

Protocol fields were checked against the official
[Claude hook reference](https://code.claude.com/docs/en/hooks). Verification uses
explicit mock models, temporary project/session state and real subprocesses;
it does not contact a model provider or alter user settings/history.
