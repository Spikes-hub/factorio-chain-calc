"""Распаковка архива игрока: дамп, иконки, геометрия — в папку его кабинета.

Архив присылает батник («отправить дамп на сервер.bat»): `python
tools/upload_to_server.py` собирает zip из `data/datasets/<дата>.json`,
`public/icons/**` и (если есть) `data/geometry/<дата>.json`, а сервер его
принимает и раскладывает по местам:

    <кабинет>/datasets/<дата>.json     — сам дамп
    <кабинет>/icons/item/<имя>.png     — иконки (в дампе на них ссылки /icons/...)
    <кабинет>/geometry/<дата>.json     — геометрия построек (если была в архиве)

Всё чужое из архива выбрасывается, а опасное (абсолютные пути, `..`, ссылки)
отбивается: файл приходит из интернета, доверять ему нельзя. Плюс потолки на
размер и число файлов — иначе одним архивом можно забить диск.
"""
from __future__ import annotations

import json
import os
import shutil
import zipfile
from pathlib import Path
from typing import Optional

from . import accounts

MAX_TOTAL_BYTES = int(os.environ.get("CHAIN_CALC_UPLOAD_MAX_BYTES", str(2 * 1024 ** 3)))
MAX_FILES = int(os.environ.get("CHAIN_CALC_UPLOAD_MAX_FILES", "100000"))
MAX_SINGLE_BYTES = int(os.environ.get("CHAIN_CALC_UPLOAD_MAX_FILE_BYTES", str(512 * 1024 ** 2)))
MAX_DATASETS = 50          # сколько дампов из одного архива принимаем
# Сколько места может занять один кабинет (дамп + иконки + геометрия + присланные архивы).
# Настоящий дамп Pyanodon с иконками — около 100 МБ, поэтому 500 МБ хватает с запасом.
USER_QUOTA_BYTES = int(os.environ.get("CHAIN_CALC_USER_QUOTA_BYTES", str(500 * 1024 ** 2)))
# Сколько свободного места должно оставаться на диске сервера после загрузки.
MIN_FREE_BYTES = int(os.environ.get("CHAIN_CALC_MIN_FREE_BYTES", str(1024 ** 3)))

ICON_SUFFIXES = {".png", ".webp"}
DATASET_SUFFIXES = {".json", ".txt"}
# Что выкидываем из пути иконки, чтобы получить путь относительно папки icons.
ICON_PREFIXES = {"public", "icons"}


class UploadError(Exception):
    """Плохой архив — отвечаем 400 с понятным текстом."""


def user_usage(user_id: int) -> int:
    """Сколько байт лежит в папке кабинета."""
    total = 0
    root = accounts.user_dir(user_id)
    if root.is_dir():
        for path in root.rglob("*"):
            try:
                if path.is_file():
                    total += path.stat().st_size
            except OSError:
                continue
    return total


def capacity_problem(user_id: Optional[int], incoming: int) -> Optional[tuple[int, str]]:
    """(код ответа, текст), если `incoming` байт принять нельзя: нет места на диске или кабинет полон."""
    try:
        free = shutil.disk_usage(accounts.DATA_DIR if accounts.DATA_DIR.exists() else Path(".")).free
    except OSError:
        free = None
    if free is not None and free - incoming < MIN_FREE_BYTES:
        return 507, "на сервере закончилось место, попробуй позже"
    if user_id is not None and USER_QUOTA_BYTES:
        used = user_usage(user_id)
        if used + incoming > USER_QUOTA_BYTES:
            return 413, (f"диск кабинета заполнен: лимит {USER_QUOTA_BYTES // 1024 ** 2} МБ, "
                         f"занято {used // 1024 ** 2} МБ")
    return None


_PNG = b"\x89PNG\r\n\x1a\n"


def looks_like_image(head: bytes, suffix: str) -> bool:
    """По первым байтам: PNG для .png, RIFF....WEBP для .webp (имя файла ничего не доказывает)."""
    if suffix == ".png":
        return head.startswith(_PNG)
    if suffix == ".webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    return False


