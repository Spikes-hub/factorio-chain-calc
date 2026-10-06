@echo off
rem Full dump of the game: every recipe of your mod set, no save needed, fully automatic. The game opens a
rem throw-away map for about a minute (names get translated into the language of your game) and is closed by the script.
rem Finds Factorio by itself, installs the exporter mod for the time of the dump, builds the
rem dataset with icons in data\datasets and data\geometry, removes the mod, restores mod-list.json.
rem Needs: Factorio closed, internet only on the first run (see _setup_python.bat).
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0_setup_python.bat"
if errorlevel 1 (
  pause
  exit /b 1
)
set "PYTHONUTF8=1"
"%PY%" "%~dp0tools\make_dump.py" full
echo.
pause
