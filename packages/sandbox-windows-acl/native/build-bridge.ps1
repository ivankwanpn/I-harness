param([Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
# Source-only build recipe. Invocation requires ROOT's separate reviewed build grant.
# Never writes native/runtime, installed assets or a default output directory.
$resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory)
$allowedPrefix = [IO.Path]::GetFullPath('D:/I-harness-main/.superpowers/sdd/2026-10-29-native-platform-completion/bridge-build/')
if (-not $resolvedOutput.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase) -or $resolvedOutput -eq $allowedPrefix.TrimEnd('\','/')) { throw 'Build output must be a fresh assigned bridge-build child directory' }
if (Test-Path -LiteralPath $resolvedOutput) { throw 'Build output must not already exist' }
$vcRoot = 'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC/14.41.34120'
$sdkRoot = 'C:/Program Files (x86)/Windows Kits/10'
$sdkVersion = '10.0.22621.0'
$compiler = Join-Path $vcRoot 'bin/Hostx64/x64/cl.exe'
$dumpbin = Join-Path $vcRoot 'bin/Hostx64/x64/dumpbin.exe'
foreach ($tool in @($compiler, $dumpbin)) { if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Pinned build tool missing: $tool" } }
New-Item -ItemType Directory -Path $resolvedOutput | Out-Null
$previousInclude = $env:INCLUDE; $previousLib = $env:LIB; $previousPath = $env:PATH
try {
  $env:INCLUDE = @((Join-Path $vcRoot 'include'), (Join-Path $sdkRoot "Include/$sdkVersion/ucrt"), (Join-Path $sdkRoot "Include/$sdkVersion/shared"), (Join-Path $sdkRoot "Include/$sdkVersion/um")) -join ';'
  $env:LIB = @((Join-Path $vcRoot 'lib/x64'), (Join-Path $sdkRoot "Lib/$sdkVersion/ucrt/x64"), (Join-Path $sdkRoot "Lib/$sdkVersion/um/x64")) -join ';'
  $env:PATH = (Join-Path $vcRoot 'bin/Hostx64/x64') + ';' + $previousPath
  $source = Join-Path $PSScriptRoot 'acl-wait-bridge.c'
  $binary = Join-Path $resolvedOutput 'ih-acl-wait-bridge.dll'
  $object = Join-Path $resolvedOutput 'acl-wait-bridge.obj'
  $importLibrary = Join-Path $resolvedOutput 'ih-acl-wait-bridge.lib'
  $compileArgs = @('/nologo','/LD','/O2','/W4','/WX','/MT',"/Fo$object", $source, '/link','/Brepro','/INCREMENTAL:NO',"/OUT:$binary", "/IMPLIB:$importLibrary",'kernel32.lib')
  [ordered]@{ compiler=$compiler; args=$compileArgs; sdk=$sdkVersion; sourceSha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash; output=$resolvedOutput } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $resolvedOutput 'build-command.json') -Encoding utf8
  & $compiler @compileArgs 2>&1 | Tee-Object -FilePath (Join-Path $resolvedOutput 'build-output.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Pinned bridge compile failed' }
  $exports = & $dumpbin /nologo /exports $binary 2>&1
  if ($LASTEXITCODE -ne 0 -or -not ($exports -match '\bih_acl_unregister_wait_and_drain\b')) { throw 'Bridge export verification failed' }
  $exports | Set-Content -LiteralPath (Join-Path $resolvedOutput 'exports.txt') -Encoding utf8
  $headers = & $dumpbin /nologo /headers $binary 2>&1
  if ($LASTEXITCODE -ne 0 -or -not ($headers -match '8664 machine')) { throw 'Bridge x64 header verification failed' }
  $headers | Set-Content -LiteralPath (Join-Path $resolvedOutput 'headers.txt') -Encoding utf8
  Copy-Item -LiteralPath $source -Destination (Join-Path $resolvedOutput 'acl-wait-bridge.c')
  foreach ($name in @('native-wait-worker.mjs','native-wait-protocol.mjs')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot "../src/$name") -Destination (Join-Path $resolvedOutput $name) }
  $hashes = [ordered]@{}
  foreach ($name in @('ih-acl-wait-bridge.dll','native-wait-worker.mjs','native-wait-protocol.mjs','acl-wait-bridge.c')) { $hashes[$name] = (Get-FileHash -LiteralPath (Join-Path $resolvedOutput $name) -Algorithm SHA256).Hash.ToLowerInvariant() }
  [ordered]@{ protocol=1; platform='win32'; arch='x64'; koffiVersion='3.1.6'; export='ih_acl_unregister_wait_and_drain'; abi=[ordered]@{ return='DWORD'; arguments=@('HANDLE'); convention='WINAPI' }; build=[ordered]@{ compiler='MSVC14.41.34120'; sdk=$sdkVersion }; files=$hashes } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resolvedOutput 'acl-wait-assets.json') -Encoding utf8
} finally { $env:INCLUDE=$previousInclude; $env:LIB=$previousLib; $env:PATH=$previousPath }
Write-Output "Built unqualified review candidate: $resolvedOutput"
