"""Дампы игры (у каждого кабинета свои): список, загрузка, выдача, удаление.

Выдача дампа — самое тяжёлое место сайта: файл 9 МБ. Поэтому готовый ответ (JSON и его gzip)
держится в памяти, пока не изменился файл дампа или файл геометрии, а браузер получает ETag и на
повторной загрузке — `304` без тела. Без этого каждый заход стоил ~1 с и 9 МБ по сети.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import threading
from collections import OrderedDict
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, Response, UploadFile

from chain_calc import accounts, storage
from . import core

router = APIRouter()

_CACHE_LIMIT = 3            # ответов в памяти (каждый ~10 МБ: JSON + gzip)
_cache: "OrderedDict[str, dict]" = OrderedDict()
_cache_lock = threading.Lock()


def _legacy_dataset_list() -> List[dict]:
    """Список датасетов из общей папки — только для режима без кабинетов."""
    out = []
    directory = storage.datasets_dir(None)
    for path in sorted(directory.glob("*.json")):
        stat = path.stat()
        out.append({"id": path.stem, "recipes": None, "dumpVersion": None,
                    "knowsUnlocked": None, "size": stat.st_size,
                    "uploadedAt": int(stat.st_mtime * 1000), "source": "общая папка"})
    return sorted(out, key=lambda item: item["uploadedAt"], reverse=True)


@router.post("/api/datasets")
async def upload_dataset(file: UploadFile = File(...), id: Optional[str] = Form(None)):
    uid = core.scope_user_id()
    try:
        raw = await file.read()
        data = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Плохой датасет: {e}")
    if not isinstance(data, dict) or not data.get("recipes"):
        raise HTTPException(400, "в файле нет рецептов — это не дамп")
    dataset_id = id or (Path(file.filename or "").stem or core.new_id())
    dataset_id = "".join(ch for ch in dataset_id if ch.isalnum() or ch in "-_.")[:64] or core.new_id()
    storage.save_dataset(dataset_id, data, user_id=uid)
    return {"id": dataset_id, "recipes": len(data.get("recipes") or {})}


@router.get("/api/datasets")
def get_datasets():
    uid = core.scope_user_id()
    if uid is None:
        return _legacy_dataset_list()
    return accounts.list_datasets(uid)


def _with_geometry_traits(data: dict) -> dict:
    """Дополняет постройки датасета тем, что знает только файл геометрии.

    Датасет — выгрузка рецептов и предметов, прототипов построек в нём нет (или
    они неполные). А сайту нужно, например, знать, что экстрактор грунта, бур и
    литейный аппарат кладут продукт на ленту САМИ (vector_to_place_result):
    манипулятор на выход им не нужен, и советовать его нельзя.

    Правка идёт в загруженную копию: файл датасета не переписывается.
    """
    machines = data.get("entities")
    if not isinstance(machines, dict):
        return data
    try:
        import blueprint as bp
    except ImportError:  # pragma: no cover — на нормальной установке не бывает
        return data
    records = bp.entity_records()
    for name, rec in machines.items():
        if not isinstance(rec, dict) or "drops_to_belt" in rec:
            continue
        geometry_rec = records.get(name) or {}
        if geometry_rec.get("drops_to_belt"):
            rec["drops_to_belt"] = list(geometry_rec["drops_to_belt"])
    return data


def _stamp(path: Path) -> str:
    """Отпечаток того, от чего зависит ответ: файл дампа и файл геометрии (его mtime и размер)."""
    stat = path.stat()
    parts = [str(path), str(stat.st_mtime_ns), str(stat.st_size)]
    try:
        import blueprint as bp
        geometry = bp.geometry_path()
        if geometry:
            gstat = geometry.stat()
            parts += [str(geometry), str(gstat.st_mtime_ns), str(gstat.st_size)]
    except Exception:  # noqa: BLE001 — геометрия необязательна
        pass
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:20]


def _payload(path: Path, dataset_id: str, uid: Optional[int], stamp: str) -> Optional[dict]:
    with _cache_lock:
        hit = _cache.get(str(path))
        if hit and hit["stamp"] == stamp:
            _cache.move_to_end(str(path))
            return hit
    data = storage.load_dataset(dataset_id, user_id=uid)
    if data is None:
        return None
    data = _with_geometry_traits(data)
    # json.dumps вместо jsonable_encoder + JSONResponse: тот же результат, но в 7 раз быстрее
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    entry = {"stamp": stamp, "raw": raw, "gz": gzip.compress(raw, compresslevel=5, mtime=0)}
    with _cache_lock:
        _cache[str(path)] = entry
        _cache.move_to_end(str(path))
        while len(_cache) > _CACHE_LIMIT:
            _cache.popitem(last=False)
    return entry


@router.get("/api/datasets/{dataset_id}")
def get_dataset(dataset_id: str, request: Request):
    uid = core.scope_user_id()
    path = storage.dataset_path(dataset_id, uid)
    if not path.exists():
        raise HTTPException(404, "нет такого датасета в этом кабинете")
    stamp = _stamp(path)
    gzip_ok = "gzip" in (request.headers.get("accept-encoding") or "").lower()
    etag = f'"{stamp}{"-gz" if gzip_ok else ""}"'
    headers = {"ETag": etag, "Cache-Control": "private, no-cache", "Vary": "Accept-Encoding"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    entry = _payload(path, dataset_id, uid, stamp)
    if entry is None:
        raise HTTPException(404, "нет такого датасета в этом кабинете")
    if gzip_ok:
        headers["Content-Encoding"] = "gzip"
    return Response(content=entry["gz"] if gzip_ok else entry["raw"],
                    media_type="application/json", headers=headers)


@router.delete("/api/datasets/{dataset_id}")
def remove_dataset(dataset_id: str):
    uid = core.scope_user_id()
    storage.delete_dataset(dataset_id, user_id=uid)
    return {"ok": True}
