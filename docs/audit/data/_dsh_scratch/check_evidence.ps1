param(
  [string]$Dir = 'D:\I-harness-main\docs\audit\data\_dsh_scratch',
  [string]$Root = 'D:\agent-complete\deepseek-harness-dsh-v0.1.5-rc.2'
)
# Validate every evidence citation in every salvaged mechanism entry.
# Reports: how many citations resolve to a real file+line range, and the failures.
$files = Get-ChildItem $Dir -File -Filter '*.json'
$report = @()
$grandTotal = 0; $grandOk = 0
foreach ($f in $files) {
  try { $j = Get-Content $f.FullName -Raw | ConvertFrom-Json } catch { Write-Output "SKIP(unparseable) $($f.Name)"; continue }
  $total = 0; $ok = 0; $problems = @()
  foreach ($m in $j.mechanisms) {
    foreach ($e in $m.evidence) {
      $total++
      if ($e -notmatch '^(?<p>[^:]+):(?<a>\d+)(?:-(?<b>\d+))?$') { $problems += "BADFORMAT  $($m.name) :: $e"; continue }
      $rel = $Matches['p']; $a = [int]$Matches['a']; $b = if ($Matches['b']) { [int]$Matches['b'] } else { $a }
      $full = Join-Path $Root ($rel -replace '/', '\')
      if (-not (Test-Path -LiteralPath $full)) { $problems += "MISSINGFILE $($m.name) :: $e"; continue }
      $lc = (Get-Content -LiteralPath $full).Count
      if ($a -lt 1 -or $b -gt $lc -or $b -lt $a) { $problems += "OUTOFRANGE $($m.name) :: $e (file has $lc lines)"; continue }
      $ok++
    }
  }
  $grandTotal += $total; $grandOk += $ok
  $report += [pscustomobject]@{ file = $f.Name; mechs = $j.mechanisms.Count; evidence = $total; resolved = $ok; problems = $problems.Count }
  Write-Output "### $($f.Name): mechs=$($j.mechanisms.Count) evidence=$total resolved=$ok problems=$($problems.Count)"
  $problems | Select-Object -First 25 | ForEach-Object { Write-Output "    $_" }
}
Write-Output ""
Write-Output "==== TOTAL evidence citations: $grandTotal ; resolved to a real line: $grandOk ; unresolvable: $($grandTotal-$grandOk) ===="
