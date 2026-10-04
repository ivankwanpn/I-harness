# Desktop v0.1.1 installer destination correction

The user downloaded the GitHub v0.1.1 installer and manually selected `C:/Program Files/I-harness Desktop`. Installation failed with the recovery/bootstrap diagnostic. This correction updates the existing v0.1.1 release at the user's explicit request.

## Cause and correction

The original production installer requested `asInvoker` execution. On an administrator account using its ordinary medium-integrity token, choosing Program Files did not grant write permission. The installer allowed the directory selection and failed only at its first recovery-file write.

Production now requests `highestAvailable`, allowing Windows to ask an administrator for consent. Standard users retain the per-user LocalAppData destination. Before leaving the directory page, the installer checks create-file/create-subdirectory access on the closest existing directory. Denied access keeps the user on that page with the concrete default location and permissions guidance. Silent installation repeats the check before upgrade/bootstrap operations.

The check opens and closes a directory handle; it creates no probe files and does not mutate an unowned directory. Win32 errors are captured immediately through the [NSIS System plug-in's `?e` option](https://nsis.sourceforge.io/Docs/System/System.html).

## Existing installations and privilege boundary

An elevated setup must not launch an unauthenticated previous uninstaller from user-writable storage. Actual token elevation is read and the token handle is closed; inability to read it fails closed. When an existing installation is present and the setup is elevated, it requires removing that copy through Windows Apps or its normal uninstaller before retrying. This refusal happens before copying/executing the prior uninstaller or modifying its marker. Unelevated per-user automatic upgrades retain their existing behavior.

User data and settings live separately from the application payload. The exact-file ownership/deletion rules remain in place. Test installers remain `asInvoker` and operate only inside owned repository fixtures, with no real registry, shortcuts or installation changes.

## Evidence

- Original RED: an owned NTFS denied-parent fixture reproduced the exact recovery-files error from the screenshot.
- Destination GREEN: actual denied ACL, fresh writable installation, unchanged nonempty unowned folder, and compiled production/test manifests.
- Privilege-boundary RED: a replaced previous uninstaller wrote an execution sentinel.
- Privilege-boundary GREEN: the sentinel is absent and the original marker is byte-identical.
- Independent scoped review: READY after the elevation correction.
- Native safety: five checks passed, including locked recovery files, bootstrap failure, stale uninstaller and overlapping setup ownership.
- Complete real-payload lifecycle: eleven checks passed, including install, unelevated upgrade, installed Electron/backend startup, running-app refusal, uninstall and preservation of unrelated files/app data.

The complete Desktop package gate passed 686 tests with three existing skips; its typecheck exited zero. The corrected artifact hash is recorded in the release's SHA256SUMS and build manifest after compilation. This phase does not automatically update the separately installed CLI.
