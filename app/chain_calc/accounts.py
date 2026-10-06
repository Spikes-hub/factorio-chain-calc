"""Кабинеты по коду: длинный код — одновременно логин и пароль.

Регистрации с почтой нет: «создать кабинет» генерирует код, показывает его один раз,
по нему же вход.

Что здесь есть:

* SQLite (`data/chaincalc.db`) — пользователи, сессии, датасеты, цепочки;
* код: 25 символов в пяти группах (ABCDE-FGHJK-MNPQR-STUVW-XYZ23), алфавит без
  похожих знаков, ~126 бит случайности. При вводе строчные буквы, дефисы и пробелы
  убираются, I/L читаются как 1, O — как 0;
* в базе лежит только хеш кода (sha256 с «перцем» из `data/.secret_key`). Забытый код
  восстановить нельзя: для этого есть `python -m chain_calc.accounts --rotate N`
  (администратор) и кнопка «сменить код» в кабинете;
* сессия — неделя (`CHAIN_CALC_SESSION_DAYS`), продлевается при использовании, но не
  чаще раза в час;
* папки кабинета: `data/users/0001/{datasets,icons,geometry}` — номер кабинета и есть
  имя папки.
"""
from __future__ import annotations

import contextvars
import hashlib
import json
import os
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = Path(os.environ.get("CHAIN_CALC_DATA") or (ROOT / "data"))
DB_PATH = Path(os.environ.get("CHAIN_CALC_DB") or (DATA_DIR / "chaincalc.db"))
USERS_DIR = Path(os.environ.get("CHAIN_CALC_USERS_DIR") or (DATA_DIR / "users"))
SECRET_FILE = DATA_DIR / ".secret_key"

SESSION_DAYS = float(os.environ.get("CHAIN_CALC_SESSION_DAYS", "7"))
SESSION_TOUCH_SECONDS = 3600          # как часто продлевать сессию при заходе

# Кабинет, в который не заходили столько дней, удаляется вместе с цепочками, дампом и иконками
# (это экономит диск и не копит чужие данные). 0 — не удалять никогда.
INACTIVE_DAYS = float(os.environ.get("CHAIN_CALC_INACTIVE_DAYS", "30"))
PURGE_EVERY_SECONDS = 6 * 3600        # как часто сервер проверяет, не пора ли кого-то удалить

# Секунды на одну попытку входа/загрузки с одного адреса.
LOGIN_ATTEMPTS = int(os.environ.get("CHAIN_CALC_LOGIN_ATTEMPTS", "30"))
LOGIN_WINDOW = float(os.environ.get("CHAIN_CALC_LOGIN_WINDOW", "600"))

# Включены ли кабинеты. `CHAIN_CALC_AUTH=0` — общие папки без входа (отладка, одиночный режим).
AUTH_ENABLED = os.environ.get("CHAIN_CALC_AUTH", "1").strip().lower() not in {"0", "false", "no", "off"}

CODE_GROUPS = 5
CODE_GROUP_LEN = 5
# Похожие знаки (I, L, O) из алфавита убраны: их легко перепутать при переписке
# кода руками, а «1» и «0» остаются и читаются как цифры.
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ0123456789"
CODE_LOOKALIKES = {"I": "1", "L": "1", "O": "0"}


