@echo off
rem Dump from YOUR SAVE: the calculator then knows what is researched, and the names are in the
rem language of your game. Nothing to type in the game:
rem 1) finds Factorio, shows your saves (Enter = the newest), installs the exporter mod and loads the save;
rem 2) the mod makes the dump BY ITSELF when the save is loaded; the script waits and closes the game;
rem 3) copies the dump into data\datasets, pulls the icons, removes the mod, restores mod-list.json.
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0_setup_python.bat"
if errorlevel 1 (
  pause
  exit /b 1
)
set "PYTHONUTF8=1"
"%PY%" "%~dp0tools\make_dump.py" save %*
echo.
pause
