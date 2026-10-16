param([switch]$Test, [string]$MsysSdkDirectory)
$ErrorActionPreference = 'Stop'
$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $packageRoot 'native/Cargo.toml'
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (!(Test-Path -LiteralPath $vcvars)) { throw 'Installed VS2022 BuildTools vcvars64.bat is required; this script never installs a compiler.' }
if (!$Test) {
  if (!$MsysSdkDirectory) { $MsysSdkDirectory = Join-Path $packageRoot '../../build/pty-msys-sdk' }
  $MsysSdkDirectory = [IO.Path]::GetFullPath($MsysSdkDirectory)
  $pinnedBuildFiles = [ordered]@{
    'usr/bin/ld.exe' = '47f9ba070741b0ee4e95ea53d5985ab901d9c3828691c2dec045c3fb33e32e7c'
    'usr/bin/objdump.exe' = '1259abda47dc8f2586b777c4467e80a36b2075ab9f5c25f3472387cf9e36389b'
    'usr/lib/crt0.o' = 'bfeb584ea9a516dd3159a22e11fb2a2822c374b41c8b5f291db359155eee8021'
    'usr/lib/libmsys-2.0.a' = 'f5b6ef1d41392ea782b7b0d8acac86ca49bb967f5441362b79b3fdb76479ad89'
  }
  foreach ($relative in $pinnedBuildFiles.Keys) {
    $path = Join-Path $MsysSdkDirectory $relative
    if (!(Test-Path -LiteralPath $path) -or (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -ne $pinnedBuildFiles[$relative]) {
      throw "Pinned MSYS build dependency is absent or changed: $relative. Stage the documented official SDK archives; runtime never installs or downloads them."
    }
  }
  $bridgeSource = Join-Path $packageRoot 'native/msys/bridge.c'
  $loaderSource = Join-Path $packageRoot 'native/msys/import-path.c'
  $bridgeObject = Join-Path $packageRoot 'native/target/msys-bridge.obj'
  $loaderObject = Join-Path $packageRoot 'native/target/msys-loader.obj'
  New-Item -ItemType Directory -Force -Path (Join-Path $packageRoot 'native/target') | Out-Null
  $compileBridge = '"' + $vcvars + '" >nul && cl /nologo /W4 /WX /c /O2 /GS- /Zl /Fo"' + $bridgeObject + '" "' + $bridgeSource + '" && cl /nologo /W4 /WX /c /O2 /GS- /Zl /Fo"' + $loaderObject + '" "' + $loaderSource + '"'
  & $env:ComSpec /d /s /c $compileBridge
  if ($LASTEXITCODE -ne 0) { throw "MSYS adapter compilation failed: $LASTEXITCODE" }
  $kernelImport = @(Get-ChildItem -LiteralPath 'C:/Program Files (x86)/Windows Kits/10/Lib' -Directory | Sort-Object Name | ForEach-Object { Join-Path $_.FullName 'um/x64/kernel32.lib' } | Where-Object { Test-Path -LiteralPath $_ }) | Select-Object -Last 1
  if (!$kernelImport) { throw 'Installed Windows SDK x64 import libraries are required.' }
  $adapter = Join-Path $packageRoot 'native/target/i-harness-msys-pty.exe'
  $taskBuildPath = $env:PATH
  try {
    $env:PATH = 'C:/Program Files/Git/usr/bin;' + $taskBuildPath
    & (Join-Path $MsysSdkDirectory 'usr/bin/ld.exe') -m i386pep --no-insert-timestamp --subsystem console -e mainCRTStartup -o $adapter (Join-Path $MsysSdkDirectory 'usr/lib/crt0.o') $loaderObject $bridgeObject (Join-Path $MsysSdkDirectory 'usr/lib/libmsys-2.0.a') $kernelImport
    if ($LASTEXITCODE -ne 0) { throw "MSYS adapter linking failed: $LASTEXITCODE" }
    $imports = (& (Join-Path $MsysSdkDirectory 'usr/bin/objdump.exe') -p $adapter) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'MSYS adapter import inspection failed.' }
    $dllNames = @([regex]::Matches($imports, 'DLL Name:\s*(\S+)') | ForEach-Object { $_.Groups[1].Value.ToLowerInvariant() })
    $sections = (& (Join-Path $MsysSdkDirectory 'usr/bin/objdump.exe') -h $adapter) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $dllNames.Count -ne 2 -or 'kernel32.dll' -notin $dllNames -or 'msys-2.0.dll' -notin $dllNames -or $sections -notmatch '\.ihmsys') { throw 'MSYS adapter template must have exactly the system/MSYS imports and its reserved binding slot.' }
  } finally { $env:PATH = $taskBuildPath }
  $adapterSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $adapter).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText((Join-Path $packageRoot 'native/msys/bridge.sha256'), $adapterSha256 + "`n", (New-Object Text.UTF8Encoding($false)))
}
$cargoAction = if ($Test) { 'test' } else { 'build --release' }
$buildCommand = '"' + $vcvars + '" >nul && cargo ' + $cargoAction + ' --locked --manifest-path "' + $manifestPath + '"'
& $env:ComSpec /d /s /c $buildCommand
if ($LASTEXITCODE -ne 0) { throw "Native $cargoAction failed: $LASTEXITCODE" }
if ($Test) { exit 0 }
$artifactDirectory = Join-Path $packageRoot 'artifacts/win32-x64'
New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
$artifact = Join-Path $artifactDirectory 'i-harness-windows-helper.exe'
Copy-Item -LiteralPath (Join-Path $packageRoot 'native/target/release/i-harness-windows-helper.exe') -Destination $artifact -Force
Copy-Item -LiteralPath $adapter -Destination (Join-Path $artifactDirectory 'i-harness-msys-pty.exe') -Force
$noticeDirectory = Join-Path $artifactDirectory 'msys-notices'
New-Item -ItemType Directory -Force -Path $noticeDirectory | Out-Null
$noticeHashes = [ordered]@{}
foreach ($noticeFile in @('CYGWIN_LICENSE','COPYING.LIB','COPYING','SOURCES.md')) {
  $noticePath = Join-Path $noticeDirectory $noticeFile
  Copy-Item -LiteralPath (Join-Path $packageRoot ('native/msys/notices/' + $noticeFile)) -Destination $noticePath -Force
  $noticeHashes['msys-notices/' + $noticeFile] = (Get-FileHash -Algorithm SHA256 -LiteralPath $noticePath).Hash.ToLowerInvariant()
}
$nativeSourceRoot = [IO.Path]::GetFullPath((Join-Path $packageRoot 'native/src')).TrimEnd('\') + '\'
$nativeSourceFiles = @(Get-ChildItem -LiteralPath $nativeSourceRoot -File -Recurse | ForEach-Object {
  $sourcePath = [IO.Path]::GetFullPath($_.FullName)
  if (!$sourcePath.StartsWith($nativeSourceRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Native source path escaped native/src.' }
  # Substring works on Windows PowerShell 5 / .NET Framework; GetRelativePath does not.
  'native/src/' + $sourcePath.Substring($nativeSourceRoot.Length).Replace('\', '/')
})
$sourceFiles = @('native/Cargo.toml','native/Cargo.lock') + $nativeSourceFiles + @(Get-ChildItem -LiteralPath (Join-Path $packageRoot 'native/msys') -File | ForEach-Object { 'native/msys/' + $_.Name })
$sourceHashes = [ordered]@{}
foreach ($relative in ($sourceFiles | Sort-Object)) { $sourceHashes[$relative] = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $packageRoot $relative)).Hash.ToLowerInvariant() }
$provenance = [ordered]@{
  manifestVersion = 1
  protocolVersion = 1
  target = 'x86_64-pc-windows-msvc'
  helperFile = 'i-harness-windows-helper.exe'
  helperSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash.ToLowerInvariant()
  protocolSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $packageRoot 'protocol.md')).Hash.ToLowerInvariant()
  rustc = ((& rustc --version) -join '').Trim()
  cargo = ((& cargo --version) -join '').Trim()
  compilerSetup = $vcvars
  msvcTools = (Get-Content -LiteralPath (Join-Path (Split-Path $vcvars) 'Microsoft.VCToolsVersion.default.txt') -Raw).Trim()
  buildCommand = 'cargo build --release --locked --manifest-path native/Cargo.toml (VS2022 x64 environment)'
  windows = [Environment]::OSVersion.VersionString
  schema = [ordered]@{ repository='https://github.com/microsoft/mxc'; revision='6cd3d58f05d3447e67109cfb75e042803b843ca4'; package='process_security_environment_spec'; packageVersion='0.8.0'; path='external/windows-sdk/ProcessSecurityEnvironment.fbs'; sha256='7d14b01850a735329da00cde4d4d2e32e463f49026a39708be9059fd64e764d3'; flatbuffers='25.12.19'; windowsSys='0.61.2' }
  sources = $sourceHashes
  msysPty = [ordered]@{
    file = 'i-harness-msys-pty.exe'
    sha256 = $adapterSha256
    runtime = 'Caller-selected installed x86-64 MSYS runtime, observed/pinned before commit; no DLL is shipped.'
    buildCommand = 'MSVC C /O2 /GS- /Zl; GNU ld -m i386pep --no-insert-timestamp --subsystem console -e mainCRTStartup; official MSYS crt0/import archive; native prepare binds exactly one MSYS import to the admitted absolute installed DLL'
    buildDependencies = @(
      [ordered]@{ package='msys2-runtime-devel'; version='3.6.10-6'; url='https://repo.msys2.org/msys/x86_64/msys2-runtime-devel-3.6.10-6-x86_64.pkg.tar.zst'; sha256='d50d94d36f45da93fc8ed53c91cd1c1eae38a370da1b3e00d31d0f8760e91ca9'; source='https://repo.msys2.org/msys/sources/msys2-runtime-3.6.10-6.src.tar.zst'; license='LGPL-3.0-or-later with runtime linking exception; included source notices also apply' },
      [ordered]@{ package='binutils'; version='2.47-1'; url='https://repo.msys2.org/msys/x86_64/binutils-2.47-1-x86_64.pkg.tar.zst'; sha256='b7ddaca6e8b63774cdb1f5ac2720963cd76f8f62ca7e2667b1b0f008ed7ecba2'; source='https://repo.msys2.org/msys/sources/binutils-2.47-1.src.tar.zst'; license='GPL-3.0-or-later; build-only, not shipped' }
    )
    buildFiles = $pinnedBuildFiles
    notices = $noticeHashes
  }
}
$json = $provenance | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $artifactDirectory 'manifest.json'),$json + [Environment]::NewLine,(New-Object Text.UTF8Encoding($false)))
Write-Output "Built $artifact"
Write-Output "SHA256 $($provenance.helperSha256)"
