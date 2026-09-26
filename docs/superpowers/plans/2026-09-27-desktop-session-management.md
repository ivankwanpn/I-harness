# Desktop session management

Approved goal continuation; extend existing session-persistence metadata and gateway host, no new package needed.

## Design
Rename and archive are metadata operations under coordinator ownership locks. Archive retains the entire log and is reversible. Default SDK list/dashboard excludes archived rows; a Desktop archived-list route exposes restore targets. UI actions are scoped to the selected workspace/session and confirm archive or rewind. Fork delegates to existing forkSession after flushing, preserving the completed-turn prefix. Rewind follows its existing package preview/execute interface and must be separately inspected before wiring destructive file restoration.

## Tasks
- [x] Add archived metadata and gateway management service (rename,archive,restore,list archived,fork).
- [x] Reserve sessions during mutations, reject active prompts/compaction/agent tasks; await mutations during close.
- [x] Wire scoped IPC and workspace-settings session management/archived view; refresh lists and handle stale selections. Direct task-menu affordance may follow the final UX review.
- [ ] Connect existing rewind preview/execute and explicit confirmation UI.
- [ ] Verify metadata persistence, restored list visibility, fork contents and busy/stale error handling; review and local commit.

Constraints: D:/frontend-test only; manual operations playground; no push; no account usage/reset/OAuth; browser visual acceptance remains deferred.

Backend checkpoint: metadata belongs to session-persistence; JSONL parseHeader now preserves boolean archived through profile/read/repair/header rewrite. Initial end-to-end archive assertion failed because the old parser omitted it, then passed after this fix. Real host test covers rename/archive, disappearance from session/list, restart, archived listing, restore and title preservation. JSONL18tests and host5tests passed. UI/IPC, fork content tests and rewind remain unfinished; this is not a completed session-management deliverable.

UI checkpoint: workspace settings contains active/archived lists, rename form, confirmed archive, restore and fork actions. Errors preserve rename input. App refreshes the originating workspace but only changes selected session/navigation when the original selection scope still matches. UI regression verifies archive confirmation/restore and failed rename. Fork now inherits durable modelSelection in the existing session-persistence package, verified by a previously failing fork test; completed-turn history rules stay unchanged. Rewind and final review remain outstanding.
