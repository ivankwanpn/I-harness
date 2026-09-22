# Prior-art survey — 2026-09-18

**Why this exists.** Two decisions were blocked on having a better reference: what the **first trust
anchor** for a plugin-shipped hook should be, and what shape the **frontend projection contract**
should take. Three shipping agent harnesses were read to answer them. **The decisions are in §4 and
the reasoning is here**, because an adjudication whose evidence lives only in a session is not one.

**Nothing here is copied.** The three repos are larger, messier and less tested than this one (§5);
what they supply is *precedent*, not code.

---

## 0. What was read

| | Codex | Grok Build | opencode fork |
|---|---|---|---|
| identity | `codex-rust-v0.154.0` (OpenAI) | `grok-build-main` (xAI/SpaceXAI, `SOURCE_REV a549186d`) | `opencode-fork-private-999.0.15` |
| shape | 121 crates, 1.63M lines `rs` | 79 crates, 1.69M lines `rs` | 32 packages, 722k lines `ts` |
| tests | 15,450 `#[test]` | 30,006 `#[test]` | 757 test files |
| VCS | tarball, no `.git` | tarball, no `.git` | `.git`, 272 commits in 14 days |

For scale: this repo is **476 ts files / 87,340 lines**.

---

## 1. Hook trust — nobody has solved the first anchor

**All three pin the wrong object or nothing at all.**

| | What is pinned | Does it cover the script? |
|---|---|---|
| **Codex** | hash of the **config text** (`node ${PLUGIN_ROOT}/hook.js` — the *unexpanded* template), stored per handler in the **user** config layer | ❌ the vendor can rewrite `hook.js` freely; the handler stays `Trusted` forever |
| **Grok Build** | **nothing is hashed at all** — trust is `{canonical folder path, bool}` in `~/.grok/trusted_folders.toml` | ❌ and it covers every future edit inside that git root |
| **opencode fork** | — (its plugin model is code, not declarations) | — |

**Codex's three anchors, in descending strength:**

1. **A human prompt at startup** — the TUI shows `Untrusted`/`Modified` handlers and offers
   *Review / Trust all / Continue without trusting*; the choice writes `trusted_hash` into the user
   layer. `codex-rs/tui/src/startup_hooks_review.rs`, `hooks_rpc.rs`.
2. **A hardcoded source allowlist** for OpenAI's own bundled plugins
   (`plugin/src/bundled_hooks.rs`) — its own comment: *"Keep unsigned plugin exceptions together so
   they can be removed as signing lands."*
3. **A compile-time digest** — `option_env!("CODEX_BWRAP_SHA256")` baked into the binary. Only for
   `bwrap`, and `verify_digest` returns `Ok(())` when the expected value is `None`, so **self-built
   binaries skip verification silently**.

### 1.1 The rule worth taking

`codex-rs/hooks/src/config_rules.rs`, verbatim:

> *"Project, managed, and plugin layers can discover hooks, but they do not get to write user hook state."*

**The declarer cannot grant.** A plugin may *declare* a hook; only the user layer can make it
trusted. Codex enforces this by reading trust state from exactly two layers (`User`, `SessionFlags`).

### 1.2 The second idea worth taking

Grok's trust-boundary write-deny (`xai-grok-sandbox/src/hook_write_deny.rs`): under an enforcing
profile the kernel bind-mounts `$GROK_HOME/hooks`, `hooks-paths`, `config.toml`,
`trusted_folders.toml`, `managed_config.toml` and `requirements.toml` **read-only**, so neither the
agent nor a hook it spawns can rewrite the trust decisions governing the next load — **and the shell
refuses to start if the protection cannot be applied.** It also defends against a symlinked
`$GROK_HOME`, hard-linked hook JSON (`st_nlink != 1`), and rename races via dev/ino revalidation.

Grok additionally treats *"this repo has no configs yet"* as a **provisional** allow that is not
cached, so config arriving later (a `git pull`, an agent write) is re-gated. It is the one real TOCTOU
defence found in any of the three.

### 1.3 Where this repo already stands

**We are stronger on the second anchor than either.** `HookHandlerSpec.trust.sha256` is recomputed on
**every run**; a mismatch is a fail-closed deny. Codex caches trust at discovery
(`ClaudeHooksEngine::new`) and never re-verifies; Grok has nothing to re-verify. **Codex's model
cannot detect the substitution ours was built to catch.**

One deliberate difference to keep in view: **Grok's hooks fail OPEN** (timeout, crash, malformed
output → recorded, never blocking); only an explicit `{"decision":"deny"}` or exit 2 blocks. **Ours
fail closed.** That is a choice, not a defect in either.

---

## 2. Frontend projection — a closed union and a depth knob, never a registry

### 2.1 Codex (three frontends, one engine)

`codex-tui` has **no `codex-core` dependency at all** — it links only `app-server-protocol` +
`app-server-client`. Even "embedded" mode runs the real app-server over in-memory channels, described
in `app-server/src/in_process.rs` as *"rather than creating a second execution contract."*

