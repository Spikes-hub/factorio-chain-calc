"""Chain Calc: точка входа сервера.

Сам файл только собирает приложение. Разделы API лежат в пакете `web/`:

  web/core.py        настройки, мидлвары (порядок важен), обработчики ошибок, общие помощники
  web/auth.py        кабинеты: вход по коду, сессия
  web/upload.py      приём архива от батника и отдача иконок
  web/datasets.py    дампы игры (с кэшем готового ответа, gzip и ETag)
  web/chains.py      сохранённые цепочки
  web/blueprints.py  генерация чертежей и сундуков
  web/solve.py       расчёт цепочки

Запуск: `python app/main.py` (порт CHAIN_CALC_PORT, по умолчанию 8010).
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from chain_calc import accounts
from web import auth, blueprints, chains, core, datasets, solve, upload
from web.core import SESSION_COOKIE, client_ip, early_upload_rejection  # noqa: F401 - для тестов и скриптов

app = FastAPI(title="Chain Calc", lifespan=core.lifespan)
core.install(app)

for module in (auth, upload, datasets, chains, blueprints, solve):
    app.include_router(module.router)


# ---------------------------------------------------------------------------
# static frontend (must be mounted last so it doesn't shadow /api/*)
# ---------------------------------------------------------------------------

app.mount("/", StaticFiles(directory=core.PUBLIC_DIR, html=True), name="public")


def _port_is_busy(host: str, port: int, timeout: float = 0.4) -> bool:
    """True if something already accepts connections on host:port."""
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(timeout)
        return probe.connect_ex((host, port)) == 0


def _who_holds_the_port(host: str, port: int) -> str:
    """'ours' | 'stranger' - is the port held by this very server, or by something else?

    Launching a second copy next to a running one used to die with uvicorn's raw
    bind traceback ("[Errno 10048] ... bind"), which reads like the app is broken.
    The two cases need opposite advice, so tell them apart: this server answers
    /api/health with its own JSON, anything else (another project's uvicorn, a
    dev server, a proxy) does not. Спрашивать /api/datasets нельзя: он теперь
    закрыт входом и отвечает 401 всем, включая нашу же проверку.
    """
    import json
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://{host}:{port}/api/health", timeout=0.8) as resp:
            body = resp.read(8192)
        data = json.loads(body)
        return "ours" if isinstance(data, dict) and data.get("name") == "chain-calc" else "stranger"
    except Exception:  # noqa: BLE001 - any failure means "not this server"
        return "stranger"


if __name__ == "__main__":
    import os
    import sys

    import uvicorn

    # Позволяет запускать сервер просто открытием этого файла и нажатием F5
    # в VS Code (или "python main.py" из терминала) - без ручного вызова
    # uvicorn из командной строки. Используем объект `app` напрямую, чтобы
    # избежать проблем с импортом модуля при запуске как скрипта.
    host = os.environ.get("CHAIN_CALC_HOST", "127.0.0.1")
    port = int(os.environ.get("CHAIN_CALC_PORT", "8010"))

    # Кабинеты: создаём базу и папку пользователей, чистим просроченные сессии.
    accounts.init_db()
    dropped = accounts.purge_expired_sessions()
    print(f"Кабинеты: {accounts.count_users()} шт. База: {accounts.DB_PATH}")
    if dropped:
        print(f"Просроченных сессий убрано: {dropped}")
    print(f"Сессия держится {accounts.session_days():g} дн. "
          f"Вход по коду: {'включён' if accounts.AUTH_ENABLED else 'ВЫКЛЮЧЕН (CHAIN_CALC_AUTH=0)'}")
    if not accounts.AUTH_ENABLED:
        print("ВНИМАНИЕ: вход выключен — не выкладывай такой сервер в интернет.")

    if _port_is_busy(host, port):
        if _who_holds_the_port(host, port) == "ours":
            print(f"Порт {port} уже занят запущенной копией этого сервера.")
            print(f"Открой http://{host}:{port} — там она и работает.")
            print("Нужен запуск именно с текущими правками кода? Закрой старое окно сервера")
            print(f"(Ctrl+C в нём) или подними на другом порту: set CHAIN_CALC_PORT={port + 1}")
            sys.exit(0)
        print(f"Порт {port} занят ДРУГОЙ программой (на http://{host}:{port} отвечает не Chain Calc).")
        print("Кто именно держит порт, видно так (в обычной консоли, не здесь):")
        print(f'    netstat -ano | findstr :{port}')
        print('    tasklist /FI "PID eq <PID из последней колонки>"')
        print("Закрой ту программу — либо запусти этот сервер на свободном порту, например:")
        print(f"    set CHAIN_CALC_PORT={port + 1}")
        print("    run_python_server.bat")
        sys.exit(1)

    try:
        uvicorn.run(app, host=host, port=port, reload=False)
    except Exception as e:  # pragma: no cover - покажем ошибку в консоли
        import traceback

        print("Ошибка при запуске сервера:")
        traceback.print_exc()
        raise
