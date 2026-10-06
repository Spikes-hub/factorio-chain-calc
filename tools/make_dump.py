#!/usr/bin/env python3
"""Game data dump for Chain Calc: finds Factorio by itself, runs the export, brings the result
into the project and pulls the icons.

Two kinds of dump (the calculator treats them differently):

  full  - every recipe of your mod set, no save needed, no clicks. The game creates a throw-away map and
          opens it once (the window shows for about a minute and is closed by the script): the exporter
          mod dumps by itself when the player is created, so the names are in the language of your game.
          The dump does not know what is researched.
  save  - from your own save: the dump knows what is researched, the stack bonus of inserters and has real
          localised names. The script lists your saves (or takes --save), loads the chosen one and closes
          the game when the dump is written. The mod dumps by itself when a save is loaded with the mod
          freshly added - no console command is needed.

Used by dump_full.bat and dump_from_save.bat (they prepare Python first):

    python tools/make_dump.py full
    python tools/make_dump.py save [--save NAME]
    python tools/make_dump.py cleanup         (puts the mods folder back after an aborted run)

With --upload (dump_full_to_server.bat / dump_from_save_to_server.bat) the finished dump, the icons
and the geometry are packed into one zip and sent to the calculator server: the script asks for the
cabinet code shown on the site at the very end; the server unpacks the archive into that cabinet
and deletes it. The server address comes from --server, CHAIN_CALC_SERVER, server.txt next to the
script folder, or is asked once and remembered in data/.server-url.txt.

Icons and building geometry depend only on the game build and the mod set, not on the map: they are
dumped (a game launch each) once and reused while the mod set stays the same (data/.assets-cache.json);
--rebuild-icons forces them. So a repeated full dump launches the game twice, a repeated save dump once.

The exporter mod is copied into the Factorio mods folder only for the time of the dump; the
original mod-list.json and any older copy of the mod are put back at the end (also on errors).

Where Factorio is looked up: FACTORIO_DIR (folder or factorio.exe), the path remembered in
data/.factorio-path.txt, Steam (registry + library folders), the Factorio uninstall entry,
the usual folders on every drive. If nothing is found the script asks for the path once.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))   # sibling modules, also in embeddable Python
import _lang  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MOD_NAME = "chain-calc-exporter"
STATE_FILE = ROOT / "data" / ".dump-state.json"
PATH_FILE = ROOT / "data" / ".factorio-path.txt"
SERVER_FILE = ROOT / "data" / ".server-url.txt"
ASSETS_FILE = ROOT / "data" / ".assets-cache.json"
SERVER_HINT = ROOT / "server.txt"
DATASETS = ROOT / "data" / "datasets"
GEOMETRY = ROOT / "data" / "geometry"
BACKUP_SUFFIX = ".chaincalc-backup"
FULL_TIMEOUT = 25 * 60       # a big mod set (Pyanodon) takes minutes to load


# ----------------------------------------------------------------------------- messages

RU = _lang.RU
say = _lang.say


class Fail(Exception):
    """A problem the user can act on: printed without a traceback."""

    def __init__(self, en: str, ru: str = "") -> None:
        super().__init__(ru if (RU and ru) else en)


# ----------------------------------------------------------------------------- finding Factorio

def _drives() -> list[str]:
    return [f"{c}:\\" for c in "CDEFGHIJKLMNOPQRSTUVWXYZ" if Path(f"{c}:\\").exists()]


def _exe_in(folder: Path) -> Path | None:
    for rel in (("bin", "x64", "factorio.exe"), ("factorio.exe",)):
        exe = folder.joinpath(*rel)
        if exe.is_file():
            return exe
    return None


def _steam_libraries() -> list[Path]:
    steam_dirs: list[Path] = []
    try:
        import winreg
        for hive, key, value in (
            (winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", "InstallPath"),
        ):
            try:
                with winreg.OpenKey(hive, key) as handle:
                    steam_dirs.append(Path(winreg.QueryValueEx(handle, value)[0]))
            except OSError:
                continue
    except ImportError:
        pass
    for drive in _drives():
        for rel in ("Program Files (x86)\\Steam", "Program Files\\Steam", "Steam", "SteamLibrary", "Games\\Steam"):
            steam_dirs.append(Path(drive) / rel)
    libraries: list[Path] = []
    for steam in steam_dirs:
        if not steam.is_dir():
            continue
        libraries.append(steam)
        vdf = steam / "steamapps" / "libraryfolders.vdf"
        try:
            text = vdf.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for match in re.finditer(r'"path"\s+"([^"]+)"', text):
            libraries.append(Path(match.group(1).replace("\\\\", "\\")))
    return libraries


def _uninstall_entries() -> list[Path]:
    found: list[Path] = []
    try:
        import winreg
    except ImportError:
        return found
    roots = (
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    )
    for hive, path in roots:
        try:
            with winreg.OpenKey(hive, path) as root_key:
                for i in range(winreg.QueryInfoKey(root_key)[0]):
                    try:
                        with winreg.OpenKey(root_key, winreg.EnumKey(root_key, i)) as app:
                            name = str(winreg.QueryValueEx(app, "DisplayName")[0])
                            if name.strip().lower().startswith("factorio"):
                                found.append(Path(str(winreg.QueryValueEx(app, "InstallLocation")[0])))
                    except OSError:
                        continue
        except OSError:
            continue
    return found


def find_factorio(override: str | None = None) -> Path:
    """Path to factorio.exe (see the module docstring for the order of the search)."""
    tried: list[Path] = []

    def check(candidate: Path | str | None) -> Path | None:
        if not candidate:
            return None
        path = Path(str(candidate).strip().strip('"'))
        tried.append(path)
        if path.is_file() and path.name.lower() == "factorio.exe":
            return path
        return _exe_in(path) if path.is_dir() else None

    for given in (override, os.environ.get("FACTORIO_DIR"), os.environ.get("FACTORIO_EXE")):
        hit = check(given)
        if hit:
            return hit
    try:
        hit = check(PATH_FILE.read_text(encoding="utf-8"))
        if hit:
            return hit
    except OSError:
        pass
    for lib in _steam_libraries():
        hit = check(lib / "steamapps" / "common" / "Factorio")
        if hit:
            return hit
    for folder in _uninstall_entries():
        hit = check(folder)
        if hit:
            return hit
    for drive in _drives():
        for rel in ("Program Files\\Factorio", "Program Files (x86)\\Factorio", "Games\\Factorio", "Factorio"):
            hit = check(Path(drive) / rel)
            if hit:
                return hit

    say("Could not find Factorio on this computer.", "Не нашёл Factorio на этом компьютере.")
    if not sys.stdin or not sys.stdin.isatty():
        raise Fail("Set the FACTORIO_DIR environment variable to the Factorio folder.",
                   "Задай переменную окружения FACTORIO_DIR — папка с Factorio.")
    say("Drag factorio.exe (or the Factorio folder) into this window and press Enter:",
        "Перетащи в это окно factorio.exe (или папку с игрой) и нажми Enter:")
    hit = check(input("> "))
    if not hit:
        raise Fail("That is not Factorio.", "Это не Factorio.")
    PATH_FILE.parent.mkdir(parents=True, exist_ok=True)
    PATH_FILE.write_text(str(hit), encoding="utf-8")
    return hit


def data_dir(exe: Path) -> Path:
    """Factorio's user folder (mods, saves, script-output): %APPDATA%\\Factorio or the install folder."""
    override = os.environ.get("FACTORIO_DATA")
    if override:
        return Path(override)
    root = exe.parent.parent.parent if exe.parent.name.lower() == "x64" else exe.parent
    cfg = root / "config-path.cfg"
    try:
        if re.search(r"use-system-read-write-data-directories\s*=\s*false", cfg.read_text(errors="replace")):
            return root
    except OSError:
        pass
    return Path(os.environ.get("APPDATA", str(Path.home()))) / "Factorio"


