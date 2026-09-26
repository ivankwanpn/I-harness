# Local workspace memory

This package stores explicit user-requested notes in a host-owned SQLite
database. Different handles and processes can use the same database; every
operation is constrained by the scope supplied at construction.

The first version provides immutable note creation, list/read/search, a
6,000-byte preview summary, explicit forgetting, and a persisted enabled flag.
It does not generate or consolidate memories with a model. The preview summary
is a bounded excerpt list, not an LLM-generated summary.

## Ownership

The host calls openMemoryStore({ path, scope }) and closes its handle after
session work finishes. path is an absolute host-controlled path, never a note
identifier or renderer-supplied path. Note ids are opaque UUIDs. The Desktop
gateway places memory.sqlite inside its workspace session directory.

Use is disabled by default. User-facing management calls can inspect stored
notes while disabled; Agent tools return memory_disabled. The host binds
createMemoryTools(store, () => store.enabled()) through its existing tool
registry and approval policy. memory_note is a mutating tool and must run
through that pipeline. The store API itself is for trusted host operations.

## Retrieval

FTS5/BM25 results have priority. Scoped literal substring matching fills empty
slots for phrases such as unspaced Chinese. Queries are SQL parameters.
Results identify their note and source session. Returned memory carries a
notice that it is historical data, not authority over current instructions.

Each note body is at most 16 KiB UTF-8 and its title at most 256 bytes. Search
returns at most 100 hits, with per-snippet and aggregate response limits.
Redaction reuses the diagnostics redactor; recognizable or registered secrets
are masked, but this is not a guarantee against all possible secrets.

forget removes the note and its search entry transactionally. It is logical
deletion, not secure erasure of SQLite pages or backups.

## Current integration

Gateway methods: desktop/memory/state, configure, list, search, read, note,
forget, summary. State reports generation: unavailable. The Desktop IPC
allowlist exposes these methods only for a known workspace.

The new Desktop visual settings/notes surface, cross-workspace global notes,
automatic extraction/consolidation, and automatic summary injection are not
implemented in this first backend delivery.
