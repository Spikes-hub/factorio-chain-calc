@echo off
rem Starts Chain Calc on this computer and opens it in the browser.
rem Ctrl+C would normally ask "Terminate batch job (Y/N)?": the script restarts itself once with its input taken
rem from NUL, so the question has nothing to wait for and Ctrl+C just stops the server.
if defined CHAIN_CALC_START_CHILD goto :child
set "CHAIN_CALC_START_CHILD=1"
cmd /c ""%~f0" %*" <nul
exit /b %ERRORLEVEL%

:child
rem The first run downloads what is missing (Python, packages) - nothing to install by hand.
rem Single-user mode (no sign-in): dumps and chains live in the "data" folder next to this file.
cd /d "%~dp0"
call "%~dp0_setup_python.bat"
if errorlevel 1 (
  call :hold
  exit /b 1
)

set "CHAIN_CALC_AUTH=0"
if not defined CHAIN_CALC_PORT set "CHAIN_CALC_PORT=8010"
set "PYTHONUTF8=1"

rem open the browser a few seconds after the server starts
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://127.0.0.1:%CHAIN_CALC_PORT%'"

echo Chain Calc is starting on http://127.0.0.1:%CHAIN_CALC_PORT%  (close this window or press Ctrl+C to stop)
"%PY%" -u "%~dp0app\main.py"
set "RC=%ERRORLEVEL%"
echo.
rem the window stays open only when the server stopped with an error (so the message can be read)
if not "%RC%"=="0" if not "%RC%"=="-1073741510" call :hold
exit /b %RC%

:hold
rem input is redirected from NUL, so "pause" would not wait: keep the window open another way
echo Close this window when you have read the message above.
ping -n 3600 127.0.0.1 >nul
exit /b 0
