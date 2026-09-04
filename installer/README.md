# I-harness Windows installer (NSIS)

`installer/ih.nsi` + `scripts/build-installer.mjs` produce a self-contained
Windows setup exe: the bundled CLI (`dist/ih.mjs`) + an official Node runtime
zip (tree-sitter V8 included; downloads from nodejs.org at build time) + two
`cmd` launchers (`i-harness`, `ih`).

## Requirements (build machine)

- **Windows** (x64) — the installer targets `$PROGRAMFILES64\I-harness`.
- **Node.js >= 22** to run the build scripts (the repo already requires this).
- **Network for the first run only**: the Node runtime zip (~35 MB) and the
  portable NSIS compiler zip (~2.4 MB) are downloaded once into `build/` and
  cached thereafter.

## Building

```sh
node scripts/build-installer.mjs
```

What it does (each step cached/skip-if-not-needed):

1. **Payload** — uses `<repo>/dist`; if `dist/ih.mjs` is missing it runs
   `scripts/build-dist.mjs` (idempotent, owned by the dist milestone).

   > **DIST layout contract**: `dist/ih.mjs` (bundled ESM CLI, target node 22)
   > + `dist/node_modules/` (externalized native packages). `--version`
   > prints the package version; `tui --help` (and `help`) exit 0.

2. **Node runtime** — ensures `build/node-win-x64/node.exe`; downloads
   `https://nodejs.org/dist/v22.16.0/node-v22.16.0-win-x64.zip`
   (override: `IH_NODE_VERSION`) and ships only `node.exe` + `*.dll` + `LICENSE`
   (npm is stripped).
3. **Staging** — copies payload → `installer/staging/dist`, runtime →
   `installer/staging/node`, writes `installer/staging/i-harness.cmd` and
   `ih.cmd` (`installer/staging/` is **gitignored** — it is a build artifact:
   `@echo off` + `"%~dp0node\node.exe" "%~dp0dist\ih.mjs" %*`).
4. **makensis** — uses `IH_MAKENSIS`, or `build/tools/makensis/makensis.exe`,
   or PATH; otherwise downloads the portable NSIS from sourceforge
   (`nsis-3.11.zip`, override `IH_NSIS_VERSION` / `IH_NSIS_URL`). Compiles
   **both** builds with `/DAPP_VERSION=<ver>`:
   - `build/I-harness-Setup-<ver>.exe` — normal
   - `build/I-harness-Setup-<ver>-test.exe` — `IH_NSIS_TEST` build

Version default comes from `package.json` (`0.1.0`); override with
`IH_APP_VERSION` (or `/DAPP_VERSION=...` on the makensis command line).

## Install / uninstall

- The setup exe installs to `%ProgramFiles%\I-harness`, writes
  `Software\I-harness` + the Add/Remove Programs entry (HKLM), appends
  `;$INSTDIR` to the machine PATH
  (`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`, written
  back as REG_EXPAND_SZ; WM_SETTINGCHANGE broadcast so new processes pick it
  up — a re-launch also suffices), and creates Start Menu shortcuts
  (`I-harness`, `ih`, `Uninstall I-harness`). Admin required
  (`RequestExecutionLevel admin`).
- Uninstall from Settings → Apps, or `uninstall.exe` / the Start Menu entry:
  removes files, registry keys, the Start Menu folder and the PATH segment
  (safe: refuses to `RMDir /r` a drive root).
- Segment comparison for the PATH append/removal is **exact & case-sensitive**
  — the entry is only ever written by this installer, so on our own
  reinstall/uninstall cycles the bytes always match.

## Test build (no system writes)

The `-test.exe` build compiles with `IH_NSIS_TEST`:

- `RequestExecutionLevel user` (no elevation needed),
- **skips** the PATH append, registry writes/removal, Start Menu shortcuts
  and the `WM_SETTINGCHANGE` broadcast — `uninstall.exe` is still written and
  the file payload is fully installable/uninstallable.

```sh
node scripts/verify-installer.mjs
```

runs the real thing — never a GUI, never a system write: rebuilds artifacts,
silent-installs (`/S`) the **test** exe into a fresh temp dir under
`os.tmpdir()` outside the repo, then asserts — installed tree mirrors
staging, `i-harness.cmd --version` and `ih.cmd --version` print `<ver>`,
`ih.cmd tui --help` exits 0, bundled `node.exe --version` reports the runtime
version — then silent-uninstalls and polls (<=10 s) until the install dir is
gone (the NSIS uninstaller defers the final root-dir delete to its temp-copy
helper). PASS lines per assertion; nonzero exit on any failure.

## Notes / troubleshooting

- The installed layout goes `installer/staging/<rel>` → `$INSTDIR/<rel>`
  (`dist/ih.mjs`, `dist/node_modules/`, `node/node.exe`, `i-harness.cmd`,
  `ih.cmd`). If the dist contract changes, both `ih.nsi` and the verify
  assertions live in this folder.
- `File /r` paths are resolved against the script's own directory via
  `!cd "${__FILEDIR__}"` — makensis may be invoked from any cwd.
- Tooling fallbacks: zip extraction uses `C:\Windows\System32\tar.exe`
  (bsdtar), falling back to PowerShell `Expand-Archive`; downloads are
  streamed with redirect-following and fail loudly with the URL in the error.
- If sourceforge is unreachable, set `IH_NSIS_URL` to another mirror of
  `nsis-3.11.zip`; makensis must be the portable full distribution (it needs
  its `Include/` + `Plugins/` siblings for MUI2).
