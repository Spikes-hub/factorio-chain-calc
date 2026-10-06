"""Приём архива от батника (дамп + иконки + геометрия, сразу распаковать) и отдача иконок."""
from __future__ import annotations

import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from chain_calc import accounts, uploads
from . import core

router = APIRouter()


@router.post("/api/upload")
async def upload_archive(request: Request, file: UploadFile = File(...),
                         code: Optional[str] = Form(None)):
    """Принимает zip с дампом и иконками, кладёт их в папку кабинета.

    Код кабинета приходит заголовком `X-User-Code` (так его шлёт батник) или
    полем формы `code` — вход в браузере для этого не нужен.
    """
    raw_code = (code or request.headers.get("x-user-code") or "").strip()
    ip = core.client_ip(request)
    if accounts.rate_limited(ip):
        raise HTTPException(429, "слишком много неудачных попыток с этого адреса")
    user = accounts.find_user_by_code(raw_code) if raw_code else None
    if user is None:
        accounts.note_failure(ip)
        raise HTTPException(401, "код кабинета не подошёл (или не передан заголовком X-User-Code)")
    accounts.clear_failures(ip)

    uid = int(user["id"])
    accounts.ensure_user_dirs(uid)
    name = Path(file.filename or "upload.zip").name.replace(" ", "_")[:80]
    tmp = accounts.user_uploads_dir(uid) / f"{time.strftime('%Y%m%d-%H%M%S')}-{name}"

    written = 0
    try:
        with tmp.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > core.UPLOAD_MAX_BYTES:
                    raise HTTPException(413, f"архив больше {core.UPLOAD_MAX_BYTES // 1024 ** 2} МБ")
                out.write(chunk)
    except HTTPException:
        tmp.unlink(missing_ok=True)
        raise
    except Exception as exc:      # noqa: BLE001 — обрыв связи и прочее
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, f"не смог принять архив: {exc}")

    if written == 0:
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, "пришёл пустой файл — архив не собрался?")
    problem = uploads.capacity_problem(uid if accounts.AUTH_ENABLED else None, 0)
    if problem:
        tmp.unlink(missing_ok=True)
        raise HTTPException(problem[0], problem[1])

    ok = False
    ctx = accounts.set_current_user(user)
    try:
        result = uploads.unpack_zip(tmp, uid, source_name=name)
        ok = True
    except uploads.UploadError as exc:
        raise HTTPException(400, str(exc))
    finally:
        accounts.reset_current_user(ctx)
        if not core.KEEP_UPLOADS:
            # also after a failure: a rejected archive must not stay on the disk (it would count
            # against the cabinet and let anyone fill the server with broken uploads)
            tmp.unlink(missing_ok=True)
        elif not ok:
            print(f"[upload] архив оставлен для разбора: {tmp}")

    accounts.touch_user(uid)
    return {
        "ok": True,
        "user": {"id": uid, "number": f"{uid:04d}"},
        "keptArchive": bool(ok and core.KEEP_UPLOADS),
        **result,
    }


@router.get("/icons/{rest:path}")
def get_icon(rest: str):
    """Иконки предметов: сначала из кабинета, потом общие.

    В дампе ссылки вида `/icons/item/iron-plate.png`; откуда брать файл, зависит от
    кабинета запроса.
    """
    parts = [p for p in (rest or "").split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        raise HTTPException(404, "нет такой иконки")
    own = accounts.current_icons_dir()
    if own is not None:
        candidate = own.joinpath(*parts)
        if candidate.is_file():
            return FileResponse(candidate)
    shared = core.SHARED_ICONS_DIR.joinpath(*parts)
    if shared.is_file():
        return FileResponse(shared)
    raise HTTPException(404, "нет такой иконки")
