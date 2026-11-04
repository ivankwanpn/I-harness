# Windows ACL wait-bridge runtime assets

These five files are the prebuilt Windows x64 runtime for the ACL wait bridge
(`ih-acl-wait-bridge.dll` plus its manifest, C source copy and worker modules).

## Why they are committed

`scripts/build-dist.mjs` and `packages/desktop/scripts/package-app.mjs` verify
this directory before producing a distribution. The source build recipe
(`native/build-bridge.ps1`) is deliberately pinned to a reviewed MSVC toolchain
and an assigned output directory, so a clean clone could not produce these files
and therefore could not run the distribution build at all (audit A-09).

## Provenance

Copied from the official `I-harness` v0.1.13 portable release
(`resources/app/out/native/runtime/`). The files were verified against the
manifest and the checked-in sources with:

```powershell
node -e "import('./scripts/runtime-acl-wait-assets.mjs').then(m=>{m.verifyAclWaitSourceAssets('D:/path/to/I-harness/packages/sandbox-windows-acl');console.log('verified')})"
```

## Regenerating

Only through the reviewed build recipe with the pinned MSVC toolchain. When the
C source or the worker modules change, regenerate, update
`acl-wait-assets.json`, and replace all five files together — the verifier
rejects a mixed set.