def factorio_running() -> bool:
    try:
        # tasklist prints in the OEM code page; only the image name matters, so read raw bytes
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq factorio.exe", "/NH"],
                             capture_output=True, timeout=30).stdout or b""
    except (OSError, subprocess.SubprocessError):
        return False
    return b"factorio.exe" in out.lower()


# ----------------------------------------------------------------------------- the mod in / out

def _read_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=1), encoding="utf-8")


def install_mod(exe: Path) -> dict:
    """Copies the exporter into the mods folder and enables it. Everything it changes is recorded."""
    src = ROOT / MOD_NAME
    if not (src / "control.lua").is_file():
        raise Fail(f"The mod folder is missing: {src}", f"Нет папки мода: {src}")
    mods = data_dir(exe) / "mods"
    mods.mkdir(parents=True, exist_ok=True)
    target = mods / MOD_NAME
    modlist = mods / "mod-list.json"
    state = {"mods": str(mods), "target": str(target), "modlist": str(modlist),
             "target_backup": "", "modlist_backup": "", "started": time.time()}

    if target.exists():
        backup = Path(str(target) + BACKUP_SUFFIX)
        if backup.exists():
            shutil.rmtree(backup, ignore_errors=True)
        target.rename(backup)
        state["target_backup"] = str(backup)
    if modlist.exists():
        backup = Path(str(modlist) + BACKUP_SUFFIX)
        shutil.copy2(modlist, backup)
        state["modlist_backup"] = str(backup)
    _write_state(state)       # written BEFORE touching anything else: cleanup works after a crash

    shutil.copytree(src, target, ignore=shutil.ignore_patterns("README*", "*.md"))
    try:
        data = json.loads(modlist.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {"mods": []}
    entries = data.setdefault("mods", [])
    for entry in entries:
        if entry.get("name") == MOD_NAME:
            entry["enabled"] = True
            break
    else:
        entries.append({"name": MOD_NAME, "enabled": True})
    modlist.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return state


def remove_mod() -> None:
    """Undoes install_mod (safe to call twice, or when nothing was installed)."""
    state = _read_state()
    if not state:
        return
    target = Path(state.get("target", ""))
    if state.get("target") and target.exists():
        shutil.rmtree(target, ignore_errors=True)
    if state.get("target_backup") and Path(state["target_backup"]).exists():
        Path(state["target_backup"]).rename(target)
    if state.get("modlist_backup") and Path(state["modlist_backup"]).exists():
        shutil.move(state["modlist_backup"], state["modlist"])
    elif state.get("modlist") and Path(state["modlist"]).exists():
        # there was no mod-list.json before: take ours away
        Path(state["modlist"]).unlink(missing_ok=True)
    STATE_FILE.unlink(missing_ok=True)


# ----------------------------------------------------------------------------- pieces of the work

def script_output(exe: Path) -> Path:
    return data_dir(exe) / "script-output"


def clear_old_dump(out_dir: Path) -> None:
    for name in ("chain-calc-dump.json", "chain-calc-dump.done"):
        (out_dir / name).unlink(missing_ok=True)


def game_env() -> dict:
    """Environment for starting the game. The Steam build, started by hand, quits at once and asks Steam
    to start it again (so the process we launched is gone and cannot be watched, and Steam may delay or
    skip the restart). With the app id given it keeps running as the very process we started."""
    return {**os.environ, "SteamAppId": "427520"}


def run_game(exe: Path, args: list[str], timeout: int, what_en: str, what_ru: str) -> int:
    say(f"Running Factorio: {what_en} ...", f"Запускаю Factorio: {what_ru} ...")
    try:
        return subprocess.run([str(exe), *args], timeout=timeout, env=game_env()).returncode
    except subprocess.TimeoutExpired as exc:
        raise Fail(f"Factorio did not finish in {timeout // 60} minutes ({what_en}).",
                   f"Factorio не уложилась в {timeout // 60} мин ({what_ru}).") from exc


def load_dump(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise Fail(f"The dump file is unreadable: {path} ({exc})", f"Файл дампа не читается: {path} ({exc})") from exc
    if not isinstance(data, dict) or not data.get("recipes"):
        raise Fail("The dump has no recipes.", "В дампе нет рецептов.")
    return data


def mods_fingerprint(exe: Path) -> str:
    """What the icons and the building geometry depend on: the game build, the enabled mods (name, and for
    zips their size and date, so an update shows) and the mod settings. NOT the map or the research state.
    Must be taken before the exporter is installed (it changes mod-list.json)."""
    exe_stat = exe.stat()
    mods = data_dir(exe) / "mods"
    parts = [f"game:{exe_stat.st_size}:{exe_stat.st_mtime_ns}"]
    try:
        listed = json.loads((mods / "mod-list.json").read_text(encoding="utf-8")).get("mods") or []
    except (OSError, ValueError):
        listed = []
    parts.append("enabled:" + ",".join(sorted(str(m.get("name")) for m in listed
                                              if m.get("enabled") and m.get("name") != MOD_NAME)))
    if mods.is_dir():
        for entry in sorted(mods.iterdir(), key=lambda e: e.name):
            if entry.name in (MOD_NAME, "mod-list.json") or entry.name.endswith(BACKUP_SUFFIX):
                continue
            try:
                stat = entry.stat()
                if entry.name == "mod-settings.dat":      # the game rewrites it on every launch: its CONTENT counts
                    parts.append("settings:" + hashlib.sha1(entry.read_bytes()).hexdigest())
                    continue
            except OSError:
                continue
            parts.append(f"{entry.name}:{stat.st_size if entry.is_file() else 0}:{stat.st_mtime_ns if entry.is_file() else 0}")
    return hashlib.sha1("\n".join(parts).encode("utf-8")).hexdigest()


def _read_assets_cache() -> dict:
    try:
        data = json.loads(ASSETS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _remember_assets(kind: str, fingerprint: str | None) -> None:
    if not fingerprint:
        return
    cache = _read_assets_cache()
    cache[kind] = fingerprint
    ASSETS_FILE.parent.mkdir(parents=True, exist_ok=True)
    ASSETS_FILE.write_text(json.dumps(cache, indent=1), encoding="utf-8")


def sprites_ready(out_dir: Path) -> bool:
    """Are the sprites of an earlier --dump-icon-sprites still in script-output?"""
    return all(any((out_dir / folder).glob("*.png")) for folder in ("item", "fluid", "recipe", "entity"))


def pull_icons(exe: Path, dump_path: Path, dataset_id: str, fingerprint: str | None = None,
               rebuild: bool = False) -> Path:
    """--dump-icon-sprites + extract_icons.py: icons into public/icons, dataset into data/datasets.

    The sprite dump (a game launch) is skipped when the mod set is the same as at the last successful
    run (fingerprint) and its sprites are still there; the dataset is always matched with the icons."""
    out_dir = script_output(exe)
    if (not rebuild and fingerprint and _read_assets_cache().get("icons") == fingerprint
            and sprites_ready(out_dir)):
        say("Icons are up to date for this mod set - skipping the icon dump (--rebuild-icons forces it).",
            "Иконки для этого набора модов уже выгружены — пропускаю (--rebuild-icons выгрузит заново).")
    else:
        run_game(exe, ["--dump-icon-sprites"], 15 * 60, "dumping icons", "выгружаю иконки")
    DATASETS.mkdir(parents=True, exist_ok=True)
    target = DATASETS / f"{dataset_id}.json"
    rc = subprocess.run([sys.executable, str(ROOT / "tools" / "extract_icons.py"),
                         "--dump", str(dump_path), "--icon-sprites", str(out_dir),
                         "--out-dump", str(target)], env={**os.environ, "PYTHONUTF8": "1"}).returncode
    if rc != 0 or not target.exists():
        raise Fail("Could not build the dataset with icons.", "Не удалось собрать дамп с иконками.")
    _remember_assets("icons", fingerprint)
    return target


def make_geometry(exe: Path, fingerprint: str | None = None, rebuild: bool = False) -> None:
    """Building sizes, pipe connections, inserter reach (for generated blueprints).

    Skipped (no game launch) when the mod set is the same as at the last successful run."""
    if (not rebuild and fingerprint and has_geometry()
            and _read_assets_cache().get("geometry") == fingerprint):
        say("Building geometry is up to date for this mod set - skipping (--rebuild-icons forces it).",
            "Геометрия построек для этого набора модов уже выгружена — пропускаю (--rebuild-icons выгрузит заново).")
        return
    say("Dumping building geometry ...", "Выгружаю геометрию построек ...")
    raw = Path(tempfile.mkdtemp(prefix="chaincalc-raw-")) / "data-raw-dump.json"   # ~80 MB, not kept
    try:
        proc = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                               str(ROOT / "tools" / "dump_data.ps1"), "-FactorioExe", str(exe),
                               "-RawOut", str(raw)],
                              env={**os.environ, "PYTHONUTF8": "1"}, capture_output=True)
    finally:
        shutil.rmtree(raw.parent, ignore_errors=True)
    rc = proc.returncode
    if rc != 0:
        print((proc.stdout or b"")[-1500:].decode("utf-8", errors="replace"))
        print((proc.stderr or b"")[-1500:].decode("utf-8", errors="replace"))
        say("[!] The geometry step failed; the calculator works, but generated blueprints will "
            "lack building sizes. Run it again later.",
            "[!] Геометрия не выгрузилась: калькулятор работает, но в чертежах не будет размеров "
            "построек. Запусти ещё раз позже.")
        return
    _remember_assets("geometry", fingerprint)


def has_geometry() -> bool:
    return GEOMETRY.is_dir() and any(GEOMETRY.glob("*.json"))


def today() -> str:
    return dt.date.today().isoformat()


def summary(dataset: Path, knows_unlocked: bool) -> None:
    say(f"\nDone. Dataset: {dataset}", f"\nГотово. Дамп: {dataset}")
    say("Refresh the Chain Calc page (F5) and pick it in the list at the top."
        + ("" if knows_unlocked else "\nThis dump does not know what is researched (all recipes are shown)."),
        "Обнови страницу Chain Calc (F5) и выбери его в списке сверху."
        + ("" if knows_unlocked else "\nЭтот дамп не знает, что изучено (показываются все рецепты)."))


# ----------------------------------------------------------------------------- sending to the server

def _read_server_file(path: Path) -> str:
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                return line
    except OSError:
        pass
    return ""


def resolve_server(given: str | None) -> str:
    server = (given or os.environ.get("CHAIN_CALC_SERVER") or _read_server_file(SERVER_HINT)
              or _read_server_file(SERVER_FILE)).strip()
    if "example.com" in server:          # the placeholder shipped in server.txt
        server = _read_server_file(SERVER_FILE)
    if server:
        return server
    if not sys.stdin or not sys.stdin.isatty():
        raise Fail("Set the server address: --server https://host (or CHAIN_CALC_SERVER).",
                   "Укажи адрес сервера: --server https://адрес (или CHAIN_CALC_SERVER).")
    say("Address of the calculator site (e.g. https://calc.example.com):",
        "Адрес сайта калькулятора (например https://calc.example.com):")
    server = input("> ").strip()
    if not server:
        raise Fail("No server address.", "Адрес сервера не указан.")
    return server


def send_to_server(dataset: Path, server_arg: str | None, code_arg: str | None) -> None:
    """Dump + icons + geometry -> one zip -> the server (asks for the cabinet code here)."""
    try:
        import upload_to_server as up
    except ImportError as exc:
        raise Fail("Uploading is not part of this build (tools/upload_to_server.py is missing).",
                   "Отправка на сервер не входит в эту сборку (нет tools/upload_to_server.py).") from exc
    try:
        server = up.prepare_server(resolve_server(server_arg))
        up.check_server(server)
    except SystemExit as exc:
        raise Fail(str(exc.code)) from exc
    if not SERVER_FILE.exists() or _read_server_file(SERVER_FILE) != server:
        SERVER_FILE.parent.mkdir(parents=True, exist_ok=True)
        SERVER_FILE.write_text(server + "\n", encoding="utf-8")

    geometry = up.newest(GEOMETRY, "*.json")
    zip_path = ROOT / "tmp" / f"upload-{dataset.stem}.zip"
    say("\nPacking the archive (dump, icons, geometry) ...", "\nУпаковываю архив (дамп, иконки, геометрия) ...")
    try:
        up.build_zip(zip_path, dataset, ROOT / "public" / "icons", geometry)
    except SystemExit as exc:
        raise Fail(str(exc.code)) from exc

    try:
        for attempt in range(1, 4):
            code = (code_arg or os.environ.get("CHAIN_CALC_CODE") or "").strip()
            if not code:
                if not sys.stdin or not sys.stdin.isatty():
                    raise Fail("Pass the cabinet code with --code (or CHAIN_CALC_CODE).",
                               "Передай код кабинета через --code (или CHAIN_CALC_CODE).")
                say("\nCabinet code (the one the site gave you when you created your cabinet), then Enter:",
                    "\nКод кабинета (тот, что сайт выдал при создании кабинета), затем Enter:")
                code = input("> ").strip()
            try:
                accepted = up.verify_code(server, code)
            except SystemExit as exc:
                raise Fail(str(exc.code)) from exc
            if not accepted:
                if attempt < 3 and sys.stdin and sys.stdin.isatty():
                    say("The code was not accepted. Try again.", "Код не подошёл. Попробуй ещё раз.")
                    code_arg = None
                    os.environ.pop("CHAIN_CALC_CODE", None)
                    continue
                raise Fail("The server did not accept the cabinet code.", "Сервер не принял код кабинета.")
            try:
                result = up.upload(server, code, zip_path)
            except SystemExit as exc:
                raise Fail(str(exc.code)) from exc
            up.report(result)
            say("The server has unpacked the archive into your cabinet and deleted it.\n"
                "Open the site and refresh the page (Ctrl+F5) - the dump is in the list.",
                "Сервер распаковал архив в твой кабинет и удалил его.\n"
                "Открой сайт и обнови страницу (Ctrl+F5) — дамп в списке.")
            return
    finally:
        zip_path.unlink(missing_ok=True)


# ----------------------------------------------------------------------------- the game does the dump itself

def list_saves(exe: Path) -> list[Path]:
    """Saves of the player, the newest first."""
    folder = data_dir(exe) / "saves"
    files = [p for p in folder.glob("*.zip") if p.is_file()] if folder.is_dir() else []
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)


