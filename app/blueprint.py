"""Чтение, запись и проверка строк блюпринтов Factorio 2.0.

Строка блюпринта — zlib-сжатый JSON в base64 с байтом версии "0" впереди:

    0eNqVkEkKwzAMRe+itR...   ->  {"blueprint": {"entities": [...]}}

Игра 2.0 принимает и «сырой» JSON блюпринта, декодер тоже.

Что здесь есть:

  * decode_string / encode_string — строка <-> словарь;
  * blueprint_of / iter_entities — сам блюпринт и его сущности;
  * tiles_of — какие тайлы занимает сущность (по геометрии из data/geometry);
  * fluid_connections — входы/выходы газа и жидкости завода и тайлы подхода;
  * validate — проблемы блюпринта: сетка, пересечения, рецепты, трубы, манипуляторы,
    смотрящие в пустоту;
  * describe — человекочитаемый разбор блюпринта;
  * translate — сдвиг блюпринта по тайлам.

Запуск из командной строки:

    python app\\blueprint.py "tests\\fixtures\\blueprints.json"   # массив строк
    python app\\blueprint.py blueprint.txt                        # одна строка
"""
from __future__ import annotations

import base64
import json
import math
import zlib
from pathlib import Path

import langtr

ROOT = Path(__file__).resolve().parent.parent
GEOMETRY_DIR = ROOT / "data" / "geometry"
DATASET_DIR = ROOT / "data" / "datasets"

# 2.0: 0 = север, 4 = восток, 8 = юг, 12 = запад. Промежуточные значения —
# полуповороты, они бывают у рельсов и «половинных» сущностей.
DIRECTIONS = {0: "север", 4: "восток", 8: "юг", 12: "запад"}
# Шаг в тайлах по направлению (0 — север, дальше по часовой стрелке).
DIRECTION_STEPS = {0: (0, -1), 4: (1, 0), 8: (0, 1), 12: (-1, 0)}
DIR_VECTORS = {0: (0, -1), 4: (1, 0), 8: (0, 1), 12: (-1, 0)}

# Сущности, которые в блюпринте законно стоят «поверх» других или вообще не
# занимают тайлы (рельсы кладутся на тайл, призраки повторяют чужие очертания).
IGNORE_COLLISION = {
    "entity-ghost",
    "tile-ghost",
    "item-request-proxy",
    "straight-rail",
    "curved-rail-a",
    "curved-rail-b",
    "half-diagonal-rail",
    "elevated-straight-rail",
    "elevated-curved-rail-a",
    "elevated-curved-rail-b",
    "elevated-half-diagonal-rail",
    "legacy-straight-rail",
    "legacy-curved-rail",
    "rail-support",
}

PIPE_TYPES = {"pipe", "pipe-to-ground", "infinity-pipe", "valve", "heat-pipe"}

# У обычной трубы «входы/выходы» — это просто четыре стыка, они подключаются к
# соседям сами, и предупреждать о них не о чем. Смотрим только на устья, которые
# кто-то должен обслужить: заводы, подземные трубы, насосы, баки.
AMBIENT_PIPE_TYPES = {"pipe", "infinity-pipe", "valve", "heat-pipe"}
MACHINE_TYPES = {
    "assembling-machine",
    "furnace",
    "rocket-silo",
    "lab",
    "mining-drill",
    "boiler",
    "generator",
    "burner-generator",
    "reactor",
    "agricultural-tower",
}

# Рецепт бывает не у всех заводов: у котлов, генераторов, реакторов и буровых
# его нет вовсе (буровой нужен ресурс, котлу — топливо и вода).
RECIPE_REQUIRED_TYPES = {"assembling-machine", "rocket-silo"}
RECIPE_OPTIONAL_TYPES = {"furnace", "lab", "agricultural-tower"}


# --------------------------------------------------------------------------
# геометрия
# --------------------------------------------------------------------------
_geometry_cache: dict[str, tuple[tuple[int, int], dict]] = {}
_GEOMETRY_CACHE_LIMIT = 4


def _file_stamp(path: Path) -> tuple[int, int]:
    """Отпечаток файла: время правки и размер.

    Геометрию могут перезаписать на ходу (/api/upload); кэш только по имени файла
    отдавал бы старую до перезапуска сервера.
    """
    try:
        stat = path.stat()
    except OSError:
        return (0, 0)
    return (stat.st_mtime_ns, stat.st_size)


def geometry_dir() -> Path:
    """Папка геометрии: у кабинета своя, если он её загрузил, иначе общая.

    Геометрия — размеры и стыки построек из сборки модов пользователя, поэтому она
    лежит в кабинете (см. /api/upload). Без загрузки берётся общая папка проекта.
    """
    try:
        from chain_calc import accounts

        own = accounts.current_geometry_dir()
        if own is not None:
            return own
    except Exception:      # noqa: BLE001 — без кабинета работает как раньше
        pass
    return GEOMETRY_DIR


def dataset_dir() -> Path:
    """Папка датасетов: у кабинета своя, иначе общая (режим без входа)."""
    try:
        from chain_calc import accounts

        own = accounts.current_datasets_dir()
        if own is not None:
            return own
    except Exception:      # noqa: BLE001
        pass
    return DATASET_DIR


def geometry_path(path: str | Path | None = None) -> Path | None:
    if path:
        p = Path(path)
        return p if p.is_file() else None
    directory = geometry_dir()
    if not directory.is_dir():
        return None
    files = sorted(directory.glob("*.json"))
    return files[-1] if files else None


def load_geometry(path: str | Path | None = None) -> dict:
    """Файл геометрии (см. tools/extract_geometry.py). Пустой словарь, если нет.

    Кэш — по пути к файлу И по его отпечатку: у каждого кабинета геометрия своя
    (общий кэш отдавал бы чужую), а присланный архив может перезаписать файл под
    тем же именем — тогда старый разбор обязан устареть.
    """
    global _geometry_cache
    p = geometry_path(path)
    if p is None:
        return {}
    key = str(p)
    stamp = _file_stamp(p)
    if path is None:
        cached = _geometry_cache.get(key)
        if cached and cached[0] == stamp:
            return cached[1]
    with p.open(encoding="utf-8") as f:
        data = json.load(f)
    if path is None:
        _geometry_cache[key] = (stamp, data)
        while len(_geometry_cache) > _GEOMETRY_CACHE_LIMIT:
            _geometry_cache.pop(next(iter(_geometry_cache)), None)
    return data


_records_cache: list[tuple[dict, dict]] = []


