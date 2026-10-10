# I-harness Desktop

The Windows desktop app for I-harness projects. For downloads and first-run setup, see the [product README](../../README.en.md) or [繁體中文介紹](../../README.md).

## Development

From the repository root, with Node.js >=22.18 and pnpm >=10:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @i-harness/desktop dev
```

Desktop hosts the interface, native windows, terminals and browser surfaces. Its gateway uses the same session, provider, permission, persistence and tool implementation as the rest of I-harness.

## Build and distribute

```powershell
# Build the app, gateway and portable ZIP
pnpm --filter @i-harness/desktop dist

# Package that app as a Windows installer
pnpm --filter @i-harness/desktop installer
```

Standard builds write to `packages/desktop/release/`. The current release is **0.1.4**; its full app and installer are collected together:

```text
release/
  I-harness/
    I-harness.exe
    resources/
  I-harness-0.1.4.zip
  I-harness-Setup-0.1.4.exe
  I-harness-Setup-0.1.4.exe.sha256
  I-harness-Setup-0.1.4.installer-build.json
  SHA256SUMS.txt
```

The portable and installed app carry Electron, gateway dependencies and their loader; end users do not install a separate Node runtime. Keep the portable executable and resources together. Build outputs are ignored by Git; downloadable packages belong in [GitHub Releases](https://github.com/ivankwanpn/I-harness/releases).

Release versions are recorded in [release notes](../../docs/releases/v0.1.4.md) and immutable Git tags. `IH_DESKTOP_RELEASE_LABEL` can select an isolated candidate directory; local build directories are not version-control artifacts. Published Setup and ZIP files are accompanied by SHA-256 checksums.

Installer behavior and compiler requirements are documented in [installer/README.md](installer/README.md).

## Configuration and user data

Desktop preferences, project navigation and conversations are stored in Electron's local user-data directory. The gateway uses the shared I-harness settings/provider/credential implementation; `IH_CONFIG_DIR` can specify its configuration location. User data is separate from the installed program payload.

Fresh installs use `%APPDATA%\I-harness`. When that default has no workspace or session history, the renamed app reuses existing history in `%APPDATA%\I-harness Desktop`. Explicit profile paths and established history in the current default remain authoritative; the app does not move or merge data directories.

Configure providers and model capabilities explicitly. Live work keeps its model binding until an explicit selection or reconstruction. Saved defaults and plugin configuration changes are reflected through the gateway's existing lifecycle.

Interactive human terminals use local user permissions. Agent tool operations follow their configured sandbox and approval policy. Human browser tabs are native UI surfaces, isolated from Node and the SDK bridge; they do not provide agent browser automation.

Manual memory notes and excerpts are available. Automatic memory extraction, a hosted I-harness account service and cloud session synchronization are not part of this release.

## Verification

```powershell
pnpm --filter @i-harness/desktop test
pnpm --filter @i-harness/desktop typecheck
pnpm verify:all
```

Release verification includes the actual packaged runtime and an isolated installer install/run/uninstall flow. Tests use owned temporary data rather than the user's projects or configuration.

## Licensing

I-harness uses the root MIT license. Adapted presentation files under `src/renderer/vendor/zcode/` retain Apache-2.0 notices, documented in `licenses/zcode/`. Distribution packages include the third-party notices under `resources/app/licenses/`.
