"""Кабинеты: код вместо регистрации, сессия на неделю."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from chain_calc import accounts, storage
from . import core

router = APIRouter()


class CodeRequest(BaseModel):
    code: str = ""
    note: Optional[str] = None


@router.post("/api/auth/new")
def auth_new(request: Request, response: Response, req: Optional[CodeRequest] = None):
    """Создаёт кабинет: генерирует длинный код, показывает его ОДИН раз."""
    if accounts.AUTH_ENABLED:
        ip = core.client_ip(request)
        blocked = accounts.signup_blocked(ip)
        if blocked == "limit":
            raise HTTPException(503, "новые кабинеты сейчас не создаются: достигнут предел числа кабинетов")
        if blocked == "rate":
            raise HTTPException(429, "слишком много новых кабинетов с этого адреса — попробуй завтра")
        accounts.note_signup(ip)
    user, code = accounts.create_user(note=(req.note if req else None) or "")
    moved = None
    if accounts.count_users() == 1 and storage.legacy_data_exists():
        # Первый кабинет забирает то, что уже лежало в общих папках: у себя на
        # компьютере игрок не должен потерять свои цепочки и дампы.
        moved = storage.migrate_legacy_into(user["id"])
    token = accounts.create_session(user["id"], request.headers.get("user-agent", ""))
    core.set_session_cookie(response, token)
    accounts.ensure_user_dirs(user["id"])
    return {
        "user": user,
        "code": accounts.format_code(code),
        "migrated": moved,
        "sessionDays": accounts.session_days(),
        "codeMask": user["codeMask"],
    }


@router.post("/api/auth/login")
def auth_login(request: Request, response: Response, req: CodeRequest):
    ip = core.client_ip(request)
    if accounts.rate_limited(ip):
        raise HTTPException(429, "слишком много попыток входа с этого адреса — подожди минут десять")
    user = accounts.find_user_by_code(req.code)
    if user is None:
        accounts.note_failure(ip)
        hint = (f" Если в кабинет не заходили {accounts.INACTIVE_DAYS:g} дней, он мог быть удалён."
                if accounts.INACTIVE_DAYS else "")
        raise HTTPException(401, "код не подошёл: проверь, что он скопирован целиком." + hint)
    accounts.clear_failures(ip)
    token = accounts.create_session(user["id"], request.headers.get("user-agent", ""))
    core.set_session_cookie(response, token)
    return {"user": user, "sessionDays": accounts.session_days()}


@router.post("/api/auth/logout")
def auth_logout(request: Request, response: Response):
    accounts.delete_session(request.cookies.get(core.SESSION_COOKIE) or "")
    response.delete_cookie(core.SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/api/auth/me")
def auth_me():
    """Кто в кабинете. Страница спрашивает это первой и решает, что показывать."""
    user = accounts.current_user()
    return {
        "authRequired": accounts.AUTH_ENABLED,
        "user": user,
        "sessionDays": accounts.session_days(),
        "uploadMaxBytes": core.UPLOAD_MAX_BYTES,
        "inactiveDays": accounts.INACTIVE_DAYS if accounts.AUTH_ENABLED else 0,
    }


@router.post("/api/auth/rotate")
def auth_rotate(request: Request):
    """Новый код для того же кабинета: старый сразу перестаёт работать.

    Вход на других устройствах закрываем, а текущий оставляем: игрок как раз
    сохраняет новый код и продолжает работать.
    """
    user = core.current_user()
    code = accounts.rotate_code(user["id"])
    if not code:
        raise HTTPException(500, "не смог сгенерировать новый код, попробуй ещё раз")
    closed = accounts.delete_user_sessions(user["id"], keep_token=request.cookies.get(core.SESSION_COOKIE) or "")
    return {"code": accounts.format_code(code), "user": accounts.get_user(user["id"]),
            "sessionsClosed": closed}


@router.get("/api/health")
def health():
    return {"ok": True, "name": "chain-calc", "auth": accounts.AUTH_ENABLED}
