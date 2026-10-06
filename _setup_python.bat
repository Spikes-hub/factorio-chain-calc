@echo off
rem ---------------------------------------------------------------------------
rem Prepares a private Python for Chain Calc, so nothing has to be installed by hand.
rem   1. an environment from an earlier run (.venv or .python) is reused;
rem   2. otherwise a system Python 3.9+ is used to create .venv;
rem   3. otherwise the embeddable Python is downloaded from python.org into .python
rem      (needs internet once; ~10 MB) together with pip.
rem Then the packages from requirements.txt are installed (only when they changed).
rem
rem Sets PY (full path to python.exe) and puts its folder on PATH; use with "call".
rem Set CHAIN_CALC_FORCE_EMBEDDED=1 to skip the system Python (testing).
rem ASCII only on purpose: cmd reads batch files in the OEM code page.
rem ---------------------------------------------------------------------------
set "CC_ROOT=%~dp0"
set "CC_VENV=%CC_ROOT%.venv"
set "CC_EMBED=%CC_ROOT%.python"
set "CC_STAMP=%CC_ROOT%.requirements.stamp"
set "PY="
set "SYS_PY="

if exist "%CC_VENV%\Scripts\python.exe" set "PY=%CC_VENV%\Scripts\python.exe"
if not defined PY if exist "%CC_EMBED%\python.exe" set "PY=%CC_EMBED%\python.exe"
if defined PY goto :have_env

if defined CHAIN_CALC_FORCE_EMBEDDED goto :embedded

for %%C in ("py -3" python python3) do (
  if not defined SYS_PY (
    %%~C -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1 && set "SYS_PY=%%~C"
  )
)
if not defined SYS_PY goto :embedded

echo [setup] Creating a private environment with %SYS_PY% ...
%SYS_PY% -m venv "%CC_VENV%"
if exist "%CC_VENV%\Scripts\python.exe" (
  set "PY=%CC_VENV%\Scripts\python.exe"
  goto :have_env
)
echo [setup] Could not create a virtual environment, falling back to the downloaded Python.
if exist "%CC_VENV%" rmdir /s /q "%CC_VENV%" >nul 2>&1

:embedded
echo [setup] Downloading Python (one time, needs internet) ...
set "CC_PS1=%TEMP%\chaincalc_bootstrap_%RANDOM%.ps1"
> "%CC_PS1%" (
  echo $ErrorActionPreference = 'Stop'
  echo $ProgressPreference = 'SilentlyContinue'
  echo [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  echo $arch = 'amd64'
  echo if ^($env:PROCESSOR_ARCHITECTURE -eq 'ARM64'^) { $arch = 'arm64' }
  echo $ver = '3.12.8'
  echo $dest = '%CC_EMBED%'
  echo $zip = Join-Path $env:TEMP ^('python-embed-' + $ver + '.zip'^)
  echo Invoke-WebRequest -UseBasicParsing -Uri ^('https://www.python.org/ftp/python/' + $ver + '/python-' + $ver + '-embed-' + $arch + '.zip'^) -OutFile $zip
  echo if ^(Test-Path $dest^) { Remove-Item -Recurse -Force $dest }
  echo Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
  echo Remove-Item $zip -Force
  echo $pth = Get-ChildItem -Path $dest -Filter 'python*._pth' ^| Select-Object -First 1
  echo $lines = Get-Content $pth.FullName
  echo $lines = $lines -replace '^#import site', 'import site'
  echo $lines += '..\app'
  echo $lines += '..\tools'
  echo Set-Content -Path $pth.FullName -Value $lines -Encoding ASCII
  echo $pip = Join-Path $env:TEMP 'get-pip.py'
  echo Invoke-WebRequest -UseBasicParsing -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $pip
  echo ^& ^(Join-Path $dest 'python.exe'^) $pip --no-warn-script-location --disable-pip-version-check
  echo if ^($LASTEXITCODE -ne 0^) { throw 'get-pip failed' }
  echo Remove-Item $pip -Force
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%CC_PS1%"
set "CC_RC=%ERRORLEVEL%"
del "%CC_PS1%" >nul 2>&1
if not "%CC_RC%"=="0" (
  echo [setup] Could not download or set up Python. Check the internet connection, or install Python 3.9+ from https://www.python.org/downloads/ and run this file again.
  if exist "%CC_EMBED%" rmdir /s /q "%CC_EMBED%" >nul 2>&1
  exit /b 1
)
set "PY=%CC_EMBED%\python.exe"

:have_env
for %%I in ("%PY%") do set "PY_DIR=%%~dpI"
set "PATH=%PY_DIR%;%PY_DIR%Scripts;%PATH%"

rem builds that need no packages (the dump tools) ship without requirements.txt
if not exist "%CC_ROOT%requirements.txt" goto :deps_ok

if exist "%CC_STAMP%" (
  fc /b "%CC_ROOT%requirements.txt" "%CC_STAMP%" >nul 2>&1 && goto :deps_ok
)
echo [setup] Installing packages from requirements.txt (one time, needs internet) ...
"%PY%" -m pip install --disable-pip-version-check -r "%CC_ROOT%requirements.txt"
if errorlevel 1 (
  echo [setup] Package installation failed. Check the internet connection and run this file again.
  exit /b 1
)
copy /y "%CC_ROOT%requirements.txt" "%CC_STAMP%" >nul

:deps_ok
exit /b 0
