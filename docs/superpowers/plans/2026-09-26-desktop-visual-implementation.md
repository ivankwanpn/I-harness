# Desktop visual implementation

**Goal:** Implement the approved ZCode visual fidelity design in the experimental Desktop package.
**Architecture:** Keep app.tsx as the SDK authority; UI preferences and panel visibility live in a small Zustand store. Components use the existing bridge.
**Spec:** ../specs/2026-09-26-desktop-visual-fidelity-design.md
**Constraints:** No push, no production checkout edits, no new backend capabilities, public dependencies only.

- [ ] Shell: nested session navigation, human titles, closed-by-default review, narrow layout. Update workbench interaction tests.
- [ ] Reading and composing: safe Markdown, measured virtual rows, bounded drafts, IME-safe keyboard interaction. Preserve send failures and draft switching tests.
- [ ] Localization: typed Traditional Chinese/English messages and preference control, migrate all visible surfaces.
- [ ] Settings and memory: connect approved memory/search/compact bridge with loading/error states and scope labels.
- [ ] Native shell: sender-scoped window controls and geometry; retain preload isolation.
- [ ] Visual acceptance: compare real Electron screenshots against recorded ZCode references; check narrow width, long conversation, approvals and review.
- [ ] Verification: Desktop test/typecheck/build, fresh review, then local commit only.

## Checkpoint — 2026-09-26

### Approved strategy revision: reuse source first

User approved adapting ZCode UI source before tuning appearance. Baseline saved as be8414c. First extraction is PermissionCard, retaining upstream JSX hierarchy and Tailwind utility classes, using a small I-harness approval adapter. Apache license and original NOTICE are preserved under packages/desktop/licenses/zcode and copied by the portable packaging script. Tailwind is a build-time public dependency; no ZCode backend services or stores imported. Explicit confirmation and native radio accessibility are retained intentionally.

Development visual fixture: /permission-preview.html, using simulated requests only. Browser automation denied access to localhost:5173, so visual acceptance of this extraction is still pending; no fallback bypass attempted.

ComposerSurface now adapts the form/input-shell/toolbar from prompt-editor/ChatPromptEditor.tsx. Existing I-harness textarea, bounded drafts, pending-send ownership, IME handling and cancellation remain connected through slots. Model label is read-only backend data. Both extractions retain provenance in licenses/zcode/README.md. The same fixture includes a clearly labelled simulated composer whose submit only returns a local preview error.

Implemented shell geometry, nested navigation, default-closed review, safe Markdown, shell localization, IME-safe Enter handling and session-owned pending sends. Memory management now uses the existing workspace-scoped gateway for list/search/read/add/delete/configure. Review diff lines distinguish additions/removals/hunks.

Independent review found and prompted fixes for bounded pending interactions, external HTTPS/HTTP links, pending-send ownership across remounts, and conversation navigation from Memory. Regression cases cover the latter two. Native screenshots confirmed empty/workspace shell and language changes; user confirmed the native folder picker works. Automated native focus remains unreliable, so memory CRUD and long-conversation visual acceptance are not claimed complete.

Remaining: full localization, model/context presentation and search/compact surfaces, richer tool activity, native window controls, detailed settings, and full visual acceptance. All future manual operation tests target D:/agent-complete/playground. Development stays in D:/frontend-test; no push.
