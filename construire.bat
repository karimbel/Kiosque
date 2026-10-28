@echo off
cd /d "%~dp0"
rem Construit Kiosque directement sur Windows (Rust et Node.js doivent etre installes).
rem Tout ce qui s'affiche est aussi enregistre dans build.log.
where npm >nul 2>&1
if errorlevel 1 (
  echo Node.js n'est pas installe. Telecharge la version LTS sur https://nodejs.org puis relance ce script.
  pause
  exit /b 1
)
powershell -NoProfile -Command "npm.cmd install 2>&1 | Tee-Object -FilePath build.log; npx.cmd tauri icon app-icon.png 2>&1 | Tee-Object -FilePath build.log -Append; npm.cmd run build -- --bundles nsis 2>&1 | Tee-Object -FilePath build.log -Append"
if exist src-tauri\target\release\bundle\nsis\*.exe (
  echo.
  echo Termine. Ouverture du dossier de l'installeur.
  explorer src-tauri\target\release\bundle\nsis
) else (
  echo.
  echo La construction a echoue. Le detail est dans build.log, a cote de ce script.
)
pause