def choose_save(exe: Path, given: str | None) -> Path | None:
    """The save to load: --save NAME/PATH, else a numbered choice (Enter = the newest).
    None means "the player will pick it in the game menu"."""
    saves = list_saves(exe)
    if given:
        path = Path(given)
        if not path.is_file():
            name = given if given.lower().endswith(".zip") else given + ".zip"
            path = data_dir(exe) / "saves" / name
        if not path.is_file():
            raise Fail(f"Save not found: {given}", f"Сохранение не найдено: {given}")
        return path
    if not saves:
        say("No saves found - pick one in the game menu.", "Сохранений не нашёл — выбери в меню игры.")
        return None
    if not sys.stdin or not sys.stdin.isatty():
        return saves[0]
    say("\nWhich save should the dump be made from?", "\nИз какого сохранения делать дамп?")
    for number, path in enumerate(saves[:9], 1):
        when = dt.datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
        print(f"  {number}) {path.stem}   ({when})")
    say("  0) none of them - I will pick it myself in the game menu",
        "  0) ни одно — выберу сам в меню игры")
    say("Number (Enter = 1, the newest):", "Номер (Enter = 1, самое свежее):")
    answer = input("> ").strip()
    if answer == "0":
        return None
    try:
        index = int(answer) if answer else 1
        return saves[:9][index - 1]
    except (ValueError, IndexError):
        raise Fail("There is no such number.", "Такого номера нет.")


