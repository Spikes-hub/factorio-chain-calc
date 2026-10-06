<#
dump_data.ps1

Выгружает ГЕОМЕТРИЮ построек из игры: размеры в тайлах, collision/selection box,
точки подключения труб (входы/выходы газа и жидкости), вылет манипуляторов,
скорости лент и погрузчиков, зоны питания столбов.

Делает две вещи:
  1) запускает factorio.exe --dump-data — игра открывается на секунду, пишет
     весь data.raw в JSON и сама закрывается;
  2) превращает этот JSON (десятки МБ графики и звуков) в компактный файл
     геометрии ~1 МБ через tools\extract_geometry.py.

Про write-data: игра всегда пишет свои файлы в «write data» каталог, который
обычно %APPDATA%\Factorio (там же сохранения и настройки). Чтобы ничего там не
трогать, скрипт подсовывает игре свой config.ini, где write-data указывает во
временную папку, а read-data — на папку data самой игры.

Пример:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\dump_data.ps1 `
        -FactorioExe "C:\Program Files (x86)\Steam\steamapps\common\Factorio\bin\x64\factorio.exe"
#>
param(
    [string]$FactorioExe = "",
    [string]$ModDirectory = "$env:APPDATA\Factorio\mods",
    [string]$Out = "",
    [string]$RawOut = "",
    [int]$TimeoutSeconds = 900,
    [string]$GameVersion = ""
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

function Resolve-FactorioExe {
    param([string]$Given)
    if ($Given -and (Test-Path $Given)) { return (Resolve-Path $Given).Path }
    $candidates = @()
    if ($env:FACTORIO_DIR) { $candidates += (Join-Path $env:FACTORIO_DIR "bin\x64\factorio.exe") }
    $candidates += "${env:ProgramFiles(x86)}\Steam\steamapps\common\Factorio\bin\x64\factorio.exe"
    $candidates += "$env:ProgramFiles\Steam\steamapps\common\Factorio\bin\x64\factorio.exe"
    $candidates += "$env:ProgramFiles\Factorio\bin\x64\factorio.exe"
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return (Resolve-Path $c).Path }
    }
    throw "Не нашёл factorio.exe. Укажи путь параметром -FactorioExe."
}

$exe = Resolve-FactorioExe -Given $FactorioExe
$installRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $exe))  # ...\Factorio
$dataDir = Join-Path $installRoot "data"
if (-not (Test-Path (Join-Path $dataDir "core"))) {
    throw "Не нашёл папку data игры: $dataDir"
}

if (-not $Out) { $Out = Join-Path $repo ("data\geometry\" + (Get-Date -Format "yyyy-MM-dd") + ".json") }
if (-not $RawOut) { $RawOut = Join-Path $repo "tmp\raw\data-raw-dump.json" }

$work = Join-Path $env:TEMP "factorio-dsh"
$writeData = Join-Path $work "write-data"
$cfgDir = Join-Path $repo "tmp\factorio-portable"
$cfg = Join-Path $cfgDir "config.ini"

New-Item -ItemType Directory -Force -Path $writeData, $cfgDir, (Split-Path -Parent $RawOut), (Split-Path -Parent $Out) | Out-Null

# config.ini пишем строго ASCII (UTF-8 без BOM): игра читает его как системную
# кодировку и кириллицу в путях превращает в мусор.
$cfgLines = @(
    "[path]",
    "read-data=$dataDir",
    "write-data=$writeData"
)
[System.IO.File]::WriteAllLines($cfg, $cfgLines, (New-Object System.Text.UTF8Encoding($false)))

$dumpFile = Join-Path $writeData "script-output\data-raw-dump.json"
if (Test-Path $dumpFile) { Remove-Item $dumpFile -Force }

Write-Host "Factorio: $exe"
Write-Host "Моды:     $ModDirectory"
Write-Host "Запускаю --dump-data (окно игры откроется и закроется, это нормально)..."

# Внимание: пути содержат пробелы (путь проекта), поэтому строку аргументов
# собираем вручную с кавычками — Start-Process сам их не ставит.
$argLine = '--config "{0}" --mod-directory "{1}" --dump-data' -f $cfg, $ModDirectory
$sw = [Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $exe -ArgumentList $argLine -PassThru
if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    throw "Factorio не завершился за $TimeoutSeconds с — дамп не сделан."
}
$sw.Stop()
Write-Host ("Готово за {0:N0} с, код выхода {1}" -f $sw.Elapsed.TotalSeconds, $proc.ExitCode)

if (-not (Test-Path $dumpFile)) {
    $log = Join-Path $writeData "factorio-current.log"
    if (Test-Path $log) {
        Write-Host "--- последние строки лога игры ---"
        Get-Content $log -Tail 25
    }
    throw "Игра не создала дамп: $dumpFile"
}

# версия игры и число модов — из лога игры
$log = Join-Path $writeData "factorio-current.log"
$modNames = @()
$dupNames = @()
if (-not $GameVersion -and (Test-Path $log)) {
    $first = Get-Content $log -TotalCount 3 | Select-String -Pattern "Factorio (\d+\.\d+\.\d+)" | Select-Object -First 1
    if ($first) { $GameVersion = $first.Matches[0].Groups[1].Value }
}
if (Test-Path $log) {
    # игра пишет по строке на мод: "Loading mod <имя> <версия> (data.lua)"
    # (отдельные строки "Loading mod settings <имя>" в счёт не идут)
    $modNames = Select-String -Path $log -Pattern "Loading mod ([\w-]+) [\d.]+ \(data\.lua\)" -AllMatches |
        ForEach-Object { $_.Matches[0].Groups[1].Value } |
        Where-Object { $_ -ne "core" } | Sort-Object -Unique
    $dupNames = Select-String -Path $log -Pattern "Found duplicate mod (\S+)" -AllMatches |
        ForEach-Object { $_.Matches[0].Groups[1].Value } | Sort-Object -Unique
}

Copy-Item $dumpFile $RawOut -Force
Write-Host ("Сырой дамп: {0} ({1:N1} МБ)" -f $RawOut, ((Get-Item $RawOut).Length / 1MB))
$verLabel = if ($GameVersion) { $GameVersion } else { "?" }
Write-Host ("Модов: {0} (игра: {1}; папок-дублей: {2})" -f $modNames.Count, $verLabel, $dupNames.Count)

# python должен печатать UTF-8, иначе в консоли кириллица превращается в мусор
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$py = @("tools\extract_geometry.py", "--raw", $RawOut, "--out", $Out)
if ($GameVersion) { $py += @("--game-version", $GameVersion) }
Write-Host "Извлекаю геометрию..."
& python @py
if ($LASTEXITCODE -ne 0) { throw "extract_geometry.py завершился с кодом $LASTEXITCODE" }

Write-Host ""
Write-Host "Готово. Файл геометрии: $Out"
Write-Host "Сырой дамп оставлен в $RawOut (нужен, если захочешь пересчитать геометрию)."
