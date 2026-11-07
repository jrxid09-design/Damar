# ACC GATES RUNNER - Windows-native, hardened (certification grade).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\acc-gates.ps1
# Exit 0 hanya bila SEMUA mandatory gate: tereksekusi, totals terparse,
# exit=0, fail=0. Selain itu exit non-zero dengan ACCGATES_RESULT=FAIL.
$ErrorActionPreference = "Continue"
Set-Location -LiteralPath $PSScriptRoot
Set-Location ..

$log = "C:\Workspace\Aether\.tmp-closure\acc-gates.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
Set-Content -Path $log -Value "ACC C0 GATES" -Encoding UTF8

$totals      = New-Object System.Collections.ArrayList
$executed    = New-Object System.Collections.ArrayList
$structural  = New-Object System.Collections.ArrayList

function Run([string]$name, [string[]]$cmd) {

    # ---- structural guards (mandatory) ---------------------------------
    if ([string]::IsNullOrWhiteSpace($name)) {
        [void]$script:structural.Add("gate tanpa nama")
        return
    }
    if ($null -eq $cmd -or $cmd.Count -lt 2 -or
        [string]::IsNullOrWhiteSpace([string]$cmd[0])) {
        [void]$script:structural.Add("$name : invocation null/invalid")
        Write-Host ("GATE {0}: STRUCTURAL FAILURE (invocation invalid)" -f $name)
        [void]$script:totals.Add([pscustomobject]@{
            step=$name; exit=125; tests=-1; pass=-1; fail=-1; skipped=-1 })
        [void]$script:executed.Add($name)
        return
    }

    ("===== GATE " + $name + " =====") | Out-File $log -Append -Encoding UTF8

    $rest = @()
    if ($cmd.Count -gt 1) { $rest = $cmd[1..($cmd.Count-1)] }

    try {
        $out  = & $cmd[0] @rest 2>&1
        $code = $LASTEXITCODE
        if ($null -eq $code) { throw "process did not execute" }
        $out | Out-File $log -Append -Encoding UTF8
    }
    catch {
        [void]$script:structural.Add("$name : invocation threw ($_)")
        Write-Host ("GATE {0}: THREW" -f $name)
        [void]$script:totals.Add([pscustomobject]@{
            step=$name; exit=126; tests=-1; pass=-1; fail=-1; skipped=-1 })
        [void]$script:executed.Add($name)
        return
    }

    $txt = ($out | Out-String)
    $row = New-Object System.Collections.Specialized.OrderedDictionary
      $row.step=$name; $row.exit=$code
      $row.tests=$null; $row.pass=$null; $row.fail=$null; $row.skipped=$null

    foreach ($k in @('tests','pass','fail','skipped')) {
        $line = ($txt -split "`n" |
                 Where-Object { $_ -match "(^|\s)$k \d+\s*$" } |
                 Select-Object -Last 1)
        if ($line -match "$k (\d+)\s*$") { $row[$k] = [int]$Matches[1] }
    }

    # Mandatory totals harus terparse; selain itu gate ini tidak sah.
    if ($null -eq $row.tests -or $null -eq $row.pass -or $null -eq $row.fail) {
        [void]$script:structural.Add("$name : totals tidak dapat di-parse")
        Write-Host ("GATE {0}: TOTALS UNPARSEABLE" -f $name)
    }

    [void]$script:totals.Add([pscustomobject]$row)
    [void]$script:executed.Add($name)
    Write-Host ("GATE {0}: exit={1} tests={2} pass={3} fail={4}" -f `
        $name,$code,$row.tests,$row.pass,$row.fail)
}

$T = @("--test-concurrency=1","--require","./tests/helpers/testEnv.js","--test-force-exit")

# ---- ACC targeted ----------------------------------------------------------
Run "c0_1_continuity"    @("node","--test",$T[0],$T[1],$T[2],$T[3],"tests/cognition/accContinuity.test.js")
Run "c0_2_epistemics"    @("node","--test",$T[0],$T[1],$T[2],$T[3],"tests/cognition/accEpistemics.test.js")
Run "c0_3_affect_intero" @("node","--test",$T[0],$T[1],$T[2],$T[3],"tests/cognition/accAffectInteroception.test.js")
Run "c0_4_workspace"     @("node","--test",$T[0],$T[1],$T[2],$T[3],"tests/cognition/accWorkspace.test.js")
Run "c0_5_witness_meta_prediction" @("node","--test",$T[0],$T[1],$T[2],$T[3],"tests/cognition/accWitnessMetaPrediction.test.js")
Run "c0_678_bio_substrate_security" @("node","--test",$T[0],$T[1],$T[2],$T[3],"tests/cognition/accAutobiographySubstrateSecurity.test.js")
Run "c0_landing_regression" @("node","--test",$T[0],$T[1],$T[2],$T[3],"tests/cognition/accLandingRegression.test.js")
Run "c0_store_parity" @("node","--test",$T[0],$T[1],$T[2],$T[3],
   "tests/cognition/accStoreParity.test.js")

# Paritas backend read-model (memory vs sqlite) + rekonsiliasi crash.
# Jalur sqlite ACC adalah jalur produksi; tanpa langkah ini ia tidak
# tersertifikasi untuk deployment nyata.

# ---- Foundation authority regression ---------------------------------------
Run "foundation_authority" @("node","--test",$T[0],$T[1],$T[2],$T[3],
  "tests/safety/authoritySurface.test.js",
  "tests/safety/delegationAuthority.test.js",
  "tests/safety/delegationGrantSites.test.js",
  "tests/safety/capabilitySetParity.test.js",
  "tests/safety/boundedDelegationE2E.test.js",
  "tests/safety/m1RestrictionPreservation.test.js")

# ---- RESULT -----------------------------------------------------------------
"===TOTALS===" | Out-File $log -Append -Encoding UTF8
foreach ($t in $totals) {
  ("step={0} exit={1} tests={2} pass={3} fail={4} skipped={5}" -f `
    $t.step,$t.exit,$t.tests,$t.pass,$t.fail,$t.skipped) |
    Out-File $log -Append -Encoding UTF8
}

