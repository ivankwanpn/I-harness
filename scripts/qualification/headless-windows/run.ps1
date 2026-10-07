param([string]$Label = 'acceptance', [ValidateSet('workloads.mts','visibility.mts','supplemental.mts','promotion.mts')][string]$WorkerFile = 'workloads.mts')
$ErrorActionPreference = 'Stop'
if ($Label -notmatch '^[a-z0-9-]+$') { throw 'Invalid fixture label' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$fixture = Join-Path $repo ".tmp/sandbox-redesign-headless-$Label"
if (Test-Path -LiteralPath $fixture) { throw 'Use a fresh fixture label to preserve previous evidence' }
New-Item -ItemType Directory -Path $fixture | Out-Null
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$observer = Join-Path $fixture 'observer.exe'
& $compiler /nologo /target:winexe /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "/out:$observer" (Join-Path $PSScriptRoot 'Observer.cs')
if ($LASTEXITCODE -ne 0) { throw 'Owned observer compilation failed' }
$env:TEMP=$fixture; $env:TMP=$fixture; $env:IH_CONFIG_DIR=Join-Path $fixture 'config'
$app=Join-Path $repo 'packages/desktop/release-sandbox-task5/I-harness Desktop/I-harness Desktop.exe'
$worker=Join-Path $PSScriptRoot $WorkerFile
$loader=([Uri](Join-Path $repo 'node_modules/tsx/dist/loader.mjs')).AbsoluteUri
$arguments=@($fixture,$app,$worker,$loader,$repo) | ForEach-Object { '"'+$_+'"' }
$ownedObserver=Start-Process -FilePath $observer -ArgumentList $arguments -WindowStyle Hidden -PassThru
$ownedObserver.WaitForExit()
Get-Content -LiteralPath (Join-Path $fixture 'observer-result.json') -ErrorAction SilentlyContinue
Get-Content -LiteralPath (Join-Path $fixture 'observer-error.txt') -ErrorAction SilentlyContinue
exit $ownedObserver.ExitCode
