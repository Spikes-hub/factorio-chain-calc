@echo off
rem Starts Chain Calc on this computer and opens it in the browser.
rem The first run downloads what is missing (Python, packages) - nothing to install by hand.
rem Single-user mode (no sign-in): dumps and chains live in the "data" folder next to this file.
cd /d "%~dp0"
call "%~dp0_setup_python.bat"
if errorlevel 1 (
  pause
  exit /b 1
)

set "CHAIN_CALC_AUTH=0"
if not defined CHAIN_CALC_PORT set "CHAIN_CALC_PORT=8010"
set "PYTHONUTF8=1"

rem open the browser a few seconds after the server starts
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://127.0.0.1:%CHAIN_CALC_PORT%'"

echo Chain Calc is starting on http://127.0.0.1:%CHAIN_CALC_PORT%  (close this window or press Ctrl+C to stop)
"%PY%" -u "%~dp0app\main.py"
echo.
pause