# ---------------------------------------------------------------------------
# база
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  code_mask TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS datasets (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  file TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  recipes INTEGER NOT NULL DEFAULT 0,
  dump_version INTEGER NOT NULL DEFAULT 1,
  knows_unlocked INTEGER NOT NULL DEFAULT 0,
  uploaded_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS chains (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  dataset_id TEXT,
  solver TEXT,
  tree TEXT NOT NULL,
  final_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chains_user_idx ON chains(user_id, updated_at DESC);
"""


def now_ms() -> int:
    return int(time.time() * 1000)


def connect() -> sqlite3.Connection:
    """Новое соединение на операцию.

    Так проще, чем возиться с потоками: FastAPI выполняет обычные (не async)
    обработчики в пуле потоков, а sqlite3-соединение нельзя таскать между ними.
    Соединение дешёвое, а WAL позволяет читать и писать одновременно.
    """
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    USERS_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)


# ---------------------------------------------------------------------------
# код кабинета
# ---------------------------------------------------------------------------

def _pepper() -> str:
    """Секрет сервера: без него хеши кодов не подобрать даже с базой на руках.

    Файл создаётся при первом запуске. Удалишь его — все входы по старым кодам
    перестанут работать (сами кабинеты и данные останутся на месте).
    """
    if not SECRET_FILE.exists():
        SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
        SECRET_FILE.write_text(secrets.token_urlsafe(48), encoding="utf-8")
        try:
            os.chmod(SECRET_FILE, 0o600)
        except OSError:      # Windows/NTFS — просто оставляем как есть
            pass
    return SECRET_FILE.read_text(encoding="utf-8").strip()


def hash_code(code: str) -> str:
    normalized = normalize_code(code)
    return hashlib.sha256(f"{_pepper()}:{normalized}".encode()).hexdigest()


def normalize_code(code: str) -> str:
    """Приводит введённый код к каноническому виду.

    Регистр, дефисы и пробелы игнорируются; I, L, O (их нет в алфавите) заменяются на
    цифры.
    """
    out = []
    for ch in (code or "").upper():
        if ch in CODE_LOOKALIKES:
            ch = CODE_LOOKALIKES[ch]
        if ch in CODE_ALPHABET:
            out.append(ch)
    return "".join(out)


def format_code(code: str) -> str:
    normalized = normalize_code(code)
    groups = [normalized[i:i + CODE_GROUP_LEN] for i in range(0, len(normalized), CODE_GROUP_LEN)]
    return "-".join(groups)


def new_code() -> str:
    total = CODE_GROUPS * CODE_GROUP_LEN
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(total))


def code_mask(code: str) -> str:
    """Что можно показывать потом: первая группа настоящая, остальное скрыто.

    Пять знаков почти ничего не дают подбирающему (остаётся больше ста бит), но
    позволяют узнать свой код среди нескольких.
    """
    normalized = normalize_code(code)
    groups = [normalized[i:i + CODE_GROUP_LEN] for i in range(0, len(normalized), CODE_GROUP_LEN)]
    if not groups:
        return ""
    return "-".join([groups[0]] + ["•" * len(g) for g in groups[1:]])


def user_public(row: Any) -> dict:
    return {
        "id": row["id"],
        "number": f"{row['id']:04d}",
        "codeMask": row["code_mask"],
        "createdAt": row["created_at"],
        "lastSeenAt": row["last_seen_at"],
        "note": row["note"] or "",
    }


def create_user(note: str = "") -> tuple[dict, str]:
    init_db()
    for _ in range(20):
        code = new_code()
        try:
            with connect() as conn:
                cur = conn.execute(
                    "INSERT INTO users (code_hash, code_mask, created_at, last_seen_at, note)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (hash_code(code), code_mask(code), now_ms(), now_ms(), note or ""),
                )
                row = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
            return user_public(row), code
        except sqlite3.IntegrityError:      # совпал хеш — берём другой код
            continue
    raise RuntimeError("не удалось сгенерировать код кабинета")


def find_user_by_code(code: str) -> Optional[dict]:
    normalized = normalize_code(code)
    if len(normalized) != CODE_GROUPS * CODE_GROUP_LEN:
        return None
    with connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE code_hash = ?", (hash_code(normalized),)).fetchone()
    return user_public(row) if row else None


def get_user(user_id: int) -> Optional[dict]:
    with connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return user_public(row) if row else None


def rotate_code(user_id: int) -> Optional[str]:
    """Новый код для того же кабинета (старый сразу перестаёт работать)."""
    for _ in range(20):
        code = new_code()
        try:
            with connect() as conn:
                conn.execute(
                    "UPDATE users SET code_hash = ?, code_mask = ? WHERE id = ?",
                    (hash_code(code), code_mask(code), user_id),
                )
            return code
        except sqlite3.IntegrityError:
            continue
    return None


def set_note(user_id: int, note: str) -> None:
    with connect() as conn:
        conn.execute("UPDATE users SET note = ? WHERE id = ?", (note or "", user_id))


def touch_user(user_id: int) -> None:
    with connect() as conn:
        conn.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", (now_ms(), user_id))


def count_users() -> int:
    with connect() as conn:
        return int(conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"])


def list_users() -> list[dict]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM users ORDER BY id").fetchall()
    out = []
    for row in rows:
        user = user_public(row)
        user["datasets"] = len(list_datasets(row["id"]))
        user["chains"] = count_chains(row["id"])
        user["dir"] = str(user_dir(row["id"]))
        out.append(user)
    return out


def inactive_users(days: Optional[float] = None) -> list[dict]:
    """Кабинеты, в которые не заходили `days` дней (по умолчанию INACTIVE_DAYS).

    «Заходил» — это вход по коду, любой запрос с живой сессией (раз в час) и загрузка архива:
    все они обновляют last_seen_at. Кабинет, в который ни разу не заходили после создания,
    считается по дате создания.
    """
    days = INACTIVE_DAYS if days is None else days
    if not days or days <= 0:
        return []
    cutoff = now_ms() - int(days * 86400 * 1000)
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM users WHERE MAX(last_seen_at, created_at) < ? ORDER BY id", (cutoff,)
        ).fetchall()
    return [user_public(row) for row in rows]


def purge_inactive_users(days: Optional[float] = None) -> list[int]:
    """Удаляет заброшенные кабинеты (запись, сессии, цепочки, дампы, иконки). Возвращает их номера."""
    if not AUTH_ENABLED:          # без кабинетов удалять нечего: папки общие
        return []
    removed = []
    for user in inactive_users(days):
        delete_user(int(user["id"]))
        removed.append(int(user["id"]))
    return removed


def delete_user(user_id: int) -> None:
    """Удаляет кабинет: записи в базе и его папку с дампом и иконками."""
    with connect() as conn:
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    directory = user_dir(user_id)
    if directory.is_dir():
        import shutil

        shutil.rmtree(directory, ignore_errors=True)


# ---------------------------------------------------------------------------
# сессии
# ---------------------------------------------------------------------------

def session_days() -> float:
    return SESSION_DAYS


def create_session(user_id: int, user_agent: str = "") -> str:
    token = secrets.token_urlsafe(32)
    stamp = now_ms()
    with connect() as conn:
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (hashlib.sha256(token.encode()).hexdigest(), user_id, stamp,
             stamp + int(SESSION_DAYS * 86400 * 1000), stamp, (user_agent or "")[:200]),
        )
    return token


def resolve_session(token: str, touch: bool = True) -> Optional[dict]:
    """Кабинет по токену сессии. Просроченные сессии удаляются."""
    if not token:
        return None
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    stamp = now_ms()
    with connect() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE token_hash = ?", (token_hash,)).fetchone()
        if row is None:
            return None
        if row["expires_at"] <= stamp:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
            return None
        user = conn.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone()
        if user is None:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
            return None
        if touch and stamp - row["last_seen_at"] > SESSION_TOUCH_SECONDS * 1000:
            # Сессия «продлевается» сама: неделя считается от последнего захода,
            # а не от создания. Пишем редко, иначе база будет расти на пустом месте.
            conn.execute(
                "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
                (stamp, stamp + int(SESSION_DAYS * 86400 * 1000), token_hash),
            )
            conn.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", (stamp, user["id"]))
    return user_public(user)


def delete_session(token: str) -> None:
    if not token:
        return
    with connect() as conn:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?",
                     (hashlib.sha256(token.encode()).hexdigest(),))


def delete_user_sessions(user_id: int, keep_token: str = "") -> int:
    """Закрывает входы кабинета. `keep_token` — сессия, которую не трогаем.

    При смене кода остальные устройства выходят, а текущее остаётся.
    """
    keep = hashlib.sha256(keep_token.encode()).hexdigest() if keep_token else ""
    with connect() as conn:
        if keep:
            cur = conn.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
                               (user_id, keep))
        else:
            cur = conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        return cur.rowcount or 0


def purge_expired_sessions() -> int:
    with connect() as conn:
        cur = conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now_ms(),))
        return cur.rowcount or 0


# ---------------------------------------------------------------------------
# ограничение попыток входа (защита от перебора с одного адреса)
# ---------------------------------------------------------------------------

_attempts: dict[str, list[float]] = {}


def rate_limited(key: str) -> bool:
    """True — с этого адреса слишком часто ошибаются, отвечаем 429."""
    stamps = [t for t in _attempts.get(key, []) if time.time() - t < LOGIN_WINDOW]
    _attempts[key] = stamps
    return len(stamps) >= LOGIN_ATTEMPTS


def note_failure(key: str) -> None:
    _attempts.setdefault(key, []).append(time.time())


def clear_failures(key: str) -> None:
    _attempts.pop(key, None)


# Создание кабинета открыто всем, поэтому его тоже ограничиваем: иначе можно наплодить
# кабинетов и в каждый залить по гигабайту. Счётчик по адресам живёт в памяти (после
# перезапуска сервера обнуляется), потолок на число кабинетов считается по базе.
SIGNUPS_PER_DAY = int(os.environ.get("CHAIN_CALC_SIGNUPS_PER_DAY", "5"))
MAX_USERS = int(os.environ.get("CHAIN_CALC_MAX_USERS", "2000"))
_signups: dict[str, list[float]] = {}


def signup_blocked(key: str) -> str:
    """"" — можно создавать; "limit" — предел кабинетов на сервере; "rate" — слишком часто с этого адреса."""
    if MAX_USERS and count_users() >= MAX_USERS:
        return "limit"
    stamps = [t for t in _signups.get(key, []) if time.time() - t < 86400]
    _signups[key] = stamps
    if SIGNUPS_PER_DAY and len(stamps) >= SIGNUPS_PER_DAY:
        return "rate"
    return ""


def note_signup(key: str) -> None:
    _signups.setdefault(key, []).append(time.time())


def reset_signups() -> None:
    _signups.clear()


# ---------------------------------------------------------------------------
# папки кабинета
# ---------------------------------------------------------------------------

def user_dir(user_id: int) -> Path:
    return USERS_DIR / f"{int(user_id):04d}"


def user_datasets_dir(user_id: int) -> Path:
    return user_dir(user_id) / "datasets"


def user_icons_dir(user_id: int) -> Path:
    return user_dir(user_id) / "icons"


def user_geometry_dir(user_id: int) -> Path:
    return user_dir(user_id) / "geometry"


def user_uploads_dir(user_id: int) -> Path:
    return user_dir(user_id) / "uploads"


def ensure_user_dirs(user_id: int) -> None:
    for path in (user_datasets_dir(user_id), user_icons_dir(user_id),
                 user_geometry_dir(user_id), user_uploads_dir(user_id)):
        path.mkdir(parents=True, exist_ok=True)


def dir_size(path: Path) -> int:
    total = 0
    if not path.is_dir():
        return 0
    for item in path.rglob("*"):
        try:
            if item.is_file():
                total += item.stat().st_size
        except OSError:
            continue
    return total


# ---------------------------------------------------------------------------
# «чей сейчас запрос» — чтобы генераторы чертежей нашли датасет и геометрию
# ---------------------------------------------------------------------------
#
# blueprint_gen/mall_gen берут датасет через blueprint.DATASET_DIR, а геометрию —
# через blueprint.geometry_path(). Пробрасывать user_id через десяток функций
# пришлось бы ради одной строки, поэтому текущий кабинет лежит в contextvar:
# middleware кладёт его туда на время запроса, а blueprint сам спрашивает.

_current_user: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("chaincalc_user", default=None)
_current_icons_fallback: contextvars.ContextVar[bool] = contextvars.ContextVar("chaincalc_icons_fallback", default=True)


def set_current_user(user: Optional[dict]) -> contextvars.Token:
    return _current_user.set(user)


def reset_current_user(token: contextvars.Token) -> None:
    _current_user.reset(token)


def current_user() -> Optional[dict]:
    return _current_user.get()


def current_user_id() -> Optional[int]:
    user = _current_user.get()
    return int(user["id"]) if user else None


def current_datasets_dir() -> Optional[Path]:
    """Папка датасетов текущего кабинета (None — кабинета нет)."""
    user = _current_user.get()
    if not user:
        return None
    return user_datasets_dir(int(user["id"]))


def current_geometry_dir() -> Optional[Path]:
    user = _current_user.get()
    if not user:
        return None
    path = user_geometry_dir(int(user["id"]))
    if path.is_dir() and any(path.glob("*.json")):
        return path
    return None


def current_icons_dir() -> Optional[Path]:
    user = _current_user.get()
    if not user:
        return None
    path = user_icons_dir(int(user["id"]))
    return path if path.is_dir() else None


# ---------------------------------------------------------------------------
# датасеты и цепочки кабинета (метаданные; сами файлы — в папке кабинета)
# ---------------------------------------------------------------------------

def register_dataset(user_id: int, dataset_id: str, file: Path, data: dict, source: str = "") -> None:
    recipes = data.get("recipes") or {}
    knows = any(
        isinstance(r, dict) and r.get("unlocked_now") is not None for r in recipes.values()
    )
    with connect() as conn:
        conn.execute(
            "INSERT INTO datasets (user_id, id, file, size, recipes, dump_version, knows_unlocked, uploaded_at, source)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(user_id, id) DO UPDATE SET file=excluded.file, size=excluded.size,"
            " recipes=excluded.recipes, dump_version=excluded.dump_version,"
            " knows_unlocked=excluded.knows_unlocked, uploaded_at=excluded.uploaded_at,"
            " source=excluded.source",
            (user_id, dataset_id, str(file), file.stat().st_size if file.exists() else 0,
             len(recipes), int(data.get("dump_version") or 1), 1 if knows else 0,
             now_ms(), source),
        )


def list_datasets(user_id: int) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM datasets WHERE user_id = ? ORDER BY uploaded_at DESC, id DESC",
            (user_id,),
        ).fetchall()
    return [
        {
            "id": row["id"],
            "recipes": row["recipes"],
            "dumpVersion": row["dump_version"],
            "knowsUnlocked": bool(row["knows_unlocked"]),
            "size": row["size"],
            "uploadedAt": row["uploaded_at"],
            "source": row["source"],
        }
        for row in rows
    ]


def get_dataset(user_id: int, dataset_id: str) -> Optional[dict]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM datasets WHERE user_id = ? AND id = ?", (user_id, dataset_id)
        ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"], "file": row["file"], "recipes": row["recipes"],
        "dumpVersion": row["dump_version"], "knowsUnlocked": bool(row["knows_unlocked"]),
        "size": row["size"], "uploadedAt": row["uploaded_at"], "source": row["source"],
    }


def forget_dataset(user_id: int, dataset_id: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM datasets WHERE user_id = ? AND id = ?", (user_id, dataset_id))


def count_chains(user_id: int) -> int:
    with connect() as conn:
        return int(conn.execute("SELECT COUNT(*) AS n FROM chains WHERE user_id = ?", (user_id,)).fetchone()["n"])


# ---------------------------------------------------------------------------
# командная строка: посмотреть кабинеты, сменить код, удалить кабинет
# ---------------------------------------------------------------------------

def _cli(argv: list[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="Кабинеты Chain Calc: список, новый код, удаление.",
    )
    parser.add_argument("--list", action="store_true", help="показать все кабинеты")
    parser.add_argument("--rotate", type=int, metavar="N", help="выдать новый код кабинету N")
    parser.add_argument("--delete", type=int, metavar="N", help="удалить кабинет N вместе с файлами")
    parser.add_argument("--purge-inactive", nargs="?", type=float, const=-1, metavar="ДНЕЙ",
                        help="удалить кабинеты, в которые не заходили столько дней (по умолчанию "
                             "CHAIN_CALC_INACTIVE_DAYS)")
    args = parser.parse_args(argv)

    init_db()
    if args.purge_inactive is not None:
        days = None if args.purge_inactive < 0 else args.purge_inactive
        removed = purge_inactive_users(days)
        print(f"Удалено кабинетов: {len(removed)}" + (f" ({', '.join(f'{n:04d}' for n in removed)})" if removed else ""))
        return 0
    if args.rotate is not None:
        code = rotate_code(args.rotate)
        if not code:
            print(f"Кабинет {args.rotate} не найден.")
            return 1
        print(f"Новый код кабинета {args.rotate:04d}: {format_code(code)}")
        print("Старый код больше не работает — передай новый игроку.")
        return 0
    if args.delete is not None:
        user = get_user(args.delete)
        if not user:
            print(f"Кабинет {args.delete} не найден.")
            return 1
        delete_user(args.delete)
        print(f"Кабинет {args.delete:04d} удалён вместе с папкой {user_dir(args.delete)}.")
        return 0

    print(f"База: {DB_PATH}")
    print(f"Папки кабинетов: {USERS_DIR}")
    print(f"Сессия: {SESSION_DAYS:g} дн. · вход по коду: {'включён' if AUTH_ENABLED else 'ВЫКЛЮЧЕН (CHAIN_CALC_AUTH=0)'}")
    users = list_users()
    if not users:
        print("Кабинетов пока нет.")
        return 0
    print(f"Всего кабинетов: {len(users)}")
    for user in users:
        import datetime

        created = datetime.datetime.fromtimestamp(user["createdAt"] / 1000).strftime("%Y-%m-%d %H:%M")
        seen = datetime.datetime.fromtimestamp(user["lastSeenAt"] / 1000).strftime("%Y-%m-%d %H:%M") if user["lastSeenAt"] else "—"
        size = dir_size(user_dir(user["id"])) / (1024 * 1024)
        print(f"  №{user['number']}  код {user['codeMask']}  создан {created}  был {seen}"
              f"  дампов {user['datasets']}  цепочек {user['chains']}  папка {size:.1f} МБ")
    return 0


if __name__ == "__main__":       # pragma: no cover — ручной инструмент админа
    import sys

    raise SystemExit(_cli(sys.argv[1:]))