def close_game() -> None:
    """Closes the game this script started (nothing else runs: that was checked before the start)."""
    subprocess.run(["taskkill", "/IM", "factorio.exe"], capture_output=True)       # politely first
    for _ in range(12):
        if not factorio_running():
            return
        time.sleep(1)
    subprocess.run(["taskkill", "/IM", "factorio.exe", "/F"], capture_output=True)
    time.sleep(3)


def start_game(exe: Path, save: Path | None) -> None:
    args = [str(exe)] + (["--load-game", str(save)] if save else [])
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen(args, creationflags=flags, close_fds=True, env=game_env())


def wait_for_dump(out_dir: Path, hint_after: int = 240, timeout: int = FULL_TIMEOUT) -> Path:
    """Waits until the mod has written the dump. The mod does it BY ITSELF: when a save is loaded with the
    mod freshly added (on_init) and when a player is created in a new map (on_player_created) - with
    real localised names, because a player exists then. No console command is needed."""
    marker = out_dir / "chain-calc-dump.done"
    dump = out_dir / "chain-calc-dump.json"
    started = time.time()
    seen = False
    gone_since = None
    hinted = False
    while time.time() - started < timeout:
        if marker.exists() and dump.exists():
            time.sleep(4)                     # let the file be closed and the game settle
            return dump
        running = factorio_running()          # watch by name: Steam may restart the game as another process
        seen = seen or running
        if seen and not running:
            gone_since = gone_since or time.time()
            if time.time() - gone_since > 20:
                raise Fail("The game was closed before the dump was written. Run the script again and wait "
                           "until it says that the dump is ready.",
                           "Игру закрыли до того, как дамп записался. Запусти скрипт ещё раз и дождись, "
                           "пока он напишет, что дамп готов.")
        else:
            gone_since = None
        if not hinted and time.time() - started > hint_after:
            hinted = True
            say("Still waiting. The mod dumps by itself after the save is loaded; if the game is already "
                "in the save and nothing happens, open the console (~) and run /dump-factorio-data.",
                "Всё ещё жду. Мод делает дамп сам, когда сохранение загрузилось; если игра уже в сохранении, "
                "а дампа нет — открой консоль (~) и выполни /dump-factorio-data.")
        time.sleep(2)
    raise Fail("The dump did not appear in time.", "Дамп не появился вовремя.")


