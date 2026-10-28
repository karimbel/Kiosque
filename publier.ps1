# Envoie tout sur GitHub en un clic. Double-cliquer sur publier.cmd.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Trouver git (parfois absent du PATH de PowerShell)
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    $pistes = @(
        "$env:ProgramFiles\Git\cmd",
        "${env:ProgramFiles(x86)}\Git\cmd",
        "$env:LocalAppData\Programs\Git\cmd",
        "$env:LocalAppData\GitHubDesktop\app-*\resources\app\git\cmd"
    )
    foreach ($p in $pistes) {
        $trouve = Get-Item $p -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($trouve) { $env:Path = "$($trouve.FullName);$env:Path"; break }
    }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Host "`nGit n'est pas installé sur ce PC, ou pas trouvable." -ForegroundColor Red
        Write-Host "Télécharge-le ici : https://git-scm.com/download/win" -ForegroundColor Yellow
        exit 1
    }
}

function Verifier($txt) { if ($LASTEXITCODE -ne 0) { Write-Host "`nÉCHEC : $txt." -ForegroundColor Red; exit 1 } }

Write-Host "`n[1/3] Fichiers modifiés" -ForegroundColor Cyan
git add -A
git status --short
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
    Write-Host "`nRien de nouveau à envoyer : tout est déjà sur GitHub." -ForegroundColor Yellow
    exit 0
}

Write-Host "`n[2/3] Enregistrement" -ForegroundColor Cyan
$msg = "Mise à jour " + (Get-Date -Format 'yyyy-MM-dd HH:mm')
git commit -m $msg
Verifier "l'enregistrement a échoué"

Write-Host "`n[3/3] Envoi sur GitHub" -ForegroundColor Cyan
git push
Verifier "l'envoi a échoué (copie le message ci-dessus et envoie-le à Claude)"

Write-Host "`nTerminé : tout est sur GitHub." -ForegroundColor Green
Write-Host "Pour construire l'installeur et la version portable : GitHub > Actions > Construire Kiosque > Run workflow." -ForegroundColor Gray
