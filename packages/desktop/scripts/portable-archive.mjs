import { existsSync, statSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

/** Include a single named root for Windows Explorer extraction. */
export function createPortableArchive(appDir, zipPath) {
  const source = resolve(appDir)
  const output = resolve(zipPath)
  const powershell = join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  // ZipFile includes hidden files and handles long paths with modern path rules
  // enabled in this process. Explicit separator rules keep ZIP entries portable.
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", [
    "$ErrorActionPreference='Stop'",
    "[System.AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling',$false)",
    "[System.AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths',$false)",
    "[System.AppContext]::SetSwitch('Switch.System.IO.Compression.ZipFile.UseBackslash',$false)",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "[System.IO.Compression.ZipFile]::CreateFromDirectory($env:IH_ARCHIVE_SOURCE,$env:IH_ARCHIVE_OUTPUT,[System.IO.Compression.CompressionLevel]::Optimal,$true)",
  ].join("; ")], { env: { ...process.env, IH_ARCHIVE_SOURCE: source, IH_ARCHIVE_OUTPUT: output }, encoding: "utf8", windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`Portable archive failed (exit ${result.status}): ${result.stderr ?? ""}`, { cause: result.error })
  if (!existsSync(output) || statSync(output).size === 0) throw new Error(`Portable archive is missing or empty: ${output}`)

  // Verify through the same ZIP namespace as Explorer, not only tar/.NET.
  // Paths travel as environment data, never as interpolated PowerShell code.
  const check = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; $shell=New-Object -ComObject Shell.Application; $zip=$shell.NameSpace($env:IH_ARCHIVE_VERIFY_PATH); if($null -eq $zip -or $zip.Items().Count -ne 1){throw 'ZIP is not readable as a single folder in Windows Explorer'}; $item=$zip.Items().Item(0); if(-not $item.IsFolder -or $item.Name -ne $env:IH_ARCHIVE_VERIFY_ROOT -or $item.GetFolder.Items().Count -eq 0){throw 'ZIP root folder is missing or empty'}"
  ], { env: { ...process.env, IH_ARCHIVE_VERIFY_PATH: output, IH_ARCHIVE_VERIFY_ROOT: basename(source) }, encoding: "utf8", windowsHide: true, timeout: 30_000 })
  if (check.error || check.status !== 0) throw new Error(`Portable archive Windows compatibility check failed: ${check.stderr ?? ""}`, { cause: check.error })
  return statSync(output).size
}