# ----------------------------------------------------------------------------- the commands

def _preflight(args) -> tuple[Path, Path, str]:
    exe = find_factorio(args.factorio)
    say(f"Factorio: {exe}", f"Factorio: {exe}")
    if factorio_running():
        raise Fail("Close Factorio first, then run this again.", "Закрой Factorio и запусти ещё раз.")
    out_dir = script_output(exe)
    out_dir.mkdir(parents=True, exist_ok=True)
    clear_old_dump(out_dir)
    remove_mod()                              # leftovers of an aborted run, if any
    return exe, out_dir, mods_fingerprint(exe)


def cmd_full(args) -> int:
    exe, out_dir, fingerprint = _preflight(args)
    tmp = Path(tempfile.mkdtemp(prefix="chaincalc-map-"))
    names_ok = True
    try:
        install_mod(exe)
        new_map = tmp / "chain-calc-full-dump.zip"
        run_game(exe, ["--create", str(new_map)], FULL_TIMEOUT,
                 "creating a throw-away map (a big mod set takes a few minutes)",
                 "создаю одноразовую карту (большой набор модов грузится несколько минут)")
        dump = out_dir / "chain-calc-dump.json"
        for _ in range(30):                   # the file may land a moment after the game exits
            if (out_dir / "chain-calc-dump.done").exists() and dump.exists():
                break
            time.sleep(1)
        if not dump.exists():
            raise Fail("The game did not write the dump. Check that your mods load (start Factorio "
                       "normally once) and that the mod folder chain-calc-exporter is intact.",
                       "Игра не записала дамп. Проверь, что моды загружаются (запусти Factorio как обычно) "
                       "и что папка мода chain-calc-exporter цела.")
        # The dump of map creation has no names: nobody is in the map yet, so nothing can be translated.
        fallback = tmp / "no-names.json"
        shutil.copy2(dump, fallback)
        clear_old_dump(out_dir)

        # Open the new map: the player is created -> the mod dumps again, now with names in the language
        # of the game. The window is visible for about a minute; the script closes it by itself.
        say("Opening the new map so that the names are translated into the language of your game "
            "(the game window appears for a minute and closes by itself) ...",
            "Открываю новую карту, чтобы названия перевелись на язык твоей игры "
            "(окно игры появится на минуту и закроется само) ...")
        start_game(exe, new_map)
        try:
            dump = wait_for_dump(out_dir)
        except Fail as exc:
            print(f"[!] {exc}", flush=True)
            say("[!] Falling back to the dump without names (they will show as internal ids).",
                "[!] Беру дамп без названий (они будут показаны внутренними id).")
            dump, names_ok = fallback, False
        finally:
            close_game()

        data = load_dump(dump)
        # A throw-away map has no research state: make sure the calculator sees a "full" dump.
        for recipe in data["recipes"].values():
            if isinstance(recipe, dict):
                recipe.pop("unlocked_now", None)
        named = sum(1 for item in (data.get("items") or {}).values()
                    if isinstance(item, dict) and item.get("display_name") and item["display_name"] != item.get("name"))
        work = tmp / "chain-calc-dump.json"
        work.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        say(f"Dump: {len(data['recipes'])} recipes, {len(data.get('items') or {})} items, names: {named}.",
            f"Дамп: {len(data['recipes'])} рецептов, {len(data.get('items') or {})} предметов, названий: {named}.")
        target = pull_icons(exe, work, f"{today()}-full", fingerprint, args.rebuild_icons)
    finally:
        if factorio_running():
            close_game()
        remove_mod()
        shutil.rmtree(tmp, ignore_errors=True)
    make_geometry(exe, fingerprint, args.rebuild_icons)
    summary(target, knows_unlocked=False)
    if args.upload:
        send_to_server(target, args.server, args.code)
    return 0


