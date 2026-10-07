param([string]$Label='classification')
$ErrorActionPreference='Stop'
if ($Label -notmatch '^[a-z0-9-]+$') { throw 'Invalid fixture label' }
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$fixture=Join-Path $repo ".tmp/sandbox-redesign-$Label"
if (Test-Path -LiteralPath $fixture) { throw 'Use a fresh fixture label' }
New-Item -ItemType Directory -Path $fixture | Out-Null
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$program=Join-Path $fixture 'classification-tests.exe'
$output=Join-Path $fixture 'results.txt'
& $compiler /nologo /target:winexe /main:WindowClassificationTests "/out:$program" (Join-Path $PSScriptRoot 'WindowClassification.cs') (Join-Path $PSScriptRoot 'WindowClassificationTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Classification test compilation failed' }
$test=Start-Process -FilePath $program -ArgumentList ('"'+$output+'"') -WindowStyle Hidden -PassThru
$test.WaitForExit()
Get-Content -LiteralPath $output
exit $test.ExitCode
