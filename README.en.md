# I-harness

**Work with AI in your own projects, from a goal to a result you can inspect.**

I-harness is an open source workspace for coding with AI. Connect your preferred model service, open a local project, and let the agent search code, read files, run commands and make changes. Follow its progress, approve operations, inspect diffs and stop execution from the same desktop app.

[Download for Windows](https://github.com/ivankwanpn/I-harness/releases/tag/v0.1.1) · [Get started](#get-started) · [Features](#work-through-development-in-one-workspace) · [繁體中文](README.md)

## Download

**Windows x64 · v0.1.1** includes Desktop and its required runtime.

| Edition | Choose it when… | Download |
| --- | --- | --- |
| **Installer** | You want a standard Windows installation, Start menu shortcuts and an uninstall entry | [I-harness Desktop Setup](https://github.com/ivankwanpn/I-harness/releases/download/v0.1.1/I-harness-Desktop-Setup-0.1.1.exe) |
| **Portable** | You prefer extracting the app into a folder of your choice | [I-harness Desktop ZIP](https://github.com/ivankwanpn/I-harness/releases/download/v0.1.1/I-harness-Desktop-0.1.1.zip) |

Extract the portable ZIP into its own folder and run `I-harness Desktop.exe`. Keep the executable beside the `resources` folder.

Desktop does not require a separate Node.js installation. Configure your own model service; cloud models require network access, credentials and usage allowance from that service.

The current Windows distribution is unsigned.

## Get started

1. **Open I-harness Desktop** and choose a local project folder as your workspace.
2. **Configure a model** in Settings → Models and providers: add the endpoint, protocol and API credentials, then select a model.
3. **Choose an access scope** in Execution and context: read-only, workspace write or full access, with an approval mode suited to the task.
4. **Start a conversation with a concrete goal**, such as “Find why login fails, make a fix, and run the relevant tests.”
5. **Inspect the result** through the work process, Todo progress, command output and file diffs.

Save and continue conversations, rename or archive them, or create a fork. Stop and cancellation controls are available during execution.

## Work through development in one workspace

### Projects, conversations and progress

Organize conversations by project and switch workspaces. Collapse navigation into an icon rail and resize both side panes. Reasoning, tool activity and background notifications appear in the work process, while the final response stays readable. A floating Todo card shows progress; search long conversations, return to recent content and compact context when needed.

### Find code, make changes and verify them

Use built-in search, file reading, editing and patch tools alongside command execution, interactive terminals, previews and diff views. Analyze a project before making changes, and open outside projects or documents as read-only references.

Rewind previews restoration of conversations and recorded file changes. Its coverage follows the snapshots actually captured; arbitrary external effects of commands are not equivalent to file snapshots.

### Choose your model service

Five model protocols are supported:

- OpenAI Responses
- OpenAI-compatible Chat Completions
- Anthropic Messages
- Google Gemini
- AWS Bedrock Converse

Configure custom endpoints, models, context windows and output limits, and change the model used by a conversation. Image input, reasoning options and other model features depend on the selected model and endpoint.

### Extend tools and delegate work

Connect MCP servers, use Skills, manage plugins and run workflows. Subagents and Teams support division of work, messages, status and cancellation. Tools follow the current role, access scope and approval configuration.

### Keep longer tasks usable

Code Mode lets agents compose tools with JavaScript, filter or aggregate results in the script, and return the relevant content to the model. Tools can be discovered on demand. Long outputs have bounded previews and retained references; successfully saved JSON state can survive session reconstruction.

Automatic and manual compaction help organize long conversations. Valid model usage reports calibrate context budgets. Cache behavior can be configured for supported endpoints; actual savings depend on the requests, model and provider.

### Context Mode and Code Context

Version 0.1.1 includes two native subsystems, controlled independently in Settings → Context and retrieval. Both default to off. Use global defaults or overrides for the current workspace.

- **Context Mode** retains large tool and Code Mode text locally and gives the model bounded previews and references. Search retained content or read it in exact windows; references can survive conversation restoration and forks.
- **Code Context** indexes workspace code and explicitly selected read-only reference sources. Lexical search uses a local index. Hybrid search uses a separately configured embedding service while vectors and indexes remain local.

The settings page includes quotas, retention, indexing progress, refresh, rebuild, cancel and clear controls. Disabling stops new subsystem work and drains owned operations while retaining data. Clearing is a separate action. Indexing outside reference sources grants read access only.

Design references: [context-mode](https://github.com/mksglu/context-mode) for Context Mode and [claude-context](https://github.com/zilliztech/claude-context) for Code Context. See the [native context guide](docs/native-context.md).

## Control operations

- **Access scopes:** read-only, workspace write and full access.
- **Approval modes:** ask for dangerous operations, ask each time, model review or full access.
- **Visible execution:** inspect tool requests, results, errors and progress.
- **Stop and cancel:** stop a model turn, tool work or a specific background resource.
- **Local storage:** Desktop settings and conversations are saved locally; configured models and external tools receive the data required for their work.

The app's authority follows your selected settings. Full access permits broader operations. Workspace write is suited to restricting changes to admitted project roots.

## Interface and integrations

Desktop includes Traditional Chinese and English, light and dark themes, text-size preferences and notification options.

The project also provides a **CLI, SDK and ACP** for integrating agents into other workflows. The CLI runs tasks, manages models and inspects sessions without the Desktop interface.

## Run from source

Development requires **Node.js ≥ 22.18 and pnpm ≥ 10**. Desktop distributions currently target Windows x64.

```powershell
git clone https://github.com/ivankwanpn/I-harness.git
cd I-harness
pnpm install --frozen-lockfile

# Start Desktop development
pnpm --filter @i-harness/desktop dev

# Show CLI commands
node --import tsx apps/cli/src/index.ts help
```

Build a distribution:

Building the Windows installer also requires [NSIS 3](https://nsis.sourceforge.io/Download). Compiler locations and options are documented in the [installer guide](packages/desktop/installer/README.md).

```powershell
# Build the portable Desktop app
pnpm --filter @i-harness/desktop dist

# Build the Windows installer from that app
pnpm --filter @i-harness/desktop installer
```

Outputs are collected in `packages/desktop/release/`. See the [Desktop documentation](packages/desktop/README.md) for development and packaging details.

## Report issues and contribute

[Report a problem or suggest a feature](https://github.com/ivankwanpn/I-harness/issues). Include the app version, operating system, model protocol, reproduction steps and error details with secrets redacted.

Before submitting a change, run:

```powershell
pnpm verify:all
```

## License

I-harness is licensed under the [MIT License](LICENSE). Third-party terms and notices are listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) and the [Desktop notices](packages/desktop/licenses/), and are retained in distributions.