def cmd_save(args) -> int:
    exe, out_dir, fingerprint = _preflight(args)
    save = choose_save(exe, args.save)
    try:
        install_mod(exe)
        if save:
            say(f"Loading the save: {save.stem}. A big mod set takes a minute or two. You do not have to do "
                "anything: the mod makes the dump by itself and this script closes the game.",
                f"Загружаю сохранение: {save.stem}. Большой набор модов грузится минуту-две. Ничего делать не "
                "нужно: мод сам сделает дамп, а скрипт сам закроет игру.")
        else:
            say("Starting Factorio. Load YOUR SAVE in the game: the mod makes the dump by itself, "
                "and this script closes the game afterwards.",
                "Запускаю Factorio. Загрузи СВОЁ СОХРАНЕНИЕ: мод сам сделает дамп, а скрипт потом сам закроет игру.")
        start_game(exe, save)
        try:
            dump = wait_for_dump(out_dir)
            say("The dump is written - closing the game ...", "Дамп записан — закрываю игру ...")
        finally:
            close_game()
        data = load_dump(dump)
        recipes = [r for r in data["recipes"].values() if isinstance(r, dict)]
        known = sum(1 for r in recipes if r.get("unlocked_now") is not None)
        researched = sum(1 for r in recipes if r.get("unlocked_now"))
        if not known:
            say("[!] This dump does not know what is researched. It will work as a full dump.",
                "[!] В этом дампе нет данных об изучении. Он будет работать как полный.")
        say(f"Dump: {len(recipes)} recipes, researched: {researched}.",
            f"Дамп: {len(recipes)} рецептов, изучено: {researched}.")
        keep = Path(tempfile.mkdtemp(prefix="chaincalc-dump-")) / "chain-calc-dump.json"
        shutil.copy2(dump, keep)
        try:
            target = pull_icons(exe, keep, f"{today()}-save", fingerprint, args.rebuild_icons)
        finally:
            shutil.rmtree(keep.parent, ignore_errors=True)
    finally:
        if factorio_running():
            close_game()
        remove_mod()
    make_geometry(exe, fingerprint, args.rebuild_icons)
    summary(target, knows_unlocked=bool(known))
    if args.upload:
        send_to_server(target, args.server, args.code)
    return 0


