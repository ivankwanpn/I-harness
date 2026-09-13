param(
  [Parameter(Mandatory=$true)][string[]]$JsonPath,
  [string]$Root = 'D:\agent-complete\deepseek-harness-dsh-v0.1.5-rc.2',
  [int]$PerMechanism = 1
)
foreach ($p in $JsonPath) {
  $j = Get-Content $p -Raw | ConvertFrom-Json
  $doms = @()
  if ($j.domains) { $doms = $j.domains.PSObject.Properties | ForEach-Object { @{ n = $_.Name; v = $_.Value } } }
  else { $doms = @(@{ n = $j.domain; v = $j }) }
  foreach ($d in $doms) {
    "########## $($d.n) ($p) ##########"
    foreach ($m in $d.v.mechanisms) {
      "== $($d.n)/$($m.name)  [verified=$($m.verified)]"
      $evs = @($m.evidence) | Select-Object -First $PerMechanism
      foreach ($e in $evs) {
        if ($e -notmatch '^(?<p>[^:]+):(?<a>\d+)(?:-(?<b>\d+))?$') { "   BADFORMAT $e"; continue }
        $rel = $Matches['p']; $a = [int]$Matches['a']; $b = if ($Matches['b']) { [int]$Matches['b'] } else { $a }
        $full = Join-Path $Root ($rel -replace '/', '\')
        if (-not (Test-Path $full)) { "   MISSINGFILE $e"; continue }
        $lines = Get-Content $full
        if ($a -lt 1 -or $b -gt $lines.Count) { "   OUTOFRANGE $e (file has $($lines.Count))"; continue }
        $lines[($a-1)..([Math]::Min($b-1, $lines.Count-1))] | ForEach-Object { "   $e > $_" }
        break
      }
    }
  }
}
