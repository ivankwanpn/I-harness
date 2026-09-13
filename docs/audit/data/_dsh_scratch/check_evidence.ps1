param(
  [string]$Dir = 'D:\I-harness-main\docs\audit\data\_dsh_scratch',
  [string]$Root = 'D:\agent-complete\deepseek-harness-dsh-v0.1.5-rc.2'
)
# Validate EVERY evidence citation in every salvaged mechanism entry, across both
# scratch shapes: flat {mechanisms:[...]} and nested {domains:{<id>:{mechanisms:[...]}}}.
function Get-Mechs($j) {
  $out = @()
  if ($j.mechanisms) { $out += $j.mechanisms }
  if ($j.domains) { foreach ($p in $j.domains.PSObject.Properties) { if ($p.Value.mechanisms) { $out += $p.Value.mechanisms } } }
  return $out
}
$grandTotal = 0; $grandOk = 0; $allProblems = @()
foreach ($f in (Get-ChildItem $Dir -File -Filter '*.json' | Sort-Object Name)) {
  try { $j = Get-Content $f.FullName -Raw | ConvertFrom-Json } catch { Write-Output "SKIP(unparseable) $($f.Name)"; continue }
  $mechs = Get-Mechs $j
  if ($mechs.Count -eq 0) { continue }
  $total = 0; $ok = 0; $problems = @()
  foreach ($m in $mechs) {
    if (-not $m.evidence) { $problems += "NOEVIDENCE $($m.name)"; continue }
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
  $grandTotal += $total; $grandOk += $ok; $allProblems += $problems
  Write-Output "### $($f.Name): mechs=$($mechs.Count) evidence=$total resolved=$ok problems=$($problems.Count)"
  $problems | ForEach-Object { Write-Output "    $_" }
}
Write-Output ""
Write-Output "==== TOTAL citations: $grandTotal ; resolved: $grandOk ; unresolvable: $($grandTotal-$grandOk) ===="
