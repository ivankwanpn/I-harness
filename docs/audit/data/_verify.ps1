$ErrorActionPreference='Stop'
$path = "D:\I-harness-main\docs\audit\data\2026-09-11-d3-opencode.json"
$roots = @{ upstream='D:\agent-complete\opencode-1.18.30'; fork='D:\agent-complete\opencode-fork-private-999.0.15' }
$cache = @{}
function Lines($p){ if(-not $cache.ContainsKey($p)){ $cache[$p]=[System.IO.File]::ReadAllLines($p) }; ,$cache[$p] }
$j = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
$m = Get-Content -LiteralPath "D:\I-harness-main\docs\audit\data\2026-09-11-d3-modules.json" -Raw | ConvertFrom-Json

$fail = @()
function Cite-Ok($root,$ev,$tag){
  $i=$ev.LastIndexOf(':'); $rel=$ev.Substring(0,$i); $lns=$ev.Substring($i+1)
  $p = Join-Path $root ($rel -replace '/','\')
  if(-not (Test-Path -LiteralPath $p -PathType Leaf)){ $script:fail += "NOFILE $tag $ev"; return }
  $L = Lines $p
  foreach($part in ($lns -split '-')){
    if($part -notmatch '^\d+$'){ $script:fail += "BADLINE $tag $ev"; return }
    $n=[int]$part
    if($n -lt 1 -or $n -gt $L.Count){ $script:fail += "RANGE $tag $ev (total $($L.Count))"; return }
  }
  $first=[int](($lns -split '-')[0])
  if([string]::IsNullOrWhiteSpace($L[$first-1])){ $script:fail += "BLANK $tag $ev" }
}

foreach($s in @('upstream','fork')){
  $root=$roots[$s]
  $key = if($s -eq 'upstream'){'opencode'}else{'opencode-fork'}
  $x = $j.$s

  # GATE 1 coverage
  $want = @($m.sources.$key.modules | ForEach-Object { $_.name })
  $have = @($x.moduleCoverage.PSObject.Properties | ForEach-Object { $_.Name })
  $miss = @($want | Where-Object { $have -notcontains $_ })
  if($miss.Count){ $fail += "$s UNACCOUNTED MODULES: $($miss -join ', ')" }
  $ph = @($x.moduleCoverage.PSObject.Properties | Where-Object { ($_.Value -join ' ') -match 'UNREVIEWED|not individually reviewed' })
  if($ph.Count){ $fail += "$s UNREVIEWED placeholders: $($ph.Count)" }
  $empty = @($x.moduleCoverage.PSObject.Properties | Where-Object { -not $_.Value -or ($_.Value -join '').Trim() -eq '' })
  if($empty.Count){ $fail += "$s EMPTY coverage: $($empty.Count)" }

  # GATE 2 verified + citations
  $nv=0; $evCount=0
  foreach($d in $x.domains.PSObject.Properties){
    foreach($mech in $d.Value){
      if($mech.verified -ne $true){ $nv++; $fail += "$s UNVERIFIED: $($mech.name)" }
      if(-not $mech.evidence -or @($mech.evidence).Count -eq 0){ $fail += "$s NO EVIDENCE: $($mech.name)" }
      foreach($e in @($mech.evidence)){ $evCount++; Cite-Ok $root $e "$s/$($mech.name)" }
    }
  }
  $doms = @($x.domains.PSObject.Properties)
  $tot = 0; foreach($d in $doms){ $tot += @($d.Value).Count }
  $emptyDoms = @($doms | Where-Object { @($_.Value).Count -eq 0 } | ForEach-Object { $_.Name })
  $edStr = if($emptyDoms.Count -gt 0){ $emptyDoms -join ',' } else { 'none' }
  "== $s : modules $($have.Count)/$($want.Count) accounted | mechanisms $tot | unverified $nv | evidence $evCount | emptyDomains $edStr | hintCorrections $(@($x.hintCorrections).Count) | domainsAbsent $(@($x.domainsAbsent).Count)"
  foreach($hc in @($x.hintCorrections)){ foreach($k in @('module','hintWas','assigned','why')){ if($hc.PSObject.Properties.Name -notcontains $k){ $fail += "$s hintCorrection missing $k" } } }
  foreach($ab in @($x.domainsAbsent)){ foreach($k in @('domain','why')){ if($ab.PSObject.Properties.Name -notcontains $k){ $fail += "$s domainsAbsent missing $k" } } }
}

# GATE 5 forkDeltas
"== forkDeltas: $(@($j.forkDeltas).Count)"
foreach($d in @($j.forkDeltas)){
  foreach($k in @('area','change','evidence')){ if($d.PSObject.Properties.Name -notcontains $k){ $fail += "delta missing $k" } }
  if(-not $d.evidence){ $fail += "delta empty evidence: $($d.area)" }
  foreach($e in @($d.evidence)){
    # deltas legitimately cite BOTH trees: upstream (packages/opencode/*) and fork (packages/core/*)
    $i=$e.LastIndexOf(':'); $rel=$e.Substring(0,$i); $lns=$e.Substring($i+1)
    $ok=$false; $why=''
    foreach($tname in @('fork','upstream')){
      $p = Join-Path $roots[$tname] ($rel -replace '/','\')
      if(-not (Test-Path -LiteralPath $p -PathType Leaf)){ $why="NOFILE($tname)"; continue }
      $L = Lines $p; $good=$true
      foreach($part in ($lns -split '-')){
        if($part -notmatch '^\d+$'){ $good=$false; $why="BADLINE($tname)"; break }
        $n=[int]$part
        if($n -lt 1 -or $n -gt $L.Count){ $good=$false; $why="RANGE($tname,$n>$($L.Count))"; break }
      }
      if($good){
        $first=[int](($lns -split '-')[0])
        if([string]::IsNullOrWhiteSpace($L[$first-1])){ $why="BLANK($tname)"; continue }
        $ok=$true; break
      }
    }
    if(-not $ok){ $fail += "delta/$($d.area) $e [$why]" }
  }
}

""
if($fail.Count -eq 0){ "ALL GATES PASS" } else { "FAILURES ($($fail.Count)):"; $fail | ForEach-Object { "  $_" } }