def cmd_cleanup(args) -> int:
    remove_mod()
    say("The mods folder is back to how it was.", "Папка модов возвращена как была.")
    return 0


def main(argv: list[str] | None = None) -> int:
    _lang.utf8_console()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--factorio", help="path to factorio.exe or the Factorio folder (otherwise found automatically)")
    ap.add_argument("--upload", action="store_true",
                    help="full / save: send the result to the calculator server (asks for the cabinet code)")
    ap.add_argument("--server", dest="server", help="server address for --upload (https://host)")
    ap.add_argument("--code", dest="code", help="cabinet code for --upload (otherwise asked at the end)")
    ap.add_argument("--rebuild-icons", action="store_true",
                    help="full / save: dump the icons and the geometry again even if the mod set did not change")
    ap.add_argument("--save", help="save: the save to load (a name from the saves folder or a path); "
                                   "otherwise a numbered list is shown")
    ap.add_argument("command", choices=["full", "save", "cleanup", "find"])
    args = ap.parse_args(argv)
    try:
        if args.command == "find":
            exe = find_factorio(args.factorio)
            print(exe)
            print(data_dir(exe))
            return 0
        return {"full": cmd_full, "save": cmd_save, "cleanup": cmd_cleanup}[args.command](args)
    except Fail as exc:
        print(f"\n[!] {exc}", flush=True)
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted.", flush=True)
        if args.command in ("full", "save"):
            remove_mod()
        return 1


if __name__ == "__main__":
    sys.exit(main())
