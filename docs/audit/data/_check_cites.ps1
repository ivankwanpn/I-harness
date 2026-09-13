param([string]$Json = "D:\I-harness-main\docs\audit\data\2026-09-11-d3-opencode.json")
$ErrorActionPreference = 'Stop'
$roots = @{
  'upstream' = 'D:\agent-complete\opencode-1.18.30'
  'fork'     = 'D:\agent-complete\opencode-fork-private-999.0.15'
}
$cache = @{}
function Get-Lines([string]$p) {
  if (-not $cache.ContainsKey($p)) { $cache[$p] = [System.IO.File]::ReadAllLines($p) }
  return ,$cache[$p]
}
$j = Get-Content $Json -Raw | ConvertFrom-Json
foreach ($s in @('upstream','fork')) {
  $root = $roots[$s]
  $other = if ($s -eq 'upstream') { $roots['fork'] } else { $roots['upstream'] }
  Write-Output "===== $s  root=$root ====="
  $nBad = 0
  foreach ($d in $j.$s.domains.PSObject.Properties) {
    foreach ($m in $d.Value) {
      $probs = @()
      foreach ($ev in $m.evidence) {
        $idx = $ev.LastIndexOf(':')
        $rel = $ev.Substring(0, $idx); $ln = $ev.Substring($idx+1)
        $full = Join-Path $root ($rel -replace '/','\')
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
          $o = Join-Path $other ($rel -replace '/','\')
          $where = if (Test-Path -LiteralPath $o) { 'EXISTS-IN-OTHER-TREE' } else { 'ABSENT-BOTH' }
          $probs += "NOFILE($where): $ev"
          continue
        }
        $lines = Get-Lines $full
        if ($ln -match '^\d+$') {
          $l = [int]$ln
          if ($l -lt 1 -or $l -gt $lines.Count) { $probs += "RANGE($l > $($lines.Count)): $ev"; continue }
          if ([string]::IsNullOrWhiteSpace($lines[$l-1])) { $probs += "BLANK: $ev" }
        }
      }
      if ($probs.Count -gt 0) {
        $nBad++
        Write-Output ("[{0}] {1}  verified={2}" -f $d.Name, $m.name, $m.verified)
        $probs | ForEach-Object { Write-Output "    $_" }
      }
    }
  }
  Write-Output "  mechanisms with problems: $nBad"
}
