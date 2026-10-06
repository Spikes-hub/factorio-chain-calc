"""Общее для всех разделов API: настройки, мидлвары, обработчики ошибок, помощники.

Здесь же лежит то, что нельзя размазывать по файлам: порядок мидлваров (он важен) и
пределы, которые читают сразу несколько разделов. Пределы читаются из этого модуля как
`core.UPLOAD_MAX_BYTES` (а не `from core import ...`), чтобы тесты могли их подменять.
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

import langtr
from chain_calc import accounts, uploads

PUBLIC_DIR = Path(__file__).resolve().parent.parent.parent / "public"

# Папка с иконками, которые лежат в проекте (общие): у кабинета своя, но если
# игрок ничего не присылал, показываем эти — иначе первый вход был бы без картинок.
SHARED_ICONS_DIR = PUBLIC_DIR / "icons"

SESSION_COOKIE = "chaincalc_session"
# За HTTPS печеньку помечаем Secure; при работе на localhost это мешало бы входу.
COOKIE_SECURE = os.environ.get("CHAIN_CALC_COOKIE_SECURE", "0").strip().lower() in {"1", "true", "yes", "on"}
# Сколько принимаем в одном архиве (дамп Pyanodon с иконками — около 80 МБ, лимит 500 МБ).
UPLOAD_MAX_BYTES = int(os.environ.get("CHAIN_CALC_HTTP_UPLOAD_MAX_BYTES", str(500 * 1024 ** 2)))
# Оставлять ли присланный архив на диске после удачной распаковки.
KEEP_UPLOADS = os.environ.get("CHAIN_CALC_KEEP_UPLOADS", "0").strip().lower() in {"1", "true", "yes", "on"}

# Разделы API, которые доступны без входа: сам вход и приём архива по коду.
OPEN_API_PATHS = {"/api/auth/new", "/api/auth/login", "/api/auth/logout", "/api/auth/me",
                  "/api/upload", "/api/health"}


def new_id(n: int = 8) -> str:
    return uuid.uuid4().hex[:n]


def client_ip(request: Request) -> str:
    """Адрес клиента для ограничения попыток входа.

    За обратным прокси (nginx) настоящий адрес приходит в X-Forwarded-For. Заголовок
    можно подделать, поэтому это защита от «тыкания наугад», а не от целенаправленной
    атаки: код из 25 знаков перебрать всё равно невозможно.
    """
    host = (request.client.host if request.client else "?")
    forwarded = request.headers.get("x-forwarded-for")
    # X-Forwarded-For is believed only when the request really comes from a proxy on this machine
    # (nginx), and then only its LAST entry - the one the proxy added itself. The first entries
    # are written by the visitor and could be forged to dodge the limits.
    if forwarded and host in ("127.0.0.1", "::1", "localhost"):
        last = forwarded.split(",")[-1].strip()
        if last:
            return last[:64]
    return host[:64]


def current_user() -> dict:
    """Кабинет текущего запроса (для обработчиков, которым он нужен)."""
    user = accounts.current_user()
    if user is None:
        raise HTTPException(status_code=401, detail="нужен вход по коду кабинета")
    return user


def scope_user_id() -> Optional[int]:
    """Кабинет запроса или None в режиме без кабинетов (CHAIN_CALC_AUTH=0)."""
    user = accounts.current_user()
    if user is None and accounts.AUTH_ENABLED:
        raise HTTPException(401, "нужен вход по коду кабинета")
    return int(user["id"]) if user else None


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE, token,
        max_age=int(accounts.session_days() * 86400),
        httponly=True, samesite="lax", secure=COOKIE_SECURE, path="/",
    )


# ---------------------------------------------------------------------------
# мидлвары
# ---------------------------------------------------------------------------

async def security_headers(request: Request, call_next):
    """Заголовки, которые не дают браузеру «угадывать» тип файла и открывать сайт во фрейме."""
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


def early_upload_rejection(request: Request) -> Optional[JSONResponse]:
    """Отказ до чтения тела: архив бывает на сотни МБ, а код и размер видны уже в заголовках.

    Без этого сервер сначала принимал бы весь файл от кого угодно и только потом смотрел на код.
    Код в поле формы (без заголовка) по-прежнему проверяет сам обработчик.
    """
    try:
        size = int(request.headers.get("content-length") or 0)
    except ValueError:
        size = 0
    if size > UPLOAD_MAX_BYTES + 1024 * 1024:
        return JSONResponse(status_code=413, content={"error": f"архив больше {UPLOAD_MAX_BYTES // 1024 ** 2} МБ"})
    code = (request.headers.get("x-user-code") or "").strip()
    if code:
        ip = client_ip(request)
        if accounts.rate_limited(ip):
            return JSONResponse(status_code=429, content={"error": "слишком много неудачных попыток с этого адреса"})
        user = accounts.find_user_by_code(code)
        if user is None:
            accounts.note_failure(ip)
            return JSONResponse(status_code=401, content={
                "error": "код кабинета не подошёл (или не передан заголовком X-User-Code)"})
        problem = uploads.capacity_problem(int(user["id"]) if accounts.AUTH_ENABLED else None, size)
        if problem:
            return JSONResponse(status_code=problem[0], content={"error": problem[1]})
    return None


async def attach_account(request: Request, call_next):
    """Кладёт кабинет в контекст запроса и закрывает /api без входа."""
    user = None
    if accounts.AUTH_ENABLED:
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            try:
                user = accounts.resolve_session(token)
            except Exception:      # noqa: BLE001 — битая база не должна ронять запрос
                user = None
    ctx = accounts.set_current_user(user)
    lang_token = langtr.set_lang(request.headers.get("x-lang"))
    try:
        path = request.url.path
        if (accounts.AUTH_ENABLED and user is None and path.startswith("/api/")
                and path not in OPEN_API_PATHS):
            return JSONResponse(status_code=401, content={
                "error": "нужен вход по коду кабинета",
                "authRequired": True,
            })
        if path == "/api/upload" and request.method == "POST":
            rejected = early_upload_rejection(request)
            if rejected is not None:
                return rejected
        return await call_next(request)
    finally:
        langtr.reset_lang(lang_token)
        accounts.reset_current_user(ctx)


# ---------------------------------------------------------------------------
# обработчики ошибок
# ---------------------------------------------------------------------------

# Any exception the solver didn't turn into a SolverError used to leave the API
# as a bare `500 Internal Server Error` with an empty body and nothing in the
# log - the UI could only say "сервер ответил ошибкой (код 500)" and the actual
# reason (e.g. a KeyError on a dump field we don't know yet) was invisible.
# Answer with the same {"error": ...} shape every renderer already checks.
async def unhandled_exception_handler(request, exc: Exception):
    import traceback

    traceback.print_exc()
    return JSONResponse(
        status_code=500,
        content={"error": f"Внутренняя ошибка решателя: {type(exc).__name__}: {exc}"},
    )


async def http_exception_handler(request, exc: HTTPException):
    """Любая ошибка отвечает полем `error` — его и показывает интерфейс.

    Раньше FastAPI клал текст в `detail`, и половина обработчиков на странице
    просто молчала: они ищут `error`.
    """
    detail = exc.detail if isinstance(exc.detail, str) else json.dumps(exc.detail, ensure_ascii=False)
    return JSONResponse(status_code=exc.status_code, content={"error": detail, "detail": detail},
                        headers=getattr(exc, "headers", None))


async def _purge_loop() -> None:
    """Раз в несколько часов удаляет кабинеты, в которые давно не заходили (см. accounts.INACTIVE_DAYS)."""
    import traceback

    while True:
        try:
            accounts.init_db()
            removed = await asyncio.to_thread(accounts.purge_inactive_users)
            if removed:
                print(f"[cleanup] удалены кабинеты, в которые не заходили {accounts.INACTIVE_DAYS:g} дн.: "
                      + ", ".join(f"{n:04d}" for n in removed), flush=True)
        except Exception:      # noqa: BLE001 — уборка не должна ронять сервер
            traceback.print_exc()
        await asyncio.sleep(accounts.PURGE_EVERY_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Что делает сервер между запуском и остановкой: фоновая уборка заброшенных кабинетов.

    Через lifespan, а не `add_event_handler("startup")`: в новых Starlette (1.x) старые обработчики
    событий убраны, и сервер на свежеустановленных пакетах не запускался.
    """
    task = asyncio.create_task(_purge_loop())
    try:
        yield
    finally:
        task.cancel()


def install(app: FastAPI) -> None:
    """Подключает обработчики ошибок и мидлвары. Порядок: добавленное ПОЗЖЕ работает СНАРУЖИ.

    Снаружи — сжатие (жмёт всё, что отдаётся ниже), под ним заголовки безопасности (они нужны и
    ранним отказам), внутри — кабинет и ранний отказ при загрузке.
    """
    app.add_exception_handler(Exception, unhandled_exception_handler)
    app.add_exception_handler(HTTPException, http_exception_handler)
    app.middleware("http")(attach_account)
    app.middleware("http")(security_headers)
    # 5 вместо 9: дамп на 9 МБ жмётся за 0,08 с вместо ~1 с, а выигрыш в размере почти тот же
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)