def _safe_parts(name: str) -> list[str]:
    """Путь внутри архива → список безопасных частей (иначе UploadError).

    Отбиваем всё, чем обычно ломают распаковку: абсолютные пути, диск Windows,
    `..`, пустые и мусорные сегменты.
    """
    raw = (name or "").replace("\\", "/").strip()
    if not raw or raw.endswith("/"):
        return []
    if raw.startswith("/") or (len(raw) > 1 and raw[1] == ":"):
        raise UploadError(f"в архиве абсолютный путь: {name}")
    parts = [p for p in raw.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise UploadError(f"в архиве путь наружу папки: {name}")
    return parts


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0o170000
    return mode == 0o120000


def _common_root(names: list[list[str]]) -> int:
    """Сколько общих сегментов у всех путей — столько можно отрезать.

    Архив может быть собран «папкой внутри» (dump/icons/...). Если у всех файлов
    один и тот же первый сегмент, он лишний.
    """
    if not names:
        return 0
    first = names[0][0] if names[0] else None
    if not first:
        return 0
    return 1 if all(parts and parts[0] == first for parts in names) and all(len(parts) > 1 for parts in names) else 0


def _dataset_name(parts: list[str]) -> str:
    stem = Path(parts[-1]).stem or "dump"
    return "".join(ch for ch in stem if ch.isalnum() or ch in "-_.")[:64] or "dump"


def _is_geometry(parts: list[str]) -> bool:
    lowered = [p.lower() for p in parts]
    return "geometry" in lowered[:-1] or any("geometry" in p for p in lowered[-2:])


def unpack_zip(zip_path: Path, user_id: int, source_name: str = "") -> dict:
    """Распаковывает архив в папку кабинета и регистрирует датасеты."""
    if not zipfile.is_zipfile(zip_path):
        raise UploadError("это не zip-архив (файл повреждён или не тот формат)")
    accounts.init_db()
    accounts.ensure_user_dirs(user_id)
    datasets_dir = accounts.user_datasets_dir(user_id)
    icons_dir = accounts.user_icons_dir(user_id)
    geometry_dir = accounts.user_geometry_dir(user_id)

    skipped: list[str] = []
    written_icons = 0
    written_extra = 0
    datasets: list[dict] = []
    geometry_saved: Optional[str] = None
    total = 0
    quota_left = None
    if USER_QUOTA_BYTES and accounts.AUTH_ENABLED:
        quota_left = USER_QUOTA_BYTES - user_usage(user_id)

    with zipfile.ZipFile(zip_path) as archive:
        infos = [i for i in archive.infolist() if not i.is_dir()]
        if len(infos) > MAX_FILES:
            raise UploadError(f"в архиве слишком много файлов: {len(infos)} (предел {MAX_FILES})")
        all_parts = []
        for info in infos:
            try:
                all_parts.append(_safe_parts(info.filename))
            except UploadError:
                raise
        root = _common_root([p for p in all_parts if p])

        for info, parts in zip(infos, all_parts):
            if not parts:
                continue
            if _is_symlink(info):
                skipped.append(f"{info.filename}: ссылка, пропущена")
                continue
            if info.file_size > MAX_SINGLE_BYTES:
                skipped.append(f"{info.filename}: файл больше {MAX_SINGLE_BYTES // 1024 ** 2} МБ")
                continue
            total += info.file_size
            if quota_left is not None and total > quota_left:
                raise UploadError(
                    f"диск кабинета заполнен: лимит {USER_QUOTA_BYTES // 1024 ** 2} МБ, "
                    f"занято {(USER_QUOTA_BYTES - quota_left) // 1024 ** 2} МБ"
                )
            if total > MAX_TOTAL_BYTES:
                raise UploadError(
                    f"архив распаковывается больше чем на {MAX_TOTAL_BYTES // 1024 ** 3} ГБ — "
                    "так не бывает у настоящего дампа, проверь архив"
                )
            rel = parts[root:] if root else parts
            if not rel:
                continue
            suffix = Path(rel[-1]).suffix.lower()

            if suffix == ".json" and _is_geometry(rel):
                if geometry_saved is None:
                    target = geometry_dir / rel[-1]
                    with archive.open(info) as src, target.open("wb") as dst:
                        shutil.copyfileobj(src, dst)
                    geometry_saved = rel[-1]
                continue

            if suffix in DATASET_SUFFIXES and rel[-1].lower().endswith(".json"):
                if len(datasets) >= MAX_DATASETS:
                    skipped.append(f"{info.filename}: дампов в архиве больше {MAX_DATASETS}")
                    continue
                name = _dataset_name(rel)
                if any(d["id"] == name for d in datasets):
                    continue
                target = datasets_dir / f"{name}.json"
                with archive.open(info) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
                try:
                    data = json.loads(target.read_text(encoding="utf-8"))
                except (OSError, ValueError) as exc:
                    target.unlink(missing_ok=True)
                    skipped.append(f"{info.filename}: не разобрал как дамп ({exc})")
                    continue
                if not isinstance(data, dict) or not data.get("recipes"):
                    target.unlink(missing_ok=True)
                    skipped.append(f"{info.filename}: в файле нет рецептов — это не дамп")
                    continue
                accounts.register_dataset(user_id, name, target, data, source=source_name)
                datasets.append({
                    "id": name,
                    "recipes": len(data.get("recipes") or {}),
                    "dumpVersion": int(data.get("dump_version") or 1),
                    "knowsUnlocked": any(
                        isinstance(r, dict) and r.get("unlocked_now") is not None
                        for r in (data.get("recipes") or {}).values()
                    ),
                    "size": target.stat().st_size,
                })
                continue

            if suffix in ICON_SUFFIXES:
                icon_parts = list(rel)
                while icon_parts and icon_parts[0].lower() in ICON_PREFIXES:
                    icon_parts = icon_parts[1:]
                if not icon_parts:
                    skipped.append(f"{info.filename}: непонятный путь иконки")
                    continue
                target = icons_dir.joinpath(*icon_parts)
                try:
                    target.relative_to(icons_dir)
                except ValueError:
                    skipped.append(f"{info.filename}: путь иконки вне папки кабинета")
                    continue
                with archive.open(info) as src:
                    head = src.read(16)
                    if not looks_like_image(head, suffix):
                        skipped.append(f"{info.filename}: не картинка (PNG/WebP) — пропущено")
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with target.open("wb") as dst:
                        dst.write(head)
                        shutil.copyfileobj(src, dst)
                written_icons += 1
                continue

            # Мелочь вроде заметок — кладём рядом с дампом, чтобы не терялась.
            if suffix == ".txt" and len(rel) == 1:
                target = datasets_dir / rel[-1]
                with archive.open(info) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
                written_extra += 1
                continue

            skipped.append(f"{info.filename}: не дамп, не иконка и не геометрия — пропущено")

    if not datasets and not written_icons and not geometry_saved:
        raise UploadError(
            "в архиве не нашлось ни дампа (*.json), ни иконок (*.png). "
            "Положи дамп в корень архива, а иконки — в папку icons/ (или public/icons/)"
        )

    warnings = []
    if not datasets:
        warnings.append("в архиве не было дампа — иконки сохранил, но считать пока нечего")
    if not written_icons:
        warnings.append("в архиве не было иконок — предметы будут показаны без картинок")

    return {
        "datasets": datasets,
        "dataset": datasets[0]["id"] if datasets else None,
        "icons": written_icons,
        "geometry": geometry_saved,
        "extra": written_extra,
        "skipped": skipped[:20],
        "skippedCount": len(skipped),
        "unpackedBytes": total,
        "warnings": warnings,
    }
