# Grok Build (xAI) TUI — Live Black-Box Observation

Date: 2026-09-05
Repo: `D:\agent-complete\grok-build-main` — Rust workspace, TUI crate `crates/codegen/xai-grok-pager`, binary crate `xai-grok-pager-bin` (artifact name `xai-grok-pager`, version 1.0.16).
Harness: OUR OWN node-pty (ConPTY) + @xterm/headless parser (patterns from `packages/tui/test/harness/{runner,virtual}.ts`), 80x24, SGR-1006 mouse escapes injected via stdin. Channel used: `wsl.exe -d Ubuntu -u root` so the Linux binary sees a real `/dev/pts` with `TERM=xterm-256color`.

---

## 0. Headline result

- **The real TUI builds and boots** (Linux target, release, 13m11s), and under our PTY it shows **a full-screen device-code sign-in gate** — this is the "welcome screen": there is NO menu/dashboard before sign-in.
- **The custom-model seam is REAL, verified end-to-end with DeepSeek**: `grok -p hi` (single turn) returned a genuine DeepSeek answer via the OpenAI-compatible endpoint config, with **zero grok.com credentials**, when the active model owns its own API key.
- **The full TUI hard-gates on grok.com OAuth (device code)** — the custom provider did NOT bypass it (nor did a planted `XAI_API_KEY`). All in-session surfaces (slash registry, `/theme`, settings modal, in-session mouse) are unreachable behind that gate: `GAP` section below.
- Mouse clicks ARE handled by the login screen (proved: inline feedback on the copy link, screen swap to full URL, OSC52 clipboard emission, `ctrl+q` exit with code 0).

---

## 1. Toolchain + build outcome (verbatim obstacles)