def entity_records(geometry: dict | None = None) -> dict:
    """name -> запись геометрии (по всем типам).

    Результат кэшируется по самому словарю геометрии: разбор файла в плоский
    индекс стоит ~1.5 мс, а спрашивают его на каждую постройку (у молла это
    тысячи вызовов — без кэша одна сборка чертежа уходила в полминуты).
    Возвращённый словарь — общий: читать можно, менять нельзя.
    """
    geom = geometry if geometry is not None else load_geometry()
    for cached_geom, cached in _records_cache:
        if cached_geom is geom:
            return cached
    flat: dict = {}
    for ptype, protos in (geom.get("entities") or {}).items():
        for name, rec in protos.items():
            flat.setdefault(name, {**rec, "type": rec.get("type") or ptype})
    _records_cache.append((geom, flat))
    del _records_cache[:-4]      # держим только последние: словари могут быть разными
    return flat


def entity_record(name: str, geometry: dict | None = None) -> dict | None:
    return entity_records(geometry).get(name)


def entity_size(name: str, geometry: dict | None = None, direction: int = 0) -> tuple[int, int] | None:
    """Размер постройки в тайлах С УЧЁТОМ поворота.

    prototype.collision_box в игре задан для направления «север»; при повороте на
    90° (восток/запад) негабаритные постройки разворачиваются: погрузчик — это
    1x2 «стоя» и 2x1 «лёжа», сплиттер — 2x1 и 1x2.
    """
    rec = entity_record(name, geometry)
    if not rec or not rec.get("size"):
        return None
    w, h = int(rec["size"][0]), int(rec["size"][1])
    if w != h and (int(direction) // 4) % 2 == 1 and "not-rotatable" not in (rec.get("flags") or []):
        w, h = h, w
    return w, h


# --------------------------------------------------------------------------
# строка <-> JSON
# --------------------------------------------------------------------------
def decode_json(text: str) -> dict:
    """Строка блюпринта (или сырой JSON) -> словарь."""
    text = text.strip().strip('"')
    if text.startswith("{"):
        return json.loads(text)
    if not text:
        raise ValueError("пустая строка блюпринта")
    if text[0].isdigit():
        text = text[1:]
    payload = base64.b64decode(text)
    return json.loads(zlib.decompress(payload).decode("utf-8"))


def encode_json(obj: dict) -> str:
    """Словарь -> строка блюпринта (совместимо с игрой: уровень сжатия 9)."""
    langtr.translate_blueprint(obj)   # название/описание чертежа — на языке страницы
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return "0" + base64.b64encode(zlib.compress(raw, 9)).decode("ascii")


# обратная совместимость с привычными именами
decode_string = decode_json
encode_string = encode_json


def blueprint_of(obj: dict, index: int | None = None) -> dict:
    """Достаёт сам блюпринт: из объекта, из книги или из массива сущностей."""
    if "blueprint" in obj:
        return obj["blueprint"]
    if "blueprint_book" in obj:
        book = obj["blueprint_book"]
        entries = book.get("blueprints") or []
        if not entries:
            return {}
        if index is None:
            index = int(book.get("active_index") or 0)
            index = min(index, len(entries) - 1)
        return entries[index].get("blueprint") or {}
    if "entities" in obj:  # уже сам блюпринт
        return obj
    return {}


def iter_entities(obj: dict) -> list[dict]:
    return list(blueprint_of(obj).get("entities") or [])


# --------------------------------------------------------------------------
# тайлы
# --------------------------------------------------------------------------
def _snap(value: float) -> float:
    """Factorio хранит координаты с точностью 1/256 — округляем к ней."""
    return round(value * 256) / 256


def tiles_of(entity: dict, geometry: dict | None = None) -> tuple[int, int, int, int] | None:
    """(лево, верх, ширина, высота) в тайлах. None, если размер неизвестен.

    Сущность ставится на сетку целиком: центр нечётной постройки попадает на
    середину тайла (3x3 -> центр x.5), чётной — на стык тайлов (2x2 -> центр x.0).
    """
    name = entity.get("name") or ""
    size = entity_size(name, geometry, int(entity.get("direction") or 0))
    if not size:
        return None
    w, h = size
    pos = entity.get("position") or {}
    cx, cy = _snap(float(pos.get("x", 0.0))), _snap(float(pos.get("y", 0.0)))
    left = int(round(cx - w / 2))
    top = int(round(cy - h / 2))
    return left, top, w, h


def tile_center(left: int, top: int, w: int, h: int) -> tuple[float, float]:
    return left + w / 2, top + h / 2


def position_for_tile(left: int, top: int, w: int, h: int) -> dict:
    """Позиция центра сущности для левого верхнего тайла (лево, верх)."""
    cx, cy = tile_center(left, top, w, h)
    return {"x": _snap(cx), "y": _snap(cy)}


def is_grid_aligned(entity: dict, geometry: dict | None = None) -> bool:
    """Стоит ли сущность ровно по тайлам (без половинок и сдвигов)."""
    pos = entity.get("position") or {}
    cx, cy = _snap(float(pos.get("x", 0.0))), _snap(float(pos.get("y", 0.0)))
    t = tiles_of(entity, geometry)
    if t is None:
        # без геометрии проверяем хотя бы «целость/полутайловость» координат
        return abs(cx * 2 - round(cx * 2)) < 0.002 and abs(cy * 2 - round(cy * 2)) < 0.002
    left, top, w, h = t
    return abs(cx - (left + w / 2)) < 0.002 and abs(cy - (top + h / 2)) < 0.002


def rotate_vec(vec: tuple[float, float], direction: int) -> tuple[float, float]:
    """Поворот вектора (заданного для направления «север») на direction.

    Factorio: 0=север, 4=восток, 8=юг, 12=запад; поворот на 90° по часовой:
    (x, y) -> (-y, x).
    """
    x, y = vec
    for _ in range((int(direction) // 4) % 4):
        x, y = -y, x
    return x, y


# --------------------------------------------------------------------------
# жидкости
# --------------------------------------------------------------------------
def fluid_connections(entity: dict, geometry: dict | None = None) -> list[dict]:
    """Входы/выходы труб у сущности: сторона, тайл завода и тайл подхода.

    Тайл подхода — это клетка ЗА габаритом постройки, куда должна прийти труба.
    Именно её нельзя занимать столбом, лентой или манипулятором.
    """
    rec = entity_record(entity.get("name") or "", geometry)
    if not rec or not rec.get("fluids"):
        return []
    t = tiles_of(entity, geometry)
    if t is None:
        return []
    left, top, w, h = t
    # Постройка поворачивается (0/4/8/12) вместе со своими трубными подключениями:
    # у повёрнутой теплицы вход воды уезжает на другую стену.
    steps = (int(entity.get("direction") or 0) // 4) % 4
    out = []
    for box_index, box in enumerate(rec["fluids"]):
        for conn in box.get("pipes") or []:
            pos = conn.get("pos") or [0, 0]
            px, py = float(pos[0]), float(pos[1])
            for _ in range(steps):
                px, py = -py, px
            direction = (int(conn.get("dir") or 0) + steps * 4) % 16
            dx, dy = DIR_VECTORS.get(direction, (0, 0))
            cx, cy = left + w / 2 + px, top + h / 2 + py
            conn_tile = (math.floor(cx), math.floor(cy))
            approach = (conn_tile[0] + dx, conn_tile[1] + dy)
            out.append(
                {
                    "box": box_index,
                    "production": box.get("production"),
                    "flow": conn.get("flow"),
                    "direction": direction,
                    "side": DIRECTIONS.get(direction, f"направление {direction}"),
                    "kind": conn.get("type") or "normal",
                    "filter": conn.get("filter"),
                    "energy": bool(box.get("energy")),
                    "box_flow": conn.get("flow"),
                    # категории соединения: труба соединяется с портом, только если
                    # у них есть общая категория (ниобиевая труба с обычным портом — нет)
                    "categories": list(conn.get("categories") or []) or ["default"],
                    "max_underground_distance": conn.get("max_underground"),
                    "machine_tile": conn_tile,
                    "approach_tile": approach,
                }
            )
    return out


# --------------------------------------------------------------------------
# проверки
# --------------------------------------------------------------------------
def _index_by_tile(entities: list[dict], geometry: dict | None) -> dict:
    index: dict = {}
    for ent in entities:
        if (ent.get("name") or "") in IGNORE_COLLISION:
            continue
        t = tiles_of(ent, geometry)
        if not t:
            continue
        left, top, w, h = t
        if w <= 0 or h <= 0:
            continue
        for x in range(left, left + w):
            for y in range(top, top + h):
                index.setdefault((x, y), []).append(ent)
    return index


def validate(obj: dict, geometry: dict | None = None, recipes: dict | None = None) -> list[dict]:
    """Проверяет блюпринт. Возвращает список проблем: {level, code, text}.

    recipes — необязательный словарь рецептов датасета (name -> {...}) для
    проверки названий рецептов и модулей.
    """
    problems: list[dict] = []
    bp = blueprint_of(obj)
    entities = list(bp.get("entities") or [])
    records = entity_records(geometry)

    def add(level: str, code: str, text: str):
        problems.append({"level": level, "code": code, "text": text})

    for ent in entities:
        name = ent.get("name") or "?"
        rec = records.get(name)
        if rec is None:
            add("warn", "unknown-entity", f"Нет в геометрии: {name}")
            continue
        if not is_grid_aligned(ent, geometry):
            pos = ent.get("position") or {}
            add("error", "off-grid",
                f"{name} стоит не по сетке: ({pos.get('x')}, {pos.get('y')})")
        etype = rec.get("type")
        recipe = ent.get("recipe")
        if etype in RECIPE_REQUIRED_TYPES and not recipe:
            add("warn", "no-recipe", f"{name} без рецепта")
        if etype in RECIPE_OPTIONAL_TYPES and not recipe:
            add("info", "no-recipe", f"{name} без рецепта (может быть пустым)")
        if recipe and etype not in MACHINE_TYPES:
            add("warn", "odd-recipe", f"{name} ({etype}) с рецептом {recipe}")
        if recipes is not None and recipe and recipe not in recipes:
            add("warn", "unknown-recipe", f"Неизвестный рецепт: {recipe} (у {name})")

    # пересечения
    index = _index_by_tile(entities, geometry)
    overlaps = {tile: ents for tile, ents in index.items() if len(ents) > 1}
    if overlaps:
        sample = []
        for tile, ents in sorted(overlaps.items())[:5]:
            names = "+".join(sorted({e.get("name") or "?" for e in ents}))
            sample.append(f"({tile[0]},{tile[1]}): {names}")
        add("error", "overlap",
            f"Постройки пересекаются в {len(overlaps)} тайлах — " + "; ".join(sample))

    # столбы без проводов: в игре провод из чертежа берётся как есть, и «забытый»
    # провод — это мёртвая сеть, а не мелочь оформления.
    for problem in pole_wire_problems(obj, geometry):
        add(problem["level"], "pole-no-wire", problem["text"])

    return problems


def fluid_report(obj: dict, geometry: dict | None = None) -> dict:
    """Что с трубами у заводов: подключено, ушло под землю или висит в воздухе.

    «Свободен» — это обычный вход/выход, к которому снаружи не подходит ни одна
    труба: именно в этот тайл генератор обязан не ставить столб, ленту или
    манипулятор. Подземные концы (у подземной трубы их два) отдельно — они
    соединяются под землёй, и тайл подхода у них не занимается.
    """
    bp = blueprint_of(obj)
    entities = list(bp.get("entities") or [])
    pipes = {(t[0], t[1]) for t in (tiles_of(e, geometry) for e in entities
                                    if (e.get("name") or "") in PIPE_TYPES) if t}
    connected, free, underground = [], [], []
    for ent in entities:
        rec = entity_record(ent.get("name") or "", geometry) or {}
        if rec.get("type") in AMBIENT_PIPE_TYPES:
            continue
        for conn in fluid_connections(ent, geometry):
            entry = {"entity": ent.get("name"), "tile": conn["machine_tile"], **conn}
            if conn["kind"] == "underground":
                underground.append(entry)
            elif conn["approach_tile"] in pipes:
                connected.append(entry)
            else:
                free.append(entry)
    return {"connected": connected, "free": free, "underground": underground,
            "pipes": sorted(pipes)}


def pole_wire_distance(entity_name: str, geometry: dict | None = None) -> float:
    """Вылет провода у столба: дальше этого расстояния провод не тянется.

    Игра соединяет два столба обычным проводом, если расстояние между их центрами
    не больше `maximum_wire_distance` из прототипа.
    """
    rec = entity_record(entity_name, geometry) or {}
    electric = rec.get("electric") or {}
    return float(electric.get("maximum_wire_distance") or 7.5)


def pole_tiles(obj: dict, geometry: dict | None = None) -> list[dict]:
    """Столбы чертежа: номер сущности, имя и тайл (центр постройки)."""
    out = []
    for ent in iter_entities(obj):
        rec = entity_record(ent.get("name") or "", geometry)
        if not rec or rec.get("type") != "electric-pole":
            continue
        tile = tiles_of(ent, geometry)
        if not tile:
            continue
        left, top, w, h = tile
        out.append({
            "number": int(ent.get("entity_number") or 0),
            "name": ent.get("name"),
            "tile": (left + (w - 1) // 2, top + (h - 1) // 2),
            "entity": ent,
        })
    return out


def connect_power_wires(obj: dict, geometry: dict | None = None) -> dict:
    """Прописать в чертёж провода между столбами (поле `neighbours`).

    В блюпринте провода не создаются сами: игра строит ровно те связи, что записаны
    в `neighbours` («Copper wire connections, array of entity_numbers»,
    https://wiki.factorio.com/Blueprint_string_format).

    Соединяются ближайшие столбы (минимальное остовное дерево, алгоритм Прима по сетке):
    сеть связная, на столб приходится один-два провода — у столба есть предел числа
    связей.

    Возвращает отчёт: сколько проводов, сети и столбы, оставшиеся без провода.
    """
    poles = pole_tiles(obj, geometry)
    report = {"poles": len(poles), "wires": 0, "components": [], "isolated": [],
              "long": []}
    if len(poles) < 2:
        return report

    parent = list(range(len(poles)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    # Соседей ищем ПО СЕТКЕ, а не перебором всех пар: в молле столбов сотни на
    # часть, и честный перебор «каждый с каждым» стоил бы секунды на чертёж.
    cell = max(1.0, max(pole_wire_distance(p["name"], geometry) for p in poles))
    grid: dict[tuple[int, int], list[int]] = {}
    for index, pole in enumerate(poles):
        x, y = pole["tile"]
        grid.setdefault((int(x // cell), int(y // cell)), []).append(index)
    near: list[tuple[float, int, int]] = []
    for (cx, cy), bucket in grid.items():
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                other = grid.get((cx + dx, cy + dy))
                if not other:
                    continue
                for i in bucket:
                    for j in other:
                        if j <= i:
                            continue
                        ax, ay = poles[i]["tile"]
                        bx, by = poles[j]["tile"]
                        distance = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5
                        # Провод соединяет пару, если он дотягивается ХОТЯ БЫ у одного
                        # из двух: у разных столбов вылет разный, и это ровно то, как
                        # соединяет их игра.
                        reach = max(pole_wire_distance(poles[i]["name"], geometry),
                                    pole_wire_distance(poles[j]["name"], geometry))
                        if distance <= reach + 1e-9:
                            near.append((distance, i, j))
    near.sort()
    for distance, i, j in near:
        if find(i) == find(j):
            continue
        union(i, j)
        wires = poles[i]["entity"].setdefault("neighbours", [])
        wires.append(poles[j]["number"])
        wires = poles[j]["entity"].setdefault("neighbours", [])
        wires.append(poles[i]["number"])
        report["wires"] += 1

    groups: dict[int, list[int]] = {}
    for index in range(len(poles)):
        groups.setdefault(find(index), []).append(index)
    report["components"] = [sorted(groups[key]) for key in sorted(groups, key=lambda k: -len(groups[k]))]
    if len(report["components"]) > 1:
        # Одиночные столбы без соседа в пределах вылета — это не поломка, а честный
        # факт: провод к ним тянуть некуда.
        biggest = report["components"][0]
        in_main = set(biggest)
        report["isolated"] = [[poles[i]["name"], poles[i]["tile"]]
                              for i in range(len(poles)) if i not in in_main]
    # Связи, которые игра не создаст: провод длиннее вылета.
    for pole in poles:
        ax, ay = pole["tile"]
        for neighbour_number in pole["entity"].get("neighbours") or []:
            other = next((p for p in poles if p["number"] == neighbour_number), None)
            if not other:
                continue
            distance = ((ax - other["tile"][0]) ** 2 + (ay - other["tile"][1]) ** 2) ** 0.5
            if distance > max(pole_wire_distance(pole["name"], geometry),
                              pole_wire_distance(other["name"], geometry)) + 1e-9:
                report["long"].append([pole["tile"], other["tile"], round(distance, 2)])
    return report


def pole_wire_problems(obj: dict, geometry: dict | None = None) -> list[dict]:
    """Столбы без провода, хотя сосед в пределах вылета: в игре это мёртвая сеть."""
    poles = pole_tiles(obj, geometry)
    problems = []
    for index, pole in enumerate(poles):
        if pole["entity"].get("neighbours"):
            continue
        ax, ay = pole["tile"]
        reach = pole_wire_distance(pole["name"], geometry)
        for other_index, other in enumerate(poles):
            if other_index == index:
                continue
            bx, by = other["tile"]
            distance = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5
            if distance <= max(reach, pole_wire_distance(other["name"], geometry)) + 1e-9:
                problems.append({
                    "level": "warn",
                    "text": f"столб {pole['name']} на {pole['tile']} без провода, "
                            f"хотя столб на {other['tile']} в пределах вылета "
                            f"({distance:.1f} ≤ {reach:.1f}) — в игре он останется без питания",
                    "entity": pole["number"],
                    "tile": pole["tile"],
                })
                break
    return problems


def pole_wire_components(obj: dict, geometry: dict | None = None) -> list[list[dict]]:
    """Сети столбов ПО ПРОПИСАННЫМ ПРОВОДАМ (`neighbours`), а не по расстоянию.

    Это проверка того, что увидит игра: провод появляется только там, где он есть
    в чертеже. Геометрическая близость (`pole_components` в генераторе) отвечает
    на другой вопрос — дотянется ли провод, если его прописать.
    """
    poles = pole_tiles(obj, geometry)
    by_number = {pole["number"]: pole for pole in poles}
    parent = {pole["number"]: pole["number"] for pole in poles}

    def find(number: int) -> int:
        while parent[number] != number:
            parent[number] = parent[parent[number]]
            number = parent[number]
        return number

    for pole in poles:
        for neighbour in pole["entity"].get("neighbours") or []:
            if neighbour not in by_number:
                continue
            ra, rb = find(pole["number"]), find(neighbour)
            if ra != rb:
                parent[ra] = rb
    groups: dict[int, list[dict]] = {}
    for pole in poles:
        groups.setdefault(find(pole["number"]), []).append(pole)
    return sorted(groups.values(), key=len, reverse=True)


def device_kind(entity_name: str, geometry: dict | None = None) -> str:
    """Что это за устройство переноса: "inserter", "loader" или ""."""
    rec = entity_record(entity_name or "", geometry) or {}
    etype = str(rec.get("type") or "")
    if etype == "inserter":
        return "inserter"
    if etype.startswith("loader"):
        return "loader"
    return ""


def device_flow(entity: dict, geometry: dict | None = None) -> dict | None:
    """Откуда и куда переносит предметы это устройство.

    Манипулятор: направление — «откуда берёт»; вектор прототипа (pickup [0,-1],
    insert [0,1]) поворачивается вместе с ним, так что направление 12 (запад) берёт
    с запада и кладёт на восток.

    Погрузчик: направление — «куда везёт»; берёт с тайла за спиной, кладёт в тайл перед
    собой. На входе (лента западнее, завод восточнее) он стоит с direction 4 и
    type "input", на выходе (завод западнее, лента восточнее) — direction 4 и
    type "output". Для того же переноса число противоположно манипулятору.
    """
    t = tiles_of(entity, geometry)
    if not t:
        return None
    left, top, w, h = t
    own_tile = (left + (w - 1) // 2, top + (h - 1) // 2)
    direction = int(entity.get("direction") or 0)
    kind = device_kind(entity.get("name") or "", geometry)
    if kind == "loader":
        step = DIRECTION_STEPS.get(direction)
        if step is None:
            return None
        # Берёт сзади, кладёт вперёд.
        return {"kind": kind, "tile": own_tile, "direction": direction,
                "pickup": (own_tile[0] - step[0], own_tile[1] - step[1]),
                "insert": (own_tile[0] + step[0], own_tile[1] + step[1])}
    if kind != "inserter":
        return None
    rec = entity_record(entity.get("name") or "", geometry) or {}
    ins = rec.get("inserter") or {}
    # Мод (bobinserters) умеет ЛЮБОМУ манипулятору задать забор подальше, и в
    # блюпринте это лежит полями pickup_position / insert_position. Если они
    # есть — верим им, а не прототипу: иначе проверка соврёт.
    # Поля из блюпринта уже в координатах карты — их НЕ поворачиваем, а вектор
    # прототипа задан «лицом на север» и поворачивается вместе с манипулятором.
    own_pickup = entity.get("pickup_position")
    own_insert = entity.get("insert_position")
    pickup_vec = own_pickup or ins.get("pickup") or [0, -1]
    insert_vec = own_insert or ins.get("insert") or [0, 1]
    pdx, pdy = (float(pickup_vec[0]), float(pickup_vec[1])) if own_pickup else \
        rotate_vec((float(pickup_vec[0]), float(pickup_vec[1])), direction)
    idx, idy = (float(insert_vec[0]), float(insert_vec[1])) if own_insert else \
        rotate_vec((float(insert_vec[0]), float(insert_vec[1])), direction)
    return {"kind": kind, "tile": own_tile, "direction": direction,
            "pickup": (own_tile[0] + int(round(pdx)), own_tile[1] + int(round(pdy))),
            "insert": (own_tile[0] + int(round(idx)), own_tile[1] + int(round(idy)))}


def inserter_report(obj: dict, geometry: dict | None = None) -> list[dict]:
    """Что стоит на заборе и на выгрузке у каждого манипулятора И ПОГРУЗЧИКА.

    Дальность берётся из геометрии (pickup/insert), поэтому длинная рука
    (2 тайла) отличается от обычной корректно, а не «на глазок». У погрузчика
    направление читается наоборот (см. device_flow) — иначе проверка считала бы,
    что он берёт из завода и кладёт на ленту, то есть не заметила бы вывернутое
    направление.
    """
    bp = blueprint_of(obj)
    entities = list(bp.get("entities") or [])
    index = _index_by_tile(entities, geometry)
    out = []
    for ent in entities:
        flow = device_flow(ent, geometry)
        if not flow:
            continue
        pickup, insert = flow["pickup"], flow["insert"]
        out.append({
            "entity": ent.get("name"),
            "kind": flow["kind"],
            "tile": flow["tile"],
            "direction": flow["direction"],
            "side": DIRECTIONS.get(flow["direction"], f"направление {flow['direction']}"),
            "pickup": pickup,
            "pickup_has": sorted({e.get("name") for e in index.get(pickup, [])}),
            "insert": insert,
            "insert_has": sorted({e.get("name") for e in index.get(insert, [])}),
        })
    return out


# --------------------------------------------------------------------------
# разбор «по-человечески»
# --------------------------------------------------------------------------
def item_name(value) -> str:
    """Название предмета из записи блюпринта.

    В 1.1 поле `id` было строкой, в 2.0 это объект {"name": ..., "quality": ...}
    (качество появилось вместе с ним), поэтому поддерживаем оба вида.
    """
    if isinstance(value, dict):
        name = value.get("name") or "?"
        quality = value.get("quality")
        if quality and quality != "normal":
            return f"{name} ({quality})"
        return str(name)
    return str(value)


def entity_modules(entity: dict) -> dict:
    """Модули в постройке: {название: количество}.

    Формат игры менялся, поэтому читаем оба вида:
      * 1.1: "items": [{"id": "speed-module", "items_in_inventory": 2}]
      * 2.0: "items": [{"id": {"name": "moondrop"}, "items": {"in_inventory": [
              {"inventory": 4, "stack": 0}, ...]}}] — по одной записи на модуль.
    """
    out: dict = {}
    for item in entity.get("items") or []:
        if not isinstance(item, dict):
            continue
        name = item_name(item.get("id"))
        count = item.get("items_in_inventory")
        if count is None:
            inner = item.get("items")
            if isinstance(inner, dict):
                slots = inner.get("in_inventory")
                if isinstance(slots, list):
                    count = len(slots)
        if count is None:
            count = 0
        out[name] = max(out.get(name, 0), int(count))
    return out


BELT_ARROWS = {0: "^", 4: ">", 8: "v", 12: "<"}


def render_ascii(obj: dict, geometry: dict | None = None, max_width: int = 150) -> str:
    """Карта блюпринта символами — чтобы глазами увидеть, что где стоит.

    Символы: M — завод (печи, лаборатории и т.п.), ^>v< — лента (стрелка =
    куда едет), U — подземная лента, S — сплиттер, L — погрузчик, i — манипулятор,
    p — труба, Г — подземная труба, + — столб, ? — что-то ещё.
    Под картой — расшифровка: заводы с рецептами, ленты-«головы» и хвосты,
    манипуляторы с направлением.
    """
    entities = iter_entities(obj)
    records = entity_records(geometry)
    cells: dict = {}
    legend_machines = []
    ins = []

    for ent in entities:
        name = ent.get("name") or "?"
        rec = records.get(name) or {}
        t = tiles_of(ent, geometry)
        if not t:
            continue
        left, top, w, h = t
        etype = rec.get("type")
        direction = int(ent.get("direction") or 0)
        if etype in MACHINE_TYPES:
            char = "M"
            legend_machines.append((left, top, w, h, name, ent.get("recipe"), entity_modules(ent)))
        elif etype == "transport-belt":
            char = BELT_ARROWS.get(direction, "?")
        elif etype == "underground-belt":
            char = "U"
        elif etype in ("splitter", "lane-splitter"):
            char = "S"
        elif etype in ("loader", "loader-1x1"):
            char = "L"
        elif etype == "inserter":
            char = "i"
            ins.append((left, top, name, DIRECTIONS.get(direction, str(direction))))
        elif etype == "pipe":
            char = "p"
        elif etype == "pipe-to-ground":
            char = "Г"
        elif etype == "electric-pole":
            char = "+"
        else:
            char = "?"
        for x in range(left, left + w):
            for y in range(top, top + h):
                cells[(x, y)] = char if char != "M" else "M"

    if not cells:
        return "(пусто)"
    xs = [c[0] for c in cells]
    ys = [c[1] for c in cells]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    if x1 - x0 + 1 > max_width:
        x1 = x0 + max_width - 1

    header = "    " + "".join(str((x // 10) % 10) for x in range(x0, x1 + 1))
    lines = [header, "    " + "".join(str(x % 10) for x in range(x0, x1 + 1))]
    for y in range(y0, y1 + 1):
        row = "".join(cells.get((x, y), " ") for x in range(x0, x1 + 1))
        lines.append(f"{y:4d}{row}")

    lines.append("")
    lines.append(f"Размер: {x1 - x0 + 1} x {y1 - y0 + 1} тайлов; тайлы (лево,верх)=({x0},{y0})")
    if legend_machines:
        lines.append("Заводы (тайлы, имя, рецепт, модули):")
        for left, top, w, h, name, recipe, mods in sorted(legend_machines):
            mod_text = ", ".join(f"{k} x{v}" for k, v in sorted(mods.items())) or "без модулей"
            lines.append(f"  ({left:4d},{top:4d}) {w}x{h} {name} рецепт={recipe} [{mod_text}]")
    if ins:
        by_dir: dict = {}
        for left, top, name, side in ins:
            by_dir.setdefault((name, side), []).append((left, top))
        lines.append("Манипуляторы:")
        for (name, side), tiles in sorted(by_dir.items()):
            lines.append(f"  {len(tiles):3d} x {name} смотрят {side}: {tiles[:6]}{' ...' if len(tiles) > 6 else ''}")
    return "\n".join(lines)


def preview_data(obj: dict, geometry: dict | None = None) -> dict:
    """Данные для картинки раскладки на странице: что где стоит, без лишнего.

    Каждая постройка — одна запись [вид, лево, верх, ширина, высота, куда, имя,
    рецепт]. Вид: machine, belt, underground, splitter, loader, inserter, pipe,
    pipe-ground, pole, other. «Куда» — шаг в тайлах (dx, dy) вдоль потока: у ленты
    она едет туда, у манипулятора и погрузчика туда они кладут (берут с обратной
    стороны), у остальных None. Размеры и вид берутся из геометрии построек, поэтому
    картинка рисуется по тем же правилам, что и проверки блюпринта.
    """
    entities = iter_entities(obj)
    records = entity_records(geometry)
    items: list = []
    for ent in entities:
        name = ent.get("name") or "?"
        t = tiles_of(ent, geometry)
        if not t:
            continue
        left, top, w, h = t
        etype = (records.get(name) or {}).get("type")
        direction = int(ent.get("direction") or 0)
        flow = None
        if etype in MACHINE_TYPES:
            kind = "machine"
        elif etype == "transport-belt":
            kind, flow = "belt", DIRECTION_STEPS.get(direction)
        elif etype == "underground-belt":
            kind, flow = "underground", DIRECTION_STEPS.get(direction)
        elif etype in ("splitter", "lane-splitter"):
            kind, flow = "splitter", DIRECTION_STEPS.get(direction)
        elif etype in ("loader", "loader-1x1", "inserter"):
            kind = "loader" if etype != "inserter" else "inserter"
            moved = device_flow(ent, geometry)
            if moved:
                own = moved["tile"]
                ins_tile = moved["insert"]
                flow = (max(-1, min(1, ins_tile[0] - own[0])), max(-1, min(1, ins_tile[1] - own[1])))
        elif etype == "pipe":
            kind = "pipe"
        elif etype == "pipe-to-ground":
            # устье подземной трубы смотрит по direction, туннель — в обратную сторону
            kind = "pipe-ground"
            step = DIRECTION_STEPS.get(direction)
            flow = (-step[0], -step[1]) if step else None
        elif etype == "electric-pole":
            kind = "pole"
        elif etype in ("straight-rail", "legacy-straight-rail", "curved-rail-a", "curved-rail-b",
                       "legacy-curved-rail", "half-diagonal-rail"):
            kind = "rail"
        elif etype == "train-stop":
            kind = "stop"
        elif etype in ("container", "logistic-container"):
            kind = "warehouse"
        else:
            kind = "other"
        items.append([kind, left, top, w, h, list(flow) if flow else None, name, ent.get("recipe")])
    if not items:
        return {"x0": 0, "y0": 0, "width": 0, "height": 0, "items": []}
    x0 = min(i[1] for i in items)
    y0 = min(i[2] for i in items)
    x1 = max(i[1] + i[3] for i in items)
    y1 = max(i[2] + i[4] for i in items)
    return {"x0": x0, "y0": y0, "width": x1 - x0, "height": y1 - y0, "items": items}


def belt_lines(obj: dict, geometry: dict | None = None) -> list[dict]:
    """Непрерывные линии лент: где начинается, куда едет, что на неё кладут/берут.

    Линия — это ряд соседних лент одного направления (включая подземные и
    сплиттеры, которые считаются частью линии). Для каждой линии считаем, какие
    манипуляторы с неё ЗАБИРАЮТ (значит она входная) и какие на неё КЛАДУТ
    (значит выходная).
    """
    entities = iter_entities(obj)
    records = entity_records(geometry)
    belt_types = {"transport-belt", "underground-belt", "splitter", "lane-splitter", "linked-belt"}
    tiles: dict = {}
    for ent in entities:
        rec = records.get(ent.get("name") or "") or {}
        if rec.get("type") not in belt_types:
            continue
        t = tiles_of(ent, geometry)
        if not t:
            continue
        for x in range(t[0], t[0] + t[2]):
            tiles[(x, t[1])] = int(ent.get("direction") or 0)

    runs: list[dict] = []
    used: set = set()
    for start in sorted(tiles):
        if start in used:
            continue
        direction = tiles[start]
        vertical = direction in (0, 8)
        run = [start]
        used.add(start)
        step = (0, 1) if (vertical and direction == 8) else (0, -1) if vertical else (1, 0) if direction == 4 else (-1, 0)
        # растём в обе стороны по прямой
        for sign in (1, -1):
            cur = start
            while True:
                nxt = (cur[0] + step[0] * sign, cur[1] + step[1] * sign)
                if nxt in tiles and nxt not in used and tiles[nxt] == direction:
                    run.append(nxt)
                    used.add(nxt)
                    cur = nxt
                else:
                    break
        xs = sorted(p[0] for p in run)
        ys = sorted(p[1] for p in run)
        runs.append({
            "tiles": len(run),
            "direction": direction,
            "vertical": vertical,
            "from": (xs[0], ys[0]),
            "to": (xs[-1], ys[-1]),
            "cells": set(run) if vertical else {(x, ys[0]) for x in range(xs[0], xs[-1] + 1)},
        })

    for run in runs:
        run["picked_from"] = []
        run["dropped_to"] = []
    for row in inserter_report(obj, geometry):
        for run in runs:
            if row["pickup"] in run["cells"]:
                run["picked_from"].append(row["entity"])
            if row["insert"] in run["cells"]:
                run["dropped_to"].append(row["entity"])
    runs.sort(key=lambda r: (not r["vertical"], r["from"][1], r["from"][0]))
    return runs


def machine_grid(obj: dict, geometry: dict | None = None) -> dict:
    """Сетка заводов: столбцы, ряды и шаг между заводами."""
    machines = []
    for ent in iter_entities(obj):
        rec = entity_record(ent.get("name") or "", geometry) or {}
        if rec.get("type") not in MACHINE_TYPES:
            continue
        t = tiles_of(ent, geometry)
        if not t:
            continue
        machines.append({"name": ent.get("name"), "tiles": t, "recipe": ent.get("recipe"),
                         "modules": entity_modules(ent)})
    machines.sort(key=lambda m: (m["tiles"][1], m["tiles"][0]))
    cols: list = []
    rows: list = []
    for m in machines:
        left, top, w, h = m["tiles"]
        if not any(c["left"] == left for c in cols):
            cols.append({"left": left, "width": w, "count": 0, "tops": []})
        for c in cols:
            if c["left"] == left:
                c["count"] += 1
                c["tops"].append(top)
        if not any(r["top"] == top for r in rows):
            rows.append({"top": top, "height": h, "count": 0})
        for r in rows:
            if r["top"] == top:
                r["count"] += 1
    cols.sort(key=lambda c: c["left"])
    rows.sort(key=lambda r: r["top"])
    pitches_x = [cols[i + 1]["left"] - cols[i]["left"] for i in range(len(cols) - 1)]
    pitches_y = [rows[i + 1]["top"] - rows[i]["top"] for i in range(len(rows) - 1)]
    return {"machines": machines, "cols": cols, "rows": rows,
            "pitch_x": pitches_x, "pitch_y": pitches_y}


def layout_summary(obj: dict, geometry: dict | None = None) -> str:
    """Короткое описание раскладки: сетка заводов, ленты (вход/выход), трубы."""
    grid = machine_grid(obj, geometry)
    runs = belt_lines(obj, geometry)
    lines = [f"Заводов: {len(grid['machines'])}"]
    if grid["machines"]:
        first = grid["machines"][0]
        lines.append(f"  сетка: столбцов {len(grid['cols'])}, рядов {len(grid['rows'])}, "
                     f"завод {first['tiles'][2]}x{first['tiles'][3]}, "
                     f"шаг по x {grid['pitch_x']}, по y {grid['pitch_y']}")
        if first["recipe"]:
            mods = ", ".join(f"{k} x{v}" for k, v in sorted(first["modules"].items())) or "без модулей"
            lines.append(f"  рецепт: {first['recipe']} [{mods}]")
    lines.append("Линии лент:")
    for run in runs:
        kind = []
        if run["picked_from"]:
            kind.append(f"с неё берут ({len(run['picked_from'])} манип.) — входная")
        if run["dropped_to"]:
            kind.append(f"на неё кладут ({len(run['dropped_to'])} манип.) — выходная")
        arrow = DIRECTIONS.get(run["direction"], str(run["direction"]))
        where = f"x {run['from'][0]}..{run['to'][0]} на y={run['from'][1]}" if not run["vertical"] \
            else f"y {run['from'][1]}..{run['to'][1]} на x={run['from'][0]}"
        lines.append(f"  {run['tiles']:3d} тайлов, едет на {arrow}: {where}"
                     + (f" — {'; '.join(kind)}" if kind else " — манипуляторов нет"))
    rep = fluid_report(obj, geometry)
    if rep["connected"] or rep["free"] or rep["underground"]:
        lines.append(f"Трубы: подключено {len(rep['connected'])}, под землёй {len(rep['underground'])}, "
                     f"свободно {len(rep['free'])}")
        for entry in rep["free"][:6]:
            lines.append(f"  свободен {entry['production'] or entry['flow']} "
                         f"{entry['entity']} ({entry['side']}), тайл подхода {entry['approach_tile']}")
    return "\n".join(lines)


def pipe_network_report(obj: dict, geometry: dict | None = None) -> dict:
    """Проверяет, что трубы действительно образуют одну сеть и доходят до заводов.

    Считает так же, как игра: обычная труба соединяется с соседями по четырём
    сторонам; подземная труба соединяется с соседями со стороны своего устья и
    со второй подземной трубой, стоящей на той же линии не дальше
    max_underground_distance. Затем ищет компоненты связности и смотрит, попал ли
    тайл подхода к каждой трубке завода в ту же сеть, что и концы линий.
    """
    entities = iter_entities(obj)
    records = entity_records(geometry)

    kind: dict = {}
    for ent in entities:
        rec = records.get(ent.get("name") or "") or {}
        etype = rec.get("type")
        t = tiles_of(ent, geometry)
        if not t:
            continue
        tile = (t[0], t[1])
        if etype == "pipe":
            kind[tile] = ("pipe", int(ent.get("direction") or 0))
        elif etype == "pipe-to-ground":
            kind[tile] = ("ground", int(ent.get("direction") or 0))
        elif etype in ("infinity-pipe", "valve"):
            kind[tile] = ("pipe", int(ent.get("direction") or 0))

    parent: dict = {tile: tile for tile in kind}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for tile, (k, direction) in kind.items():
        if k == "pipe":
            for dx, dy in ((0, -1), (0, 1), (-1, 0), (1, 0)):
                nb = (tile[0] + dx, tile[1] + dy)
                if nb in kind:
                    union(tile, nb)
        else:
            # устье подземной трубы смотрит в сторону direction, туннель — в обратную
            dx, dy = DIR_VECTORS.get(direction, (0, 0))
            surface = (tile[0] + dx, tile[1] + dy)
            if surface in kind:
                union(tile, surface)
            tdx, tdy = -dx, -dy
            max_len = 20
            rec_tile = None
            for ent in entities:
                if (records.get(ent.get("name") or "") or {}).get("type") == "pipe-to-ground":
                    tt = tiles_of(ent, geometry)
                    if tt and (tt[0], tt[1]) == tile:
                        rec_tile = ent
            if rec_tile is not None:
                rec = records.get(rec_tile.get("name") or "") or {}
                for box in rec.get("fluids") or []:
                    for conn in box.get("pipes") or []:
                        if conn.get("type") == "underground" and conn.get("max_underground"):
                            max_len = conn["max_underground"]
            # туннель идёт под землёй и проходит под всем, что стоит наверху,
            # поэтому ищем только вторую подземную трубу с встречным направлением
            for step in range(1, int(max_len) + 1):
                probe = (tile[0] + tdx * step, tile[1] + tdy * step)
                pk = kind.get(probe)
                if pk is None:
                    continue
                if pk[0] == "ground":
                    pdx, pdy = DIR_VECTORS.get(pk[1], (0, 0))
                    if (pdx, pdy) == (tdx, tdy):
                        union(tile, probe)
                        break

    components: dict = {}
    for tile in kind:
        components.setdefault(find(tile), []).append(tile)

    status = []
    for ent in entities:
        rec = records.get(ent.get("name") or "") or {}
        if rec.get("type") not in MACHINE_TYPES:
            continue
        conns = fluid_connections(ent, geometry)
        for conn in conns:
            approach = conn["approach_tile"]
            if conn["kind"] == "underground":
                continue
            owner = find(approach) if approach in kind else None
            endpoints = sorted(components.get(owner, [])) if owner else []
            status.append({
                "entity": ent.get("name"),
                "tile": conn["machine_tile"],
                "approach": approach,
                "production": conn["production"],
                "filter": conn.get("filter"),
                "connected": owner is not None,
                "network_size": len(endpoints),
                "network_ends": [endpoints[0], endpoints[-1]] if endpoints else [],
            })
    return {"components": {k: sorted(v) for k, v in components.items()},
            "network_count": len(components),
            "connections": status}


def describe(obj: dict, geometry: dict | None = None, entities_limit: int = 12) -> str:
    """Короткий разбор блюпринта по-русски — чтобы сверить понимание."""
    label = blueprint_of(obj).get("label") or obj.get("blueprint_book", {}).get("label") or ""
    entities = iter_entities(obj)
    records = entity_records(geometry)
    lines = []
    head = f"Блюпринт {('«' + label + '» ') if label else ''}— сущностей: {len(entities)}"
    lines.append(head)

    counts: dict = {}
    for ent in entities:
        counts[ent.get("name") or "?"] = counts.get(ent.get("name") or "?", 0) + 1
    for name, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:entities_limit]:
        rec = records.get(name) or {}
        extra = []
        size = rec.get("size")
        if size:
            extra.append(f"{size[0]}x{size[1]}")
        if rec.get("type"):
            extra.append(rec["type"])
        lines.append(f"  {count:3d} x {name} ({', '.join(extra)})")
    if len(counts) > entities_limit:
        lines.append(f"  ... и ещё {len(counts) - entities_limit} видов")

    machines = [e for e in entities if e.get("recipe")]
    if machines:
        by_recipe: dict = {}
        for m in machines:
            key = (m.get("name"), m.get("recipe"))
            by_recipe[key] = by_recipe.get(key, 0) + 1
        lines.append("Рецепты:")
        for (name, recipe), count in sorted(by_recipe.items()):
            items: dict = {}
            for m in machines:
                if m.get("name") != name or m.get("recipe") != recipe:
                    continue
                for mod_name, mod_count in entity_modules(m).items():
                    items[mod_name] = max(items.get(mod_name, 0), mod_count)
            mod_note = ""
            if items:
                mod_note = " модули: " + ", ".join(f"{k} x{v}" for k, v in sorted(items.items()))
            lines.append(f"  {count:3d} x {name}: {recipe}{mod_note}")

    rep = fluid_report(obj, geometry)
    if rep["connected"] or rep["free"] or rep["underground"]:
        lines.append(f"Трубы: подключено {len(rep['connected'])}, "
                     f"под землёй {len(rep['underground'])}, "
                     f"свободно {len(rep['free'])}")
        for entry in rep["free"][:8]:
            lines.append(f"  свободен вход/выход {entry['entity']} "
                         f"({entry['production'] or entry['flow']}, {entry['side']}), "
                         f"тайл подхода {entry['approach_tile']}")

    ins = inserter_report(obj, geometry)
    empty = [i for i in ins if not i["pickup_has"] or not i["insert_has"]]
    if ins:
        # Считаем и погрузчики: для них «пустая сторона» читается наоборот (берёт
        # сзади, кладёт вперёд), и про них в отчёте честнее сказать отдельно.
        loaders = [i for i in ins if i["kind"] == "loader"]
        label = "Манипуляторы и погрузчики" if loaders else "Манипуляторы"
        tail = f" (из них погрузчиков: {len(loaders)})" if loaders else ""
        lines.append(f"{label}: {len(ins)}{tail}, из них с пустой стороной: {len(empty)}")
        for i in empty[:6]:
            problem = []
            if not i["pickup_has"]:
                problem.append(f"забирает из пустоты {i['pickup']}")
            if not i["insert_has"]:
                problem.append(f"кладёт в пустоту {i['insert']}")
            lines.append(f"  {i['entity']} на {i['tile']} смотрит {i['side']}: " + ", ".join(problem))

    problems = validate(obj, geometry)
    if problems:
        lines.append(f"Замечания ({len(problems)}):")
        for p in problems[:10]:
            lines.append(f"  [{p['level']}] {p['text']}")
    else:
        lines.append("Замечаний нет.")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# сдвиг блюпринта
# --------------------------------------------------------------------------
def translate(obj: dict, dx_tiles: float = 0.0, dy_tiles: float = 0.0) -> dict:
    """Копия блюпринта, сдвинутая на (dx, dy) тайлов."""
    data = json.loads(json.dumps(obj))
    for ent in iter_entities(data):
        pos = ent.setdefault("position", {})
        pos["x"] = _snap(float(pos.get("x", 0.0)) + dx_tiles)
        pos["y"] = _snap(float(pos.get("y", 0.0)) + dy_tiles)
    return data


def load_template_files(path: str | Path) -> list[dict]:
    """Читает блюпринты из папки или файла.

    Поддерживаются оба вида:
      * .txt — одна строка блюпринта (можно несколько строк в файле: строки,
        начинающиеся с "0", считаются блюпринтами);
      * .json — либо строка, либо массив {"from": ..., "string": ...},
        либо сырой JSON блюпринта.

    Возвращает список {from, string}, где from — имя файла (и номер, если
    блюпринтов в файле несколько).
    """
    out: list[dict] = []
    files: list[Path] = []
    path = Path(path)
    if path.is_dir():
        files = sorted(p for p in path.iterdir() if p.suffix.lower() in (".txt", ".json", ""))
    elif path.is_file():
        files = [path]
    for f in files:
        text = f.read_text(encoding="utf-8").strip()
        if not text:
            continue
        if f.suffix.lower() == ".json":
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, list):
                for i, item in enumerate(parsed):
                    src = item.get("from", "") if isinstance(item, dict) else ""
                    string = item.get("string") if isinstance(item, dict) else item
                    out.append({"from": f"{f.name}[{i}] {src}".strip(), "string": string})
                continue
            if isinstance(parsed, dict):
                out.append({"from": f.name, "string": json.dumps(parsed, ensure_ascii=False)})
                continue
        # обычный текст: каждая строка, начинающаяся с "0", — отдельный блюпринт
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("0") and len(line) > 20:
                out.append({"from": f.name, "string": line})
    return out


def main(argv: list[str]) -> int:
    import sys

    if len(argv) < 2:
        print(__doc__)
        return 2

    path = Path(argv[1])
    if path.is_dir() or path.is_file():
        templates = load_template_files(path)
        if not templates:
            print(f"В {path} не нашлось ни одного блюпринта (.txt со строкой или .json)")
            return 1
        for i, item in enumerate(templates):
            print(f"=== [{i}] {item['from']}")
            try:
                obj = decode_json(item["string"])
            except Exception as exc:  # noqa: BLE001 — показываем, что именно не так
                print(f"  не разобралось: {exc}\n")
                continue
            print(describe(obj))
            print()
        return 0

    # иначе это сама строка блюпринта
    print(describe(decode_json(argv[1])))
    return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv))
