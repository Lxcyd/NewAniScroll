# Superviseur du lot catalogue OP/ED : tient le lot en vie sans Claude.
#
#   powershell -ExecutionPolicy Bypass -File lot.ps1 [-Limit 20] [-RetryErrors]
#
# Lance lot.py, le relance s'il tombe ou se fige, et s'arrete quand il n'y a
# plus rien a relancer :
#   code 0  fini                    -> fin
#   code 2  arret demande (.stop)   -> fin
#   code 3  pause sur sentinelle    -> fin (regarder out/catalogue.status.txt)
#   code 4  un lot tourne deja      -> fin
#   code 5  lecteur interdit par lib/lecteurs.json -> fin (lire .run.out)
#   autre   plantage                -> relance, attente croissante
# 5 relances d'affilee sans un seul episode de plus : arret, pour ne pas
# marteler un lecteur ou un disque en panne.
# Fige : battement de coeur vieux de 10 min, ou aucun episode depuis 60 min
# alors que le lot se dit « en_cours » -> le processus est tue et relance.
#
# Arreter proprement : creer le fichier out\catalogue.stop (le lot finit ses
# episodes en cours). Reprendre : relancer ce script, il efface le .stop.
param(
  [int]$Limit = 0,
  [switch]$RetryErrors,
  [string]$List = "out/catalogue.json",
  [string]$Out = "out/catalogue",
  [int]$Workers = 3
)
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
$log = "$Out.log"
$statusFile = "$Out.status.json"
Remove-Item "$Out.stop" -ErrorAction SilentlyContinue

function Say($m) {
  $line = "$(Get-Date -Format s) [superviseur] $m"
  Add-Content -Path $log -Value $line -Encoding utf8
  Write-Host $line
}
function Done-Count {
  try { return [int]((Get-Content $statusFile -Raw -Encoding utf8 | ConvertFrom-Json).episodes_faits) } catch { return -1 }
}

$waits = @(30, 60, 120, 300, 600)
$idle = 0
while ($true) {
  $before = Done-Count
  $argList = @("-u", "lot.py", "--anime-list", $List, "--out", $Out, "--workers", $Workers)
  if ($Limit -gt 0) { $argList += @("--limit", $Limit) }
  if ($RetryErrors) { $argList += "--retry-errors" }
  foreach ($f in @("$Out.run.out", "$Out.run.err")) {
    if (Test-Path $f) { Move-Item $f ($f -replace '\.run\.', '.prev.') -Force }
  }
  Say "lancement : python $($argList -join ' ')"
  $p = Start-Process -FilePath "python" -ArgumentList $argList -NoNewWindow -PassThru `
    -RedirectStandardOutput "$Out.run.out" -RedirectStandardError "$Out.run.err"
  $null = $p.Handle   # sans cela PowerShell 5.1 perd le code de sortie (constate le 03/10/2026)
  $killed = $false
  while (-not $p.HasExited) {
    Start-Sleep -Seconds 60
    try {
      $s = Get-Content $statusFile -Raw -Encoding utf8 | ConvertFrom-Json
      if ($s.pid -eq $p.Id) {
        $beat = ((Get-Date) - [datetime]$s.battement).TotalMinutes
        $prog = if ($s.dernier_progres) { ((Get-Date) - [datetime]$s.dernier_progres).TotalMinutes } else { ((Get-Date) - [datetime]$s.demarre).TotalMinutes }
        if ($beat -gt 10 -or ($s.etat -eq "en_cours" -and $prog -gt 60)) {
          Say "fige (battement $([int]$beat) min, dernier episode $([int]$prog) min) : processus $($p.Id) tue"
          Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
          $killed = $true
        }
      }
    } catch {}
  }
  $p.WaitForExit()
  $code = $p.ExitCode
  # lot.py tient lui-meme $log ; la sortie brute du lancement (messages des
  # lecteurs, traces) reste dans .run.out / .run.err, l'avant-derniere en .prev.
  if ($killed) { $code = 99 }
  Say "sortie code $code"
  if ($code -in 0, 2, 3, 4, 5) { break }   # 5 : lecteur interdit par lib/lecteurs.json
  $after = Done-Count
  if ($after -gt $before) { $idle = 0 } else { $idle++ }
  if ($idle -ge 5) { Say "5 relances sans progres : arret. Voir $log"; break }
  $w = $waits[[Math]::Min($idle, $waits.Count - 1)]
  Say "relance dans $w s"
  Start-Sleep -Seconds $w
}
