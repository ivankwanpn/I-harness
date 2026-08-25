# @i-harness/sandbox-windows-acl

Windows ACL write-restriction sandbox backend for the `@i-harness/sandbox`
seam. It confines subprocesses through a `WRITE_RESTRICTED` access token whose
restricting-SID list carries capability SIDs, plus Write ACEs this package
adds to the workspace and private-temp directory DACLs.

This backend is an **honest-partial** sandbox. Read this before trusting it.

## Writes are restricted; reads are not

The write restriction is real: a confined child can only write where a
capability Write ACE grants it (the workspace and its private temp dir under
`workspace-write`, nowhere under `read-only`). Every Win32 failure is checked
and throws with the API name and exact code — a child is NEVER spawned
unrestricted.

But `WRITE_RESTRICTED` only intersects *write* accesses. **Reads, network
access, and process visibility are NOT restricted**: a confined process can
read any file the user can read, open sockets, and see/kill any process the
user can. This is inherent to restricted tokens and matches the
deepseek-harness Windows backend's documented vocabulary.

## No console / window isolation

A hidden console (`CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE`) is not attainable
under this restriction scheme — children sharing the host console die with
`STATUS_DLL_INIT_FAILED`. Children therefore share the host console (stdio
redirection is pipe-based and unaffected).

## `danger-full-access` is handled at the exec layer

This backend is composed only for confined modes. Mode `danger-full-access`
never composes a provider: the exec layer stays passthrough, so the command
runs unconfined. The backend never sees that mode (`SandboxPolicy` excludes it).

## Enforcement is `partial`, and the boundaries are documented

The provider reports `enforcement: "partial"` — the seam's way of saying "the
mechanism restricts writes, but not everything file-effect might imply". The
known boundary holes: `WRITE_RESTRICTED` + Everyone restricting list preserves
the ambient Everyone write grants, and NTFS hard links can bypass directory
DACLs (a hard link into a writable directory exposes the link target).
Writable directories must be caller-owned (owner-implicit `WRITE_DAC`).

## Composition notes

`createWindowsAclSandbox(options)` returns a `SandboxProvider` *with* a
`dispose()` (the factory-shaped provider that the local wrapper drops — the
compose site owns the backend and must call `dispose()` at teardown to revoke
the revocable temp grants). Only `writableDirs` is consumed by the factory;
the per-call `SandboxPolicy` is the actual enforcement input.
