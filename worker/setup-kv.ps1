# Partie 2 — Cloudflare KV + secrets Worker (Watch 2gether CPU offload).
#
# À lancer DEPUIS une machine avec Node + wrangler installés, dans le dossier
# worker/ :  cd worker ; ./setup-kv.ps1
#
# Pré-requis :
#   - npm i -g wrangler   (ou npx wrangler)
#   - wrangler login      (auth Cloudflare une fois)
#
# Ce script :
#   1. crée le namespace KV "W2G_CACHE" (idempotent — réutilise s'il existe),
#   2. injecte son id dans wrangler.toml,
#   3. te demande les secrets Turso et les pose,
#   4. déploie le Worker.
#
# Aucune valeur secrète n'est écrite dans un fichier — les secrets vont
# directement dans Cloudflare via "wrangler secret put".

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Invoke-Wrangler {
    param([string[]]$Args)
    # Préfère un wrangler global, sinon retombe sur npx.
    if (Get-Command wrangler -ErrorAction SilentlyContinue) {
        & wrangler @Args
    } else {
        & npx wrangler @Args
    }
}

Write-Host "==> 1/4  Création du namespace KV W2G_CACHE" -ForegroundColor Cyan
# La sortie contient une ligne du type :
#   id = "0123456789abcdef0123456789abcdef"
$createOutput = Invoke-Wrangler @("kv", "namespace", "create", "W2G_CACHE") 2>&1 | Out-String
Write-Host $createOutput

$idMatch = [regex]::Match($createOutput, 'id\s*=\s*"([0-9a-fA-F]{32})"')
if (-not $idMatch.Success) {
    Write-Warning "Impossible d'extraire l'id automatiquement (le namespace existe peut-être déjà)."
    Write-Host "Liste des namespaces existants :" -ForegroundColor Yellow
    Invoke-Wrangler @("kv", "namespace", "list")
    $kvId = Read-Host "Colle l'id du namespace W2G_CACHE"
} else {
    $kvId = $idMatch.Groups[1].Value
    Write-Host "    id récupéré : $kvId" -ForegroundColor Green
}

Write-Host "==> 2/4  Injection de l'id dans wrangler.toml" -ForegroundColor Cyan
$tomlPath = Join-Path $PSScriptRoot "wrangler.toml"
$toml = Get-Content $tomlPath -Raw
$toml = $toml -replace 'id\s*=\s*"REPLACE_WITH_KV_NAMESPACE_ID"', ('id = "{0}"' -f $kvId)
# Si déjà remplacé lors d'un run précédent, remplace l'id existant sous le binding W2G_CACHE.
$toml = $toml -replace '(binding = "W2G_CACHE"\s*\r?\n\s*id\s*=\s*)"[0-9a-fA-F]{32}"', ('$1"{0}"' -f $kvId)
Set-Content -Path $tomlPath -Value $toml -Encoding utf8
Write-Host "    wrangler.toml mis à jour." -ForegroundColor Green

Write-Host "==> 3/4  Secrets Turso (analytics /w/track)" -ForegroundColor Cyan
Write-Host "    Réutilise les MÊMES valeurs que ton .env Vercel."
Write-Host "    TURSO_ADMIN_URL ressemble à : libsql://<ta-db>.turso.io"
Invoke-Wrangler @("secret", "put", "TURSO_ADMIN_URL")
Invoke-Wrangler @("secret", "put", "TURSO_ADMIN_TOKEN")

Write-Host "==> 4/4  Déploiement du Worker" -ForegroundColor Cyan
Invoke-Wrangler @("deploy")

Write-Host ""
Write-Host "Terminé. Note l'id KV ci-dessous pour les variables Vercel (partie 3) :" -ForegroundColor Green
Write-Host "    CF_KV_NAMESPACE_ID = $kvId"
Write-Host "    (CF_ACCOUNT_ID = visible dans le dashboard Cloudflare ; CF_KV_API_TOKEN = à générer, voir DEPLOY_CPU_OFFLOAD.md partie 3)"
