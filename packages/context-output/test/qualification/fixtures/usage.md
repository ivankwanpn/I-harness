# Explicit pinned native qualification

From packages/context-output:

```text
pnpm qualify:index-native --active-node ABSOLUTE_NODE_24_15_EXE --floor-node ABSOLUTE_NODE_22_18_EXE --out ABSOLUTE_FRESH_OUTPUT
```

Both pinned official Windows x64 executables must already exist. Output must not exist and its parent must exist. The launcher validates inputs and raw bundled fixture hashes before starting Vitest or either native runtime; it never downloads or installs anything. Ordinary Vitest discovery excludes the .qualification.ts file; exclusion is not a native qualification PASS. This command remains mandatory in the later fixed-version native qualification plan.

The native probe and gate behavior are unchanged. The portable argument fixture hashes differ deliberately from original author-local audit bytes. Exact original official URLs and hashes, representation, and provenance are recorded in manifest.json. Runtime source fields identify reviewed argument files, not raw implementation source. Native failure, snapshot/trace and product-adoption limits remain in reviewed-policy.md.