| Step | Result |
|---|---|
| `cargo`/`rustc` on host | absent (no rustup, no gcc/clang; only Git's coreutils `link.exe`) |
| MSVC link toolchain | PRESENT: VS 2022 BuildTools 14.41.34120 (`cl.exe` OK) + Windows SDK 10.0.22621.0 (via `vswhere`) |
| rustup | `winget install --id Rustlang.Rustup` (1.29.1) → `cargo 1.94.0` (pinned by `rust-toolchain.toml`) |
| Build attempt 1 (MSVC) | `cargo build --release -p xai-grok-pager-bin` → fails in `xai-grok-tools-api` build script: `bin/protoc` found but "**%1 不是有效的 Win32 應用程式 (os error 193)**" (dotslash shebang manifest, no Windows support), PATH `protoc` absent |
| Attempt 2 | installed dotslash; then `PROTOC=D:/toolcache/protoc293/bin/protoc.exe` (protoc 29.3 win64) → NEW error, verbatim: `--- stderr /dev/stdout: No such file or directory` from `crates/build/xai-proto-build/src/lib.rs:148` which hardcodes **`--dependency_out=/dev/stdout`** + `--descriptor_set_out=/dev/null`. Windows-native protoc cannot open `/dev/stdout`; `bin/protoc` dotslash manifest supports only `linux-aarch64`, `linux-x86_64`, `macos-aarch64` (dotslash error verbatim: "caused by: platform not supported / expected platform `windows-x86_64`"). README confirms: "Windows builds are best-effort and not currently tested from this tree." **No source patches made** (per constraints) — reported verbatim. |
| Attempt 3 (WSL2 Ubuntu) | `apt-get build-essential` + rustup `rc 1.98.1`; repo copied to WSL FS (only 78 MB source); repo's `rust-toolchain.toml` drives 1.94.0. `cargo build --release -p xai-grok-pager-bin` → **`Finished release profile … in 13m 11s`** |
| Binary | `/root/grokbuild/grok-build-main/target/release/xai-grok-pager` — **218,516,864 bytes, exit 0**. (MSVC `target/` also left in `D:\agent-complete\grok-build-main\target` — gitignored; **their source untouched**.) |
| Supporting installs | TUI needs `dotslash` on PATH (Linux: `/root/.cargo/bin/dotslash`), protoc via dotslash manifest (Linux auto-downloads protoc 29.3). |

---

## 2. Welcome / first screen — FULL row dump (80x24, verbatim)

Launched as `xai-grok-pager` (no args, cwd = scratch dir). This is a **device-code sign-in screen**, not a menu. The code changes every launch.

```
 row 0  (empty)
 row 1   /root/scratch                          <- header line = cwd (absolute path)
 rows 2-5 (empty)
 row 6            Approve in your browser to finish signing in.
 row 7   (empty)
 row 8                    6DN8-BAAB             <- device code (example from run 1; X7ND-D449 / 473A-W6YH / QN5D-TDHV / ZRA2-ZFV9 seen)
 row 9   (empty)
 row 10     Make sure your browser shows this code.
 rows 11 (empty)
 row 12      If it doesn't open, click here to copy.
 rows 13-15 (empty)
 row 16  Copying not working? Click here to show full URL.
 row 17-19
 row 18               Waiting for approval...
 row 20 (empty)
 row 21        (centered)  ctrl+q  quit
 row 22-23 (empty)
```

Bottom-left/or internal strings are centered; the screen is one interactive modal (status/scrollback UI only appears post-auth).

**Colors observed (256 palette, not truecolor)**: body text `fg=i243 bg=i233`; device code `fg=i254 bg=i233` + bold bit (bold flag `134217728` = 0x8000000). Background `i233`. This is the quantized path — see §Environment quirks.

---

## 3. Custom provider (DeepSeek) — the model-endpoint seam

### 3.1 User-supplied (newer-release) format — INVALID in this tree

`~/.grok/config.toml` exactly as supplied:

```toml
model = "deepseek-chat"

[model_providers.custom]
name = "deepseek"
base_url = "https://api.deepseek.com/v1"
env_key = "DEEPSEEK_API_KEY"
```

→ **startup failure, verbatim** (TOML): `Error: Failed to load config: TOML parse error at line 8, column 2: cannot extend value of type string with a dotted key`. Cause: top-level `model = "…"` defines a string, and any `[model.*]` table cannot extend it. The supplied snippet is the *schema of a NEWER release* (it does not register a model here: `grok models` showed only grok models when this config was in place — harmless otherwise).

### 3.2 Documented recipe — WORKS (proved)

`~/.grok/config.toml`:

```toml
[model.deepseek-chat]
model = "deepseek-chat"
base_url = "https://api.deepseek.com/v1"
name = "DeepSeek Chat"
env_key = "DEEPSEEK_API_KEY"
api_backend = "chat_completions"
context_window = 64000

[models]
default = "deepseek-chat"
```

With `DEEPSEEK_API_KEY=sk-<REDACTED>`:

- `xai-grok-pager models` → verbatim:

```
Model 'deepseek-chat' is using its own API key.

Default model: deepseek-chat

Available models:
  - grok-4.6
  - grok-4.5
  * deepseek-chat (default)
```

- `xai-grok-pager -p hi` → **`Hello! How can I help you today?`** — a real DeepSeek round trip through grok's agent runtime (their `chat_completions` async-openai stack; `api_backend="chat_completions"` default; DeepSeek base_url `/v1/chat/completions`). Exit code 0. No grok.com account/credential involved: the "own API key" path satisfied the auth gate of the agent entry point.
- Persona spoof check: `-p "which model are you?"` → `I'm Grok, an AI model created by xAI.` (i.e. grok's system prompt persona; the served endpoint is DeepSeek). `-p "2+2=?"` → `4` + a DeepSeek-typical Japanese explanation tail.
- **Auth anchors**: `-p hi` WITHOUT any custom-model creds → verbatim: `Not signed in. To authenticate without a browser, run: grok login --device-code` … `Alternatively, set the XAI_API_KEY environment variable or run grok login on a machine with a browser.` — so the gate is: signed-in ON, else the **active default model must carry its own API key** (`api_key` or `env_key`), else `XAI_API_KEY`.

---

## 4. TUI gate — precise anchor ("custom model configured BUT still requires X")

With the working DeepSeek config + `DEEPSEEK_API_KEY` (and even with `XAI_API_KEY=sk-…` planted, and with `[models] default`):

**The TUI still boots to the device-code sign-in screen** (every launch generates a fresh `XXXX-XXXX` code and shows `Waiting for approval...`). The TUI session gate does **not** honor the custom-provider credentials path that the `-p` headless path honors; it requires a grok.com OAuth approve (device code at `accounts.x.ai/oauth2/device?user_code=…`). No bypass found; we did not attempt a real xai- API key or real browser approval.

`grok doctor` runs unauthenticated — verbatim excerpts:

```
Grok Doctor
Environment
  · terminal                     Unknown
  ? terminal version             unavailable
  · multiplexer                  None detected
  · ssh                          no
  · color                        256
```

---

## 5. Mouse semantics — EMPIRICALLY PROVEN on the login screen

All SGR-1006 escapes injected via pty stdin (`\x1b[<b;x;yM` / `\x1b[<b;x;ym`).

### 5.1 Click "If it doesn't open, click here to copy." (row 12, col 36)
- **Before**: row 12 text as in §2, rows 13-14 empty.
- **After** (click `\x1b[<0;36;13M` + release): NEW feedback line appears at row 14: `   copy failed` (screen otherwise unchanged).
- **Mechanism proven from captured bytes**: the app emitted an OSC52 base64 clipboard write: `ESC]52;c;` + base64(`https://accounts.x.ai/oauth2/device?user_code=QN5D-TDHV`). The terminal-side ACK was absent in our xterm-headless parser → the app timed out → `copy failed`. (In a real terminal with OSC52 support, this is the actual copy.)
- Cell colors during the "copy failed" state: same palette (i243 on i233); the failed line appeared mid-screen (row 14).

### 5.2 Click "Copying not working? Click here to show full URL." (row 16, col 27)
- **After**: the whole screen swaps (verbatim BEFORE→AFTER):

```
BEFORE (row 6-21):
 6: Approve in your browser to finish signing in.
 8: 473A-W6YH
12: If it doesn't open, click here to copy.
16: Copying not working? Click here to show full URL.
18: Waiting for approval...
21: ctrl+q  quit

AFTER:
 6:  Select the URL below with your mouse and copy manually.
 8:  https://accounts.x.ai/oauth2/device?user_code=QN5D-TDHV
16:  ctrl+q  go back
```

- URL text verbatim: `https://accounts.x.ai/oauth2/device?user_code=QN5D-TDHV` (differs per run = the live device code). `ctrl+q` hint changed from `quit` to `go back` — i.e., key-hint text is state-aware.

### 5.3 Hover — NO highlight on this screen
`\x1b[<35;40;9M` (hover, no buttons) over body text (row 6) and the device code (row 8) → **row dumps identical before/after, and cellColor dumps identical** (`cell(6,30) fg=i243 bg=i233`, `cell(6,40) fg=i243 bg=i233`, `cell(8,40) fg=i254 bg=i233 bold=0x8000000`) — no hover repaint on the login screen. (Docs promise prompt-hover highlight only on the prompt area — in-session, unreachable here.)

### 5.4 Wheel scroll — no effect
`\x1b[<65;40;13M` / `\x1b[<64;40;13M` over the screen: rows unchanged (surface is not scrollable). In-session wheel style (scrollback scroll) unreachable.

### 5.5 Clicking the `ctrl+q  quit` hint row (row 21 → SGR y=22)
Click `\x1b[<0;40;22M\x1b[<0;40;22m`: **no visible change** — the hint is not a click target.

### 5.6 Keys
- `ctrl+q` (0x11) from the code screen → **app exits with code 0**: wrapper `echo APPEXIT=$?` → `APPEXIT=0` printed at line 0, screen cleared. Hint `ctrl+q  quit` is accurate. Exit is clean (0), not an abort.
- `Esc` sent while code screen: screen cleared and the process session ended (no exit-code probe in that run; treat as "app exited / inconclusive exact code", likely same quit path).
- `/` `Enter` arrows `?` on this screen: nothing detectable (screen static) — prompt never opens pre-auth.

---

## 6. GAPS (unreachable behind device-approve — with the expected-contract reference)

| Question | Status | Evidence / doc reference |
|---|---|---|
| Slash registry FULL list | **UNREACHABLE** (in-session). Docs (`04-slash-commands.md`) list 57 command headings: /new /resume /dashboard /compact /context /session-info /fork /copy /export /quit /home /delete /rename /model /effort /always-approve /multiline /history /compact-mode /vim-mode /edit-prompt /minimal /plan /view-plan /memory /flush /dream /remember /hooks /plugins /marketplace /skills /imagine /imagine-video /loop /goal /deep-research /workflow /workflows /theme /feedback /btw /mcps /doctor /release-notes /docs /tutorial /import-claude /config-agents /personas /login /logout /usage /privacy /settings /timestamps — NOT live-verified. |
| `/theme` picker + palette cycles | UNREACHABLE. Docs: 5 themes (GrokNight default, GrokDay, TokyoNight, RosePineMoon, OscuraMidnight) + auto; `/theme` previews live, Enter applies, bare `/theme` cycles; minimal mode unpickable. |
| Settings modal (F2 / Ctrl+,) | UNREACHABLE (per shortcuts doc it opens from the agent screen). |
| In-session mouse (entry click-select, wheel scrollback, prompt-hover highlight, double-click, drag) | UNREACHABLE; docs assert them. |
| Provider/model UI in-TUI | NO in-TUI provider management exists — providers/models are config-file-only (`[model.*]`, `[model_providers.*]` + `env_key`/`extra_headers`/`query_params`/`model_provider = "<id>"`, `[models] default`); the TUI's `/model` / `Ctrl+M` picker chooses among the catalog (incl. custom) — unverified live. |
| Streaming/tool-call/diff render in TUI | UNREACHABLE (needs a live session). |
| Minimal mode (`--minimal`) | not exercised. |

---

## 7. Environment quirks noted

- **ConPTY → wsl.exe channel**: TERM=xterm-256color; the Linux app gets a true `/dev/pts`. wsl.exe injects a few init sequences (`ESC[?9001h ESC[?1004h ESC[2J`, then on exit `ESC[?25h` + an OSC 0 title) — inert for xterm-headless.
- **Color capability under this channel**: the TUI painted in the **256-color palette** (NOT truecolor): `i243/i233/i254` (+bold bit) on the login screen; `grok doctor` reported `color 256`. So in a ConPTY-backed channel the real app uses the quantized path — consistent with their "survives quantization" claim.
- **OSC52 clipboard attempt** was emitted on the copy click (see §5.1); a terminal that ACKs (`ESC[1;r;52;…`) would let the copy succeed.
- Config files left per instructions: WSL `/root/.grok/config.toml` and Windows `%USERPROFILE%\.grok\config.toml` — both set to the **working documented recipe** (§3.2), the invalid user-format version was replaced (it caused a hard startup TOML error).
- Windows host MSVC `target/` (partial build) left in the repo — gitignored; no repo source touched; **all temp harness scripts in `d:\I-harness-main` deleted**.

---

## 8. Bottom line for the parent team

1. Real build needs WSL/Linux (their proto build tooling is Linux-only; Windows protoc path is broken by hardcoded `/dev/stdout` in `xai-proto-build` — cleanest reportable bug).
2. Grok's TUI = **single-provider first-class UI**; provider management is config-only. The custom-model seam works (DeepSeek real round-trip) for the headless/agent path, but the **TUI welcomes with an unconditional grok.com device-code sign-in** — for our 1:1-style comparisons we cannot reach the session UI without a real xAI credential; everything in §6 remains spec-vs-docs only.