# Semua mandatory gate wajib tereksekusi:
$EXPECTED = @(
  "c0_1_continuity","c0_2_epistemics","c0_3_affect_intero","c0_4_workspace",
  "c0_5_witness_meta_prediction","c0_678_bio_substrate_security",
  "c0_landing_regression","c0_store_parity","foundation_authority"
)
$missing = @($EXPECTED | Where-Object { $executed -notcontains $_ })

$failedGates = @($totals | Where-Object {
    $_.exit -ne 0 -or ($null -ne $_.fail -and $_.fail -gt 0) -or
    ($null -eq $_.pass -or $_.pass -lt 0)
})

if ($structural.Count -gt 0) {
  "STRUCTURAL_FAILURES:" | Out-File $log -Append -Encoding UTF8
  foreach ($x in $structural) { ("  " + $x) | Out-File $log -Append -Encoding UTF8 }
}

if ($missing.Count -gt 0 -or $structural.Count -gt 0 -or
    $failedGates.Count -gt 0) {
  "ACCGATES_RESULT=FAIL" | Out-File $log -Append -Encoding UTF8
  if ($missing.Count)      { Write-Host ("MISSING GATES : " + ($missing -join ", ")) }
  if ($structural.Count)   { Write-Host ("STRUCTURAL    : " + ($structural -join "; ")) }
  if ($failedGates.Count)  { Write-Host ("FAILED GATES  : " +
      (($failedGates | ForEach-Object { $_.step }) -join ", ")) }
  Write-Host "ACC GATES FAILED"
  exit 1
}

"ACCGATES_RESULT=PASS" | Out-File $log -Append -Encoding UTF8
Write-Host "ACC GATES PASSED"
exit 0
