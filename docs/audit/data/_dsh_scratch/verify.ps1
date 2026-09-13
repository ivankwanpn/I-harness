param(
  [Parameter(Mandatory=$true)][string]$JsonPath,
  [string]$Root = 'D:\agent-complete\deepseek-harness-dsh-v0.1.5-rc.2'
)
$j = Get-Content $JsonPath -Raw | ConvertFrom-Json
$bad = 0; $total = 0
function Show-Evidence($label, $ev) {
  foreach ($e in $ev) {
    $script:total++
    if ($e -notmatch '^(?<p>[^:]+):(?<a>\d+)(?:-(?<b>\d+))?$') { "BADFORMAT $label :: $e"; $script:bad++; continue }
    $rel = $Matches['p']; $a = [int]$Matches['a']; $b = if ($Matches['b']) { [int]$Matches['b'] } else { $a }
    $full = Join-Path $Root ($rel -replace '/', '\')
    if (-not (Test-Path $full)) { "MISSINGFILE $label :: $e"; $script:bad++; continue }
    $lines = Get-Content $full
    if ($a -lt 1 -or $b -gt $lines.Count) { "OUTOFRANGE $label :: $e (file has $($lines.Count) lines)"; $script:bad++; continue }
    $slice = $lines[($a-1)..([Math]::Min($b-1, $lines.Count-1))]
    "OK  $label :: $e"
    $slice | ForEach-Object { "      | $_" }
  }
}
foreach ($d in $j.domains.PSObject.Properties) {
  foreach ($m in $d.Value) { Show-Evidence "$($d.Name)/$($m.name)" $m.evidence }
}
"==== total evidence lines: $total ; problems: $bad ===="