| | |
|---|---|
| projection unit | `ThreadItem` — a **closed union of display shapes** (`UserMessage`, `AgentMessage`, `Reasoning`, `CommandExecution`, `FileChange`, `Plan`, …) |
| who projects | **the server**; the client never sees raw events |
| push | deltas: `ThreadHistoryChangeSet { changed_items, changed_turns, removed_turn_ids }` |
| pull | snapshot + cursor pagination |
| **view knob** | **exactly one**: `TurnItemsView = NotLoaded \| Summary \| Full`, default `Summary` |

**There is no per-section view registry.** Naming trap for our purposes: Codex's `ThreadSection` is
*sidebar grouping metadata*, not a projection.

### 2.2 Grok Build (one client that links its own engine)

`xai-acp-lib` (the contract crate) is **2,215 lines** against a 406k-line runtime and a 519k-line TUI
— **0.4%**. ACP is an **external standard** (agentclientprotocol.com, Zed-maintained), not home-grown.

**It has no registry either** — and paid for the absence: ~280 ad-hoc `x.ai/*` extension methods on top
of thin ACP, dispatched from one ~3,000-line match, with the section list living in the client's own
`match` arms. The one endpoint big enough to need it carries plain pagination knobs
(`offset`/`limit`/`turnIndex`/`stream`); `x.ai/session/state` returns a **hardcoded 7-column set**,
all columns, no client selection.

**Measured leak, not a claim:** the pager contains **869 `xai_grok_shell::` references across 150
files** — but **zero** references to `xai-chat-state`, the conversation-state crate. The *engine state*
boundary held; the *engine utilities/config/auth* boundary did not.

### 2.3 What this says about our `sections.ts`

`packages/settings/src/sections.ts` already **is** the Codex shape: `SectionName` is a **closed union**
of two, `SectionOp` is a **generic path-addressed patch** (so there is no per-section op vocabulary to
grow), and the revision guard is optimistic concurrency of the same family as Codex's kernel lease CAS.
**The one thing it must not become is a registry.**

---

## 3. Governance instruments (the most transferable find)

**Grok's `clippy.toml` `disallowed-methods` bans specific calls with a reason and a sanctioned
alternative:**

```toml
{ path = "std::env::home_dir",
  reason = "grok-home resolution goes through xai-dirs (uncached) or
            xai_grok_config::grok_home (cached); generic home via xai_dirs::home_dir" }
```

Four properties our reachability instrument does not have: each ban carries **the alternative**; the
escape hatch is *"allow with a reason"*; the ban is **scoped** to the tree where it matters
(*"Deliberately scoped to crates/codegen: the tree that ships to Windows"*); and it handles the case
where the banned path is no longer reachable.

**The `std::env::home_dir` entry is this repo's own `@i-harness/harness-home` story** — *"hand-rolled
grok-home resolution drifted across crates … `xai-dirs` carries the one sanctioned call."* We
consolidated the same four chains (`8c7d670a`) but **have no instrument that stops the drift
returning.** Their `xai-dirs` also returns **which source won** (`GrokHomeSource`), so *"why this
directory?"* is answerable; `resolveHarnessHome()` returns a bare string.

Our instrument **reports** drift; theirs **prevents** it. They are complementary, not alternatives.

---

## 4. Decisions taken (2026-09-18)

**D1 — the first trust anchor is a human decision, stored in the USER layer, pinning the script
bytes.** The declaring layer (plugin, project) may declare; only the user layer may grant, which is
Codex's rule (§1.1) and is what makes a first-run prompt safe rather than merely convenient. What
gets stored is `sha256` of the **script**, never of the config text — Codex pins the config text and
that is the weaker object, so it is the one part of their scheme we must not adopt.
`HookHandlerSpec.trust.sha256` already re-verifies per run; the anchor is the missing half.

**D2 — the frontend projection contract stays as it is: a closed union plus, if anything is needed, a
single depth knob.** No per-section view registry. `SectionName`'s closedness is what keeps that
honest, so growing it is a decision, not an edit.

**D3 — `sections.ts`'s contract survives the frontend rebuild** and is recorded as one class in
`scripts/audit/reachability-allowlist.json`.

---

## 5. What this document does not establish

Every figure was measured in one session on 2026-09-18 against the trees named in §0. **Re-measure
rather than quote.** Nothing here was re-checked after the reading.

**And a correction worth carrying, because it is the failure mode this repo keeps catching.** Reading
these three repos produced two confident claims about *our own* code that were false, both caught by
opening the files: that a crash mid-turn loses the rest of the turn (it does not — `maxDelayMs`,
default 200, flushes on its own deadline), and that we have no repair-on-read (`repair.ts` is a
log-semantic repair with a four-property contract). **Claims about our own tree made from its shape
rather than from reading it are the cheapest mistake available here.**
