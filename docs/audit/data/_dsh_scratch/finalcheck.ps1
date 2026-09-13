param(
  [Parameter(Mandatory=$true)][string]$JsonPath,
  [string]$Root = 'D:\agent-complete\deepseek-harness-dsh-v0.1.5-rc.2'
)
$j = Get-Content $JsonPath -Raw | ConvertFrom-Json
$mech = 0; $total = 0; $bad = 0; $unverified = 0; $noev = 0
foreach ($d in $j.domains.PSObject.Properties) {
  foreach ($m in $d.Value) {
    $mech++
    if (-not $m.verified) { $unverified++; "UNVERIFIED $($d.Name)/$($m.name)" }
    if (-not $m.evidence -or @($m.evidence).Count -eq 0) { $noev++; "NOEVIDENCE $($d.Name)/$($m.name)" }
    foreach ($e in @($m.evidence)) {
      $total++
      if ($e -notmatch '^(?<p>[^:]+):(?<a>\d+)(?:-(?<b>\d+))?$') { $bad++; "BADFORMAT $($d.Name)/$($m.name) :: $e"; continue }
      $rel = $Matches['p']; $a = [int]$Matches['a']; $b = if ($Matches['b']) { [int]$Matches['b'] } else { $a }
      $full = Join-Path $Root ($rel -replace '/', '\')
      if (-not (Test-Path $full)) { $bad++; "MISSINGFILE $($d.Name)/$($m.name) :: $e"; continue }
      $real = @(Get-Content $full).Count
      if ($a -lt 1 -or $b -gt $real -or $a -gt $b) { $bad++; "OUTOFRANGE $($d.Name)/$($m.name) :: $e (file has $real)" }
    }
  }
}
$covMissing = 0
foreach ($k in $j.moduleCoverage.PSObject.Properties) { if ($_.Value -eq 'UNCOVERED') { $covMissing++ } }
"mechanisms=$mech evidence=$total bad=$bad unverified=$unverified no-evidence=$noev"
"coverageKeys=$($j.moduleCoverage.PSObject.Properties.Count) uncovered=$covMissing"
"hintCorrections=$($j.hintCorrections.Count) domainsAbsent=$(@($j.domainsAbsent).Count) pluginKernelChars=$($j.pluginKernel.Length)"
