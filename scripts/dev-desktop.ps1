param(
    [string]$IhRepo = (Split-Path -Parent $PSScriptRoot),
    [string]$IhDevRoot = (Join-Path $env:LOCALAPPDATA 'I-harness-dev\stability'),
    [ValidateRange(1, 65535)][int]$MainInspectPort = 5858,
    [ValidateRange(1, 65535)][int]$RendererDebugPort = 9222,
    [switch]$WatchMain
)

$ErrorActionPreference = 'Stop'
$IhRepo = (Resolve-Path -LiteralPath $IhRepo).Path
$IhDevRoot = [IO.Path]::GetFullPath($IhDevRoot)
if (-not (Test-Path -LiteralPath (Join-Path $IhRepo 'packages\desktop\package.json'))) {
    throw 'The selected checkout has no IH Desktop package'
}

# Reserve each loopback endpoint briefly to detect an existing debugger.
if ($MainInspectPort -eq $RendererDebugPort) { throw 'The two debugger ports must differ' }
foreach ($ihPort in @($MainInspectPort, $RendererDebugPort)) {
    $ihListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $ihPort)
    try { $ihListener.Start() }
    catch { throw "Loopback port $ihPort is already in use. Select another debugger port." }
    finally { $ihListener.Stop() }
}

# Renderer HMR is automatic. WatchMain enables electron-vite's forced restart.
$ihProfile = Join-Path $IhDevRoot 'desktop-profile'
$ihConfig = Join-Path $IhDevRoot 'config'
$ihWorkspace = Join-Path $IhDevRoot 'workspace'
$ihRun = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss') + '-' + $PID
$ihLogs = Join-Path (Join-Path $IhDevRoot 'logs') $ihRun
New-Item -ItemType Directory -Force -Path $ihProfile, $ihConfig, $ihWorkspace, $ihLogs | Out-Null

$ihHead = (& git -C $IhRepo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot record IH source version' }
$ihDirtyPaths = @(& git -C $IhRepo status --porcelain)
if ($LASTEXITCODE -ne 0) { throw 'Cannot record IH source status' }
[pscustomobject]@{
    sourceHead = $ihHead
    sourceStatus = $ihDirtyPaths
    desktopProfile = $ihProfile
    configDirectory = $ihConfig
    workspace = $ihWorkspace
    startedUtc = (Get-Date).ToUniversalTime().ToString('o')
    mainInspectorPort = $MainInspectPort
    rendererDebuggerPort = $RendererDebugPort
    mainWatch = [bool]$WatchMain
} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $ihLogs 'source-version.json') -Encoding utf8

$ihPreviousConfig = $env:IH_CONFIG_DIR
$ihPreviousRunAsNode = $env:ELECTRON_RUN_AS_NODE
$env:IH_CONFIG_DIR = $ihConfig
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$ihExit = 1
Push-Location $IhRepo
try {
    $ihArguments = @('--filter', '@i-harness/desktop', 'run', 'dev', '--sourcemap', "--inspect=$MainInspectPort", "--remoteDebuggingPort=$RendererDebugPort")
    if ($WatchMain) { $ihArguments += '--watch' }
    $ihArguments += @('--', "--user-data-dir=$ihProfile")
    & pnpm.cmd @ihArguments 2>&1 | Tee-Object -FilePath (Join-Path $ihLogs 'desktop-terminal.log')
    $ihExit = $LASTEXITCODE
} finally {
    Pop-Location
    $env:IH_CONFIG_DIR = $ihPreviousConfig
    $env:ELECTRON_RUN_AS_NODE = $ihPreviousRunAsNode
}
exit $ihExit
