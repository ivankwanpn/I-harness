# Settings form retention

IH retains visited form bodies under stable page, workspace and provider
identities, following the visited-body pattern inspected in DeepSeek Harness
0.2.0-rc.2. Inactive bodies are hidden and inert; their dialogs use the shared
`SettingsDialog.active` lifecycle. A pending editor remains the same component
until its operation finishes.

Reference source root: `D:/agent-complete/deepseek-harness-dsh-v0.2.0-rc.2`.
The reference tree was read only.

| Reference file | SHA-256 |
| --- | --- |
| `packages/client/ui-dockkit/src/components/TabLayout.tsx` | `ea6305089a7697214a3dba28ca0c364253721b5b67533fc5245bad3036e990be` |

The DSH MIT notice is retained in
[`LICENSE.controls.txt`](../design/LICENSE.controls.txt), with the shared
control and dialog provenance in
[`CONTROL_SOURCES.md`](../design/CONTROL_SOURCES.md).

The connection-owned ephemeral draft cache in `settings-drafts.tsx` is original
IH code. It uses a WeakMap and React context, with no additional dependency or
serialization. Draft payloads, private fields, original edit baselines and
revisions stay in renderer memory for the app session. Identity keys distinguish
workspace, resource kind/source/name, provider/model form kind, hook config/script
and memory note. Successful saves clear the submitted draft; conflicts retain
the draft and require explicit source comparison before adopting a new revision.

Functional state updates read the latest cached value for their own key. This
allows a pending acknowledgement to compare its submitted snapshot against a
newer draft, without borrowing another scope's current form value.
`clear(submittedSnapshot)` removes the cache entry only while it is still that
same snapshot; no-argument `clear()` remains available for an explicit discard.
Provider baselines, identities and values are one atomic snapshot, and MCP
snapshots include private inputs that have not yet been added to a secret patch.
Every cached hook load registers lifecycle cleanup. Memory acknowledgement
removes only the submitted note draft and retains another view's newer search.
Consumers retain their operation epoch, request lock, backend CAS checks and
read-only plugin ownership rules.
