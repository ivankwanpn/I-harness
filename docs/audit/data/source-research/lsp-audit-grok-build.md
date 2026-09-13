# LSP Audit — `D:\agent-complete\grok-build-main` ("grok build", xAI)

VERDICT: **(b) AN LSP CLIENT EXISTS.**

It is a real, production, wired-in LSP *client* (spawns language-server processes,
speaks JSON-RPC LSP over stdio/socket, does the `initialize` handshake). It is NOT
an editor integration and NOT an ACP method with an `lsp`-ish name.

Primary implementation root:
`crates/codegen/xai-grok-tools/src/implementations/lsp/`
(18 `.rs` files, 8,717 lines total; 6,648 lines of non-test code)

---

## 1. Dependency evidence (Cargo.toml / Cargo.lock — not README)

- `Cargo.toml:126` — `async-lsp = { version = "0.2.3", features = ["tokio", "tracing"] }`
  (declared in `[workspace.dependencies]`, which starts at `Cargo.toml:112`)
- `crates/codegen/xai-grok-tools/Cargo.toml:27` — `async-lsp = { workspace = true }`
- `Cargo.lock:493` — `name = "async-lsp"`
- `Cargo.lock:499` — ` "lsp-types",`   (inside async-lsp's own dependency list => `lsp-types` is transitive via async-lsp)
- `Cargo.lock:6092` — `name = "lsp-types"`
- `Cargo.lock:14516` — ` "async-lsp",` (inside the `xai-grok-tools` package block at `Cargo.lock:14511`)

This is the ONLY crate in the workspace that declares an LSP dependency. A grep of all
`Cargo.toml` files for `lsp|tower-lsp|lsp-types|language-server` returned exactly these
two TOML hits. `tower-lsp` and `lsp-server` are absent from both manifests and lockfile.

## 2. Proof it is a real LSP *client* (handshake + subprocess + protocol methods)

- `crates/codegen/xai-grok-tools/src/implementations/lsp/client.rs:1`
  `//! Single LSP server connection — spawn, handshake, protocol methods.`
- `crates/codegen/xai-grok-tools/src/implementations/lsp/client.rs:20`
  `use async_lsp::LanguageServer;`
- `client.rs:115` — `async_lsp::MainLoop::new_client(move |server_socket| {`
  (a *client* main loop, not a server loop)
- `client.rs:431` — `let mut cmd = std::process::Command::new(&config.command);`
  followed by `client.rs:433-435` wiring `.stdin/.stdout/.stderr(Stdio::piped())` —
  i.e. it SPAWNS an external language-server binary.
- `client.rs:221` — `fn build_initialize_params(config: &LspServerConfig, workspace_root: &Path) -> InitializeParams {`
- `client.rs:238` — `capabilities: LspClient::client_capabilities(),`
  (advertises client capabilities in the LSP `initialize` request)
- `crates/codegen/xai-grok-tools/src/implementations/lsp/mod.rs:59`
  `pub type LspMainLoop = async_lsp::MainLoop<async_lsp::router::Router<()>>;`
- `mod.rs:46-47` (error variants proving process lifecycle):
  `#[error("failed to spawn LSP server: {0}")]`

### Real LSP request traffic (production, not `#[cfg(test)]`)

- `crates/codegen/xai-grok-tools/src/implementations/lsp/dispatch.rs:412`
  `socket: &mut async_lsp::ServerSocket,`
- `dispatch.rs:416` — `let params = GotoDefinitionParams {`
- `dispatch.rs:426-430` —
  `let fut = if is_definition { socket.definition(params) } else { socket.implementation(params) };`
- `dispatch.rs:11` — `use async_lsp::LanguageServer;`
- `crates/.../lsp/client.rs:122` — `router.notification::<lsp_types::notification::PublishDiagnostics>(`
- `crates/.../lsp/client.rs:147` — `router.request::<lsp_types::request::WorkspaceDiagnosticRefresh, _>(`
- `crates/.../lsp/pull.rs:1` — `//! Pull-model diagnostics (`textDocument/diagnostic`).`
- `crates/.../lsp/workspace_open.rs:19` — `impl lsp_types::notification::Notification for SolutionOpen {`
  (Roslyn `solution/open` / `project/open` protocol extensions)
- `crates/.../lsp/capabilities.rs:42` — `pub fn from_capabilities(capabilities: &ServerCapabilities) -> Self {`
  (consumes the server's `initialize` result capabilities)

### Server config: this is a user-facing LSP client config

- `crates/.../lsp/config.rs:1` — `//! LSP server configuration from `.grok/lsp.json`.`
- `config.rs:33` — `let user_path = crate::util::grok_home::grok_home().join("lsp.json");`
- `config.rs:34` — `let project_path = cwd.join(".grok").join("lsp.json");`
- `config.rs:223` — `pub enum LspTransport {` with `Stdio` / `Socket` variants (`config.rs:225-226`)
- `config.rs:251-252` — `pub struct LspServerConfig {` / `pub command: String,`
- `config.rs:236` — `/// bare `Microsoft.CodeAnalysis.LanguageServer` does not.`

## 3. The client is exposed to the model as a first-class tool and is wired into the shipped agent

- `crates/codegen/xai-grok-tools/src/implementations/grok_build/lsp/mod.rs:1`
  `//! `lsp` tool - code intelligence via language servers.`
- `.../grok_build/lsp/mod.rs:57` — `xai_tool_protocol::ToolId::new("lsp").expect("valid tool id")`
- `.../grok_build/lsp/mod.rs:37` — tool description:
  `Operations: goToDefinition (jump to where a symbol is defined), findReferences (all usages of a symbol), hover (type info/docs at a position), goToImplementation (trait/interface implementations), documentSymbol (list all symbols in a file), workspaceSymbol (search symbols by name across the workspace — requires query parameter, not file_path).`
- `crates/.../xai-grok-tools/src/implementations/lsp/types.rs:110-117`
  `pub enum LspOperation { GoToDefinition, FindReferences, Hover, GoToImplementation, DocumentSymbol, WorkspaceSymbol, }`
- `crates/codegen/xai-grok-agent/src/config.rs:163`
  `tools.push((&grok_build::LspTool).into());`  <-- registered in the default tool set
- `crates/codegen/xai-grok-agent/src/builder.rs:698`
  `.push((&xai_grok_tools::implementations::grok_build::LspTool).into());`
- `crates/codegen/xai-grok-tools/src/registry/types.rs:277`
  `pub lsp: Option<std::sync::Arc<dyn crate::implementations::lsp::LspBackend>>,`
- `crates/codegen/xai-grok-tools/src/reminders/lsp_diagnostics.rs:1`
  `//! Cross-cutting reminder: notifies LSP of file changes and drains diagnostics.`
- `crates/codegen/xai-grok-shell/src/agent/mvp_agent/agent_ops.rs:4469-4472` constructs the manager at session setup:
  `use xai_grok_tools::implementations::lsp::{ LspBackend, LspBackendAdapter, LspManager, };`
- `crates/codegen/xai-grok-shell/src/session/agent_rebuild.rs:48`
  `use xai_grok_tools::implementations::lsp::LspBackend;`

## 4. Explicit FALSE POSITIVES / nearest misses (confirmable as NOT an LSP client)

These are the things an adversarial reviewer will hit on. Each is quoted exactly.

1. **`xai-grok-diag-server` is an HTTP health server, not LSP.**
   `crates/codegen/xai-grok-diag-server/Cargo.toml:6`
   `description = "In-guest diagnostics HTTP server (/ready, /statusz, /logs) for the standalone workspace-server"`
   Its deps are `axum`/`tokio`/`tracing` (`Cargo.toml:9-19`) — no LSP crate, no `lsp` identifier anywhere in the crate.

2. **`xai-codebase-graph` is a tree-sitter code index, not LSP.**
   `crates/codegen/xai-codebase-graph/Cargo.toml:6`
   `description = "High-performance code graph generation using tree-sitter queries"`
   `crates/codegen/xai-codebase-graph/Cargo.toml:59` — `tree-sitter = "0.25.10"`
   `crates/codegen/xai-codebase-graph/src/index_manager.rs:571` — `parser_cache: HashMap<String, tree_sitter::Parser>,`
   No `async-lsp`/`lsp-types` dependency in this crate's manifest.

3. **ACP method `x.ai/code/goto-definition` is NOT LSP — it routes to the tree-sitter index.**
   `crates/codegen/xai-grok-shell/src/extensions/code_nav.rs:178` — `"x.ai/code/goto-definition" => {`
   `crates/codegen/xai-grok-workspace/src/workspace_ops.rs:1146` — `let (handle, _root) = resolve_index_for_file(ws, self.root.as_deref(), &self.file)?;`
   `crates/codegen/xai-grok-workspace/src/workspace_ops.rs:1148` — `.goto_definition(std::path::PathBuf::from(&self.file), self.line, self.col)`
   ...which lands on `xai-codebase-graph`'s index, not a language server:
   `crates/codegen/xai-codebase-graph/src/index_manager.rs:341` — `pub async fn goto_definition(`
   `index_manager.rs:348` — `self.command_tx.send(IndexCommand::GotoDefinition {`
   Also `code_nav.rs:206` `"x.ai/code/goto-references" => {`, `code_nav.rs:235` `"x.ai/code/find-definitions" => {`, `code_nav.rs:265` `"x.ai/code/find-references" => {`, `code_nav.rs:295` `"x.ai/code/status" => {`.
   These are ACP editor-capability methods that resemble LSP navigation but share no code with the LSP client.

4. **`CodeGotoDefinitionReq` / `goto_definition` name collisions are not LSP.**
   `crates/codegen/xai-grok-workspace-types/src/rpc/code_nav.rs:17`
   `const METHOD: &'static str = "workspace.code_goto_definition";`
   This is a workspace RPC method name, unrelated to `textDocument/definition`.

5. **`plugin_components` `lsp_servers` field is plugin *manifest* plumbing, not a client.**
   `crates/codegen/xai-hooks-plugins-types/src/lib.rs:478` — `pub lsp_servers: Vec<ComponentItem>,`
   `crates/codegen/xai-grok-agent/src/plugins/manifest.rs:153` — `pub lsp_servers: Option<PathOrInline>,`
   `crates/codegen/xai-grok-agent/src/plugins/manifest.rs:212`
   `resolve_component_path(&self.lsp_servers, plugin_root, ".lsp.json", "LSP config")`

6. **The `rust-analyzer` string is a test fixture, not an invocation.**
   `crates/codegen/xai-hooks-plugins-types/src/lib.rs:1045`
   `lsp_servers: vec![item("rust-analyzer", None)],`
   (inside `#[test] fn plugin_components_serde_roundtrip_camel_case()`, `lib.rs:1041`)

7. **`rust-analyzer` mentions in the LSP crate are comments about server behaviour (they are LSP, but are not a separate client).**
   `crates/codegen/xai-grok-tools/src/implementations/lsp/diagnostics.rs:87`
   `/// rust-analyzer is the case in point — it answers`
   `crates/codegen/xai-grok-tools/src/implementations/lsp/pull.rs:300`
   `// rust-analyzer leaves `cargo check` there — so its pull answer is a`

8. **`xai-acp-lib` contains NO LSP surface at all.**
   A grep for `x.ai/` in `crates/codegen/xai-acp-lib` returned exactly one hit, and it is unrelated:
   `crates/codegen/xai-acp-lib/src/channel.rs:71` — `"x.ai/test",`
   The ACP extension methods live in `xai-grok-shell/src/extensions/` (`auth.rs`, `git.rs`, `mcp.rs`, `fs.rs`, `code_nav.rs`, `workqueue`/queue in `agent/ext_parsers.rs`, etc.). None of them is an LSP client; the only navigation-flavoured ones are the tree-sitter-backed `x.ai/code/*` in item 3.

9. **`ToolKind::Lsp` strings and schema docs are taxonomy, not a client.**
   `crates/codegen/xai-grok-tools/schema/tool_meta.schema.json:39` lists `lsp` among known tool kinds;
   `crates/codegen/xai-grok-tools/src/tool_taxonomy.rs:47` — `ToolKind::Lsp => "Code Intelligence",`
   `crates/codegen/xai-grok-agent/src/builder.rs:2295`
   `assert_eq!(claude_tool_kind("LSP"), Some(ToolKind::Lsp));`
   These merely name the LSP tool from item 3.

## 5. Coverage / method notes

- Grep terms run across the whole repo: `lsp`, `LSP`, `language_server`, `language server`,
  `LanguageServer`, `tower-lsp`, `lsp-types`, `lsp_types`, `rust-analyzer`, `rust_analyzer`,
  `textDocument/`, `workspace/symbol`, `goto_definition`, `CodeAction`, `diagnostics`.
- `CodeAction` produced **zero** matches repo-wide — the tool exposes only
  goToDefinition / findReferences / hover / goToImplementation / documentSymbol / workspaceSymbol.
- `third_party/` (dagre_rust, graphlib_rust, mermaid-to-svg, ordered_hashmap) has **zero** LSP hits
  in any `*.toml`. There is no `vendor/` directory and no editor/IDE plugin directory in this repo
  (the client talks raw LSP; the editor side lives outside this checkout).
- Substring false positives were checked and excluded: `lsp` inside words such as `gslp`, and the
  `LspServerCrashed`/`LspServerReady` notification names at
  `crates/codegen/xai-grok-tools/src/implementations/grok_build/lsp/mod.rs:41-49`, which are
  tool-emitted telemetry names for the same LSP client.
- No file in `D:\agent-complete\grok-build-main` was modified. This report was written outside
  that repo.
