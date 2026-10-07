param([switch]$Test)
$ErrorActionPreference = 'Stop'
$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $packageRoot 'native/Cargo.toml'
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (!(Test-Path -LiteralPath $vcvars)) { throw 'Installed VS2022 BuildTools vcvars64.bat is required; this script never installs a compiler.' }
$cargoAction = if ($Test) { 'test' } else { 'build --release' }
$buildCommand = '"' + $vcvars + '" >nul && cargo ' + $cargoAction + ' --locked --manifest-path "' + $manifestPath + '"'
& $env:ComSpec /d /s /c $buildCommand
if ($LASTEXITCODE -ne 0) { throw "Native $cargoAction failed: $LASTEXITCODE" }
if ($Test) { exit 0 }
$artifactDirectory = Join-Path $packageRoot 'artifacts/win32-x64'
New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
$artifact = Join-Path $artifactDirectory 'i-harness-windows-helper.exe'
Copy-Item -LiteralPath (Join-Path $packageRoot 'native/target/release/i-harness-windows-helper.exe') -Destination $artifact -Force
$sourceFiles = @('native/Cargo.toml','native/Cargo.lock') + @(Get-ChildItem -LiteralPath (Join-Path $packageRoot 'native/src') -File | ForEach-Object { 'native/src/' + $_.Name })
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
}
$json = $provenance | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $artifactDirectory 'manifest.json'),$json + [Environment]::NewLine,(New-Object Text.UTF8Encoding($false)))
Write-Output "Built $artifact"
Write-Output "SHA256 $($provenance.helperSha256)"
