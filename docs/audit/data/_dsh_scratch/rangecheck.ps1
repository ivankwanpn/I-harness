param(
  [Parameter(Mandatory=$true)][string[]]$JsonPath,
  [string]$Root = 'D:\agent-complete\deepseek-harness-dsh-v0.1.5-rc.2'
)
$total = 0; $bad = 0; $unverified = 0; $mech = 0
foreach ($p in $JsonPath) {
  $j = Get-Content $p -Raw | ConvertFrom-Json
  $doms = @()
  if ($j.domains) { $doms = $j.domains.PSObject.Properties | ForEach-Object { @{ n = $_.Name; v = $_.Value } } }
  else { $doms = @(@{ n = $j.domain; v = $j }) }
  foreach ($d in $doms) {
    foreach ($m in $d.v.mechanisms) {
      $mech++
      if (-not $m.verified) { $unverified++; "UNVERIFIED $($d.n)/$($m.name)" }
      foreach ($e in $m.evidence) {
        $total++
        if ($e -notmatch '^(?<p>[^:]+):(?<a>\d+)(?:-(?<b>\d+))?$') { $bad++; "BADFORMAT $($d.n)/$($m.name) :: $e"; continue }
        $rel = $Matches['p']; $a = [int]$Matches['a']; $b = if ($Matches['b']) { [int]$Matches['b'] } else { $a }
        $full = Join-Path $Root ($rel -replace '/', '\')
        if (-not (Test-Path $full)) { $bad++; "MISSINGFILE $($d.n)/$($m.name) :: $e"; continue }
        $n = (Get-Content $full | Measure-Object -Line).Lines
        $real = (Get-Content $full).Count
        if ($a -lt 1 -or $b -gt $real -or $a -gt $b) { $bad++; "OUTOFRANGE $($d.n)/$($m.name) :: $e (file has $real lines)" }
      }
    }
  }
}
"mech=$mech evidence=$total bad=$bad unverified=$unverified"
