"""Генератор раскладки блюпринтов по заготовкам пользователя.

Первая (и пока единственная) раскладка — «шаблон 1» из templates/bp.txt: один
ряд заводов, входная лента сверху, выходная снизу, по одному манипулятору на
завод с каждой стороны, столбы в свободных тайлах нижнего ряда.

Как это выглядит в тайлах (W — ширина завода, H — высота, N — сколько заводов):

    y = -2      входная лента, едет на ВОСТОК (предметы приходят с запада)
    y = -1      манипуляторы: берут с севера (лента), кладут на юг (в завод)
    y = 0..H-1  ряд заводов вплотную (шаг = W)
    y = H       манипуляторы: берут с севера (из завода), кладут на юг (на ленту)
    y = H+1     выходная лента, едет на ЗАПАД

Столбы ставятся в ряд манипуляторов (y = H) в свободные тайлы с шагом по зоне
питания, а если там не хватило места — в ряд входных манипуляторов (y = -1).

Почему именно так: это ровно та раскладка, которую пользователь собрал руками
для скринера (см. templates/bp.txt, первый блюпринт), и она проверяется тестом
tests/test_blueprint_gen.py — сравнением с его же заготовкой.

Запуск для примера:

    python app\\blueprint_gen.py automated-screener-mk01 coarse-coal 5 ^
        --belt fast-transport-belt --inserter-in burner-inserter ^
        --inserter-out bob-red-inserter --pole bob-medium-electric-pole-2
"""
from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass, field, replace
from pathlib import Path

import blueprint as bp
import langtr

# Версия блюпринта, которой пишет игра 2.0.77 (взято из блюпринта пользователя).
BLUEPRINT_VERSION = 562949958467584

# Инвентарь модулей у завода: в блюпринтах игры это inventory = 4
# (defines.inventory.crafter_modules), проверено на заготовках пользователя.
CRAFTER_MODULES_INVENTORY = 4

# Сколько тайлов ленты оставить «на улицу» с каждого конца ряда.
DEFAULT_STUB = 3

# Отступ между РЯДАМИ групп в одном блоке. Человек собирает этап не одной длинной
# полосой, а несколькими рядами (см. BlockSpec.row_groups), и между рядами должно
# остаться место пройти: 10 тайлов.
ROW_GAP = 10


@dataclass
class BlockSpec:
    """Что именно построить: ряд из count заводов с одним рецептом."""

    machine: str
    count: int
    recipe: str | None = None
    modules: dict = field(default_factory=dict)  # {название модуля: сколько}
    # Сколько лент подачи ставить (None — посчитать по рецепту)
    input_belts: int | None = None
    # Длиннорукий манипулятор (достаёт дальнюю ленту); пусто — найдём сами
    inserter_long: str | None = None
    # Сколько заводов в КАЖДОЙ группе (как их посчитал калькулятор, например
    # графит: 17+17+17+17+16+16). Пусто — один ряд длиной count.
    groups: list | None = None
    # Сколько ГРУПП в каждом РЯДУ блока: [5, 5, 5] — три ряда по пять групп.
    # Пусто — все группы в один ряд (как было). Сумма обязана совпасть с числом
    # групп, иначе этап потерял бы часть заводов — это ошибка, а не «на глазок».
    row_groups: list | None = None
    belt: str = "transport-belt"
    inserter_in: str = "inserter"
    inserter_out: str = "inserter"
    # Сколько манипуляторов нужно НА ОДИН СТАНОК с каждой стороны. Медленный
    # манипулятор один поток не вытягивает (механический тянет ~2/с, а заводу
    # бывает нужно больше), и тогда в чертёж ставятся все нужные. Считает это
    # сайт — по таблице «пачка и скорость» — и присылает числом.
    inserter_in_count: int = 1
    inserter_out_count: int = 1
    # Вход ПО ЛЕНТАМ: [{"name": "mdrn-loader", "count": 1}, ...] — у каждой ленты
    # свой манипулятор и своё число, порядок от ближней ленты к дальней. Сайт
    # считает ленты отдельно («Манипуляторы на вход (лента: …)» в карточке), и
    # одному входу с двумя лентами одного имени мало: на одной стоит погрузчик, на
    # другой механический манипулятор. Пусто — старый формат: одно имя и одно число
    # на весь вход (тогда дальняя лента берётся тем же именем с вылетом на 2 тайла).
    inserter_in_rows: list | None = None
    pole: str | None = None
    stub: int = DEFAULT_STUB
    label: str = ""
    # Куда едет лента выгрузки относительно лент подачи:
    #   "same"    — в ту же сторону, что подача (и то, и другое подключается
    #               с одного конца блока) — по умолчанию;
    #   "opposite" — в другую сторону (как было раньше: подача на север,
    #               выгрузка на юг).
    belt_sides: str = "same"
    # Резервировать ли тайлы под газ/жидкость (трубы не ставим — их проводит
    # пользователь, но тайл обязан остаться свободным).
    reserve_fluid_tiles: bool = True
    # Маяков здесь НЕТ и не будет: в раскладке блока ставятся только заводы, ленты,
    # манипуляторы и столбы. Маяки игрок ставит сам, а сайт считает их в двух
    # местах — в подсчёте заводов (эффект) и в сундуке запроса (сколько купить).
    dataset_id: str | None = None


def machine_is_craftable(machine: str | None, dataset_id: str | None = None) -> bool | None:
    """Можно ли вообще получить этот завод: False — только скрытым рецептом.

    Правило самой игры: `hidden` в рецепте значит «в меню крафта этого нет». В Py так
    скрыт ванильный химический завод: он есть в дампе, подходит под «химию», и расчёт
    молча брал именно его — а игроку его не скрафтить (жалоба: «в блю принт попал
    обычный хим завод, а не который выбран МК1»).

    Возвращает True, если хоть один рецепт-постановщик обычный (построить можно),
    False — если все найденные скрытые, None — рецепта в дампе нет вовсе (не судим).
    Тот же смысл у machineBuildable в public/js/app.js.
    """
    path = dataset_path(dataset_id)
    if not path or not machine:
        return None
    import json as _json

    with path.open(encoding="utf-8") as f:
        data = _json.load(f)
    items = data.get("items") or {}
    placing = {name for name, item in items.items()
               if isinstance(item, dict) and item.get("place_result") == machine}
    if not placing:
        return None
    judged = False
    for rec in (data.get("recipes") or {}).values():
        if not isinstance(rec, dict) or rec.get("parameter"):
            continue
        if not any((p or {}).get("name") in placing for p in (rec.get("products") or [])):
            continue
        judged = True
        if not rec.get("hidden"):
            return True          # обычный рецепт есть — завод построить можно
    return False if judged else None   # только скрытые рецепты — не скрафтить


def machine_craft_note(machine: str | None, dataset_id: str | None = None) -> str | None:
    """Замечание для описания чертежа: завод в игре не скрафтить.

    Чертёж уезжает в игру строкой, поэтому сказать об этом надо В САМОМ ЧЕРТЕЖЕ, а не
    только в карточке на сайте: иначе игрок узнаёт о проблеме, уже поставив постройку.
    """
    if machine_is_craftable(machine, dataset_id) is not False:
        return None
    label = machine
    path = dataset_path(dataset_id)
    if path:
        import json as _json

        with path.open(encoding="utf-8") as f:
            data = _json.load(f)
        entity = (data.get("entities") or {}).get(machine) or {}
        label = entity.get("display_name") or machine
        if label != machine:
            label = f"{label} ({machine})"
    return (f"завод {label} в игре не скрафтить (его рецепт скрыт) — "
            f"выбери в карточке этапа завод, который строится")


def device_is_loader(name: str | None, geometry: dict | None = None) -> bool:
    """Это погрузчик, а не манипулятор? Тип берём из геометрии, не из имени."""
    return bp.device_kind(name or "", geometry) == "loader"


def device_place(name: str, direction: int, geometry: dict | None = None,
                 loader_type: str | None = None) -> tuple[int, str | None]:
    """Направление и поле `type` для устройства на этой стороне.

    У МАНИПУЛЯТОРА направление значит «откуда берёт»: 12 (запад) — берёт с запада
    и кладёт на восток. У ПОГРУЗЧИКА — «куда везёт»: он берёт с тайла за спиной и
    кладёт вперёд, поэтому то же число означало бы, что он везёт продукт из завода
    на ленту, то есть на ВЫГРУЗКУ (жалоба игрока: «погрузчик направлен на выгрузку,
    хотя стоит со стороны погрузки»).

    Проверено по чертежам самого игрока: на входе (лента западнее, завод восточнее)
    погрузчик стоит с direction 4 и type "input", на выходе (завод западнее, лента
    восточнее) — тоже direction 4, но type "output". Значит для погрузчика
    направление — ровно наоборот к манипулятору, а роль пишется полем `type`.
    """
    if not device_is_loader(name, geometry):
        return direction, None
    return (direction + 8) % 16, loader_type


def inserter_belt_plan(rows, belts: int) -> list[dict]:
    """Ленты подачи со СВОИМИ манипуляторами: чистим мусор и режем по числу лент.

    Одна запись = одна лента, порядок — от ближней ленты к дальней. Лент в блоке
    помещается не больше двух (см. supply_belt_count), поэтому лишние записи
    отбрасываем: про них уже сказано припиской в описании чертежа.
    """
    plan: list[dict] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        try:
            count = max(1, int(row.get("count") or 1))
        except (TypeError, ValueError):
            count = 1
        plan.append({"name": name, "count": count})
    limit = max(0, int(belts or 0))
    return plan[:limit]


def inserter_reaches_far_belt(name: str, geometry: dict | None = None) -> bool:
    """Достаёт ли устройство до ДАЛЬНЕЙ ленты (через соседнюю).

    Манипулятор — да: сайт ставит ему вылет на 2 тайла (`pickup_position`, это
    умеет bobinserters), и недлиннорукому тоже. Погрузчик — не манипулятор: он
    соединяет две СОСЕДНИЕ постройки, поэтому вторая лента для него недостижима.
    """
    rec = bp.entity_record(name, geometry) or {}
    return rec.get("type") == "inserter"


def order_belts_for_reach(plan: list[dict], geometry: dict | None = None,
                          notes: list | None = None) -> list[dict]:
    """Дальняя лента — та, до которой устройство ДОСТАЁТ.

    Ленты равнозначны: каждая везёт своё и подключается снаружи, поэтому устройства
    можно просто поменять местами — погрузчик на ближнюю ленту, манипулятор на
    дальнюю. Если не достаёт ни одно (две ленты и на обеих погрузчики), честно
    пишем это в описании, а не делаем вид, что дальняя лента обслужена.
    """
    if len(plan) < 2:
        return plan
    near, far = plan[0], plan[1]
    if inserter_reaches_far_belt(far["name"], geometry):
        return plan
    if inserter_reaches_far_belt(near["name"], geometry):
        return [far, near] + list(plan[2:])
    if notes is not None:
        notes.append(
            f"до дальней ленты подачи {far['name']} не достаёт (он берёт только с "
            f"соседней ленты) — поставь на неё манипулятор или подведи эту ленту сбоку")
    return plan


def dataset_path(dataset_id: str | None = None) -> Path | None:
    # Папку спрашиваем у blueprint: у кабинета игрока она своя.
    directory = bp.dataset_dir()
    if not directory.is_dir():
        return None
    if dataset_id:
        path = directory / f"{dataset_id}.json"
        return path if path.is_file() else None
    files = sorted(directory.glob("*.json"))
    return files[-1] if files else None


def recipe_fluids(recipe: str | None, dataset_id: str | None = None) -> tuple[list, list]:
    """Жидкости рецепта: (входы, выходы) по порядку записи в рецепте."""
    path = dataset_path(dataset_id)
    if not path or not recipe:
        return [], []
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    rec = (data.get("recipes") or {}).get(recipe) or {}
    inputs = [i.get("name") for i in (rec.get("ingredients") or []) if i.get("type") == "fluid"]
    outputs = [p.get("name") for p in (rec.get("products") or []) if p.get("type") == "fluid"]
    return inputs, outputs


def machine_ports(machine: str, geometry: dict | None = None, direction: int = 0) -> list[dict]:
    """Порты газа/жидкости завода С УЧЁТОМ ЕГО ПОВОРОТА.

    Возвращает [{production, box, dx, dy, side, direction, filter}] где (dx, dy) —
    тайл, куда встаёт труба, в системе координат завода (левый верхний тайл = 0,0).
    Поворот нужен потому, что вместе со станцией поворачиваются и его порты:
    у повёрнутой на 180° теплицы вход воды уезжает на другую стену.
    """
    size = bp.entity_size(machine, geometry)
    if not size:
        return []
    w, h = size
    rec = bp.entity_record(machine, geometry) or {}
    steps = (int(direction) // 4) % 4
    ww, hh = (h, w) if steps % 2 else (w, h)
    out = []
    for index, box in enumerate(rec.get("fluids") or []):
        for conn in box.get("pipes") or []:
            if conn.get("type") == "underground":
                continue
            pos = conn.get("pos") or [0, 0]
            px, py = float(pos[0]), float(pos[1])
            for _ in range(steps):
                px, py = -py, px
            cdir = (int(conn.get("dir") or 0) + steps * 4) % 16
            dx_dir, dy_dir = bp.DIR_VECTORS.get(cdir, (0, 0))
            cx, cy = ww / 2 + px, hh / 2 + py
            machine_tile = (int(math.floor(cx)), int(math.floor(cy)))
            out.append({"production": box.get("production"), "box": index,
                        "machine_tile": machine_tile,
                        "dx": machine_tile[0] + dx_dir, "dy": machine_tile[1] + dy_dir,
                        "side": bp.DIRECTIONS.get(cdir, str(cdir)),
                        "direction": cdir, "filter": conn.get("filter"),
                        "width": ww, "height": hh})
    return out


def choose_ports(ports: list[dict], kind: str, need: int) -> list[dict]:
    """Порты под жидкости рецепта: i-я жидкость идёт в i-й бокс этого типа.

    Почему именно так, а не «любой доступный порт»: игра принимает каждую
    жидкость рецепта в СВОЙ fluid box (нужен он в порядке записи в рецепте), и
    подведённая к другому боксу труба просто не работает. Это видно и на
    заготовке пользователя: в его теплицах вода подведена к первому входному
    боксу. Именно из-за этой ошибки вода в моём блюпринте «заходила сбоку»:
    я выбирал бокс, который смотрел на ленту, а игра ждала жидкость в другом.
    """
    if need <= 0:
        return []
    by_box: dict = {}
    for port in ports:
        if port["production"] != kind:
            continue
        by_box.setdefault(port["box"], []).append(port)
    chosen: list[dict] = []
    for box in sorted(by_box)[:need]:
        # у бокса может быть несколько устьев — берём верхнее, при равных рядах правое
        chosen.append(sorted(by_box[box], key=lambda p: (p["dy"], -p["dx"]))[0])
    return chosen


def _rotation_for_drop(machine: str, recipe: str | None, geometry: dict | None,
                       dataset_id: str | None, wall_in: int | None, wall_out: int | None,
                       drop_wall: int) -> dict | None:
    """Поворот постройки, которая сама кладёт продукт на ленту.

    Выгрузка тут не пожелание, а условие: тайл выгрузки обязан оказаться на
    ленте, иначе постройке некуда класть продукт и она встанет. Поэтому поворот
    выбирается по выгрузке, а жидкости — уже как получится: если нужного порта на
    внешней стене в этом повороте нет, честно пишем об этом в примечании (тайлы
    портов всё равно остаются свободными — их видит _column_plan).

    None — если ни один поворот не выгружает на нужную стену.
    """
    inputs, outputs = recipe_fluids(recipe, dataset_id)
    need_in = 1 if inputs else 0
    need_out = 1 if outputs else 0
    candidates: list[tuple[int, int, list]] = []
    for direction in (0, 4, 8, 12):
        if machine_drop_side(machine, direction, geometry) != drop_wall:
            continue
        ports = machine_ports(machine, geometry, direction)
        on_wall = (
            (not need_in or wall_in is None
             or any(p["production"] == "input" and p["direction"] == wall_in for p in ports))
            and (not need_out or wall_out is None
                 or any(p["production"] == "output" and p["direction"] == wall_out for p in ports))
        )
        candidates.append((1 if on_wall else 0, direction, ports))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (-item[0], item[1]))
    on_wall, direction, ports = candidates[0]
    return {"direction": direction,
            "inputs": choose_ports(ports, "input", need_in),
            "outputs": choose_ports(ports, "output", need_out),
            "score": 10,
            "note": "" if on_wall else "жидкость подведена не с той стороны, как просили"}


def pick_rotation(machine: str, recipe: str | None, geometry: dict | None = None,
                  dataset_id: str | None = None, h: int | None = None,
                  wall_in: int | None = None, wall_out: int | None = None,
                  drop_wall: int | None = None) -> dict:
    """Подбирает поворот завода так, чтобы жидкости смотрели в нужную сторону.

    wall_in / wall_out — на какую стену должны попасть входы и выходы жидкости
    (12 = запад, 4 = восток, 0 = север, 8 = юг). Для ряда заводов вход должен
    смотреть на входную ленту (север, dy = -1); для «бутерброда» из двух столбцов
    — на внешнюю ленту подачи (запад у левого столбца, восток у правого).

    drop_wall — на какую стену должна смотреть ВЫГРУЗКА «своими руками» (см.
    drops_to_belt): у постройки, которая сама кладёт продукт на ленту, поворот
    обязан быть таким, чтобы тайл выгрузки оказался на ленте.

    Если wall_in не задан, ведём себя как раньше: вход наверх (к входной ленте),
    выход вниз.
    """
    size = bp.entity_size(machine, geometry)
    if not size:
        return {"direction": 0, "inputs": [], "outputs": [], "note": "нет геометрии"}
    w, height = size
    if h is not None:
        height = h
    inputs, outputs = recipe_fluids(recipe, dataset_id)
    need_in = 1 if inputs else 0
    need_out = 1 if outputs else 0
    if not need_in and not need_out and drop_wall is None:
        return {"direction": 0, "inputs": [], "outputs": [], "note": ""}
    if drop_wall is not None:
        by_drop = _rotation_for_drop(machine, recipe, geometry, dataset_id,
                                     wall_in, wall_out, drop_wall)
        if by_drop is not None:
            return by_drop

    def fits(kind, ports, wall, row):
        chosen = choose_ports(ports, kind, 1)
        if not chosen:
            return None
        if wall is None:
            ok = all(p["dy"] == row for p in chosen) if row is not None else True
        else:
            ok = all(p["direction"] == wall for p in chosen)
        return chosen if ok else None

    best = None
    for direction in (0, 4, 8, 12):
        ports = machine_ports(machine, geometry, direction)
        chosen_in = None
        if need_in:
            chosen_in = fits("input", ports, wall_in, None) if wall_in is not None else fits("input", ports, None, -1)
            if not chosen_in:
                continue
        chosen_out = None
        if need_out:
            chosen_out = fits("output", ports, wall_out, None) if wall_out is not None else fits("output", ports, None, height)
        score = 10 + (5 if (need_out and chosen_out) else 0) - (0 if direction in (0, 8) else 1)
        if best is None or score > best["score"]:
            best = {"direction": direction, "inputs": chosen_in or [], "outputs": chosen_out or [],
                    "score": score, "note": ""}
    if best is not None:
        return best
    # строгие требования не выполнились — берём хоть какой-то вариант с входом
    for direction in (0, 4, 8, 12):
        ports = machine_ports(machine, geometry, direction)
        chosen_in = choose_ports(ports, "input", need_in)
        chosen_out = choose_ports(ports, "output", need_out)
        if need_in and chosen_in:
            return {"direction": direction, "inputs": chosen_in, "outputs": chosen_out,
                    "note": "жидкость подведена не с той стороны, как просили"}
    return {"direction": 0, "inputs": [], "outputs": [],
            "note": "вход жидкости недостижим ни при каком повороте"}


def reserve_fluid_tiles(machine: str, recipe: str | None, count: int,
                        geometry: dict | None = None, dataset_id: str | None = None,
                        direction: int = 0) -> dict:
    """Тайлы, которые надо оставить СВОБОДНЫМИ под газ/жидкость.

    Трубы в блюпринте не ставим: пользователь проводит их сам. Но тайл, куда
    труба обязана прийти, и по одному соседнему тайлу с каждой стороны (чтобы
    было куда подвести трубу) должны остаться пустыми — иначе столб, лента или
    манипулятор закроют заводу вход или выход, и он встанет.

    Возвращает {"tiles": [...], "by_machine": {i: [...]}, "ports": {...},
                "fluids": {...}, "unreachable": [...]}
    """
    size = bp.entity_size(machine, geometry)
    if not size:
        return {"tiles": [], "by_machine": {}, "ports": {}, "fluids": {}, "unreachable": []}
    w, h = size
    inputs, outputs = recipe_fluids(recipe, dataset_id)
    ports = machine_ports(machine, geometry, direction)
    need_in = 1 if inputs else 0
    need_out = 1 if outputs else 0
    chosen = choose_ports(ports, "input", need_in) + choose_ports(ports, "output", need_out)

    tiles: set = set()
    port_tiles: set = set()
    by_machine: dict = {}
    unreachable: list = []
    for i in range(count):
        left = i * w
        for port in chosen:
            dx, dy = port["dx"], port["dy"]
            wall_row = dy == -1 or dy == h
            if not wall_row or dx < 0 or dx >= w:
                unreachable.append({"machine_index": i, "side": port["side"],
                                    "production": port["production"],
                                    "tile": (left + dx, dy),
                                    "why": "порт смотрит в боковую стену (её занимает сосед)"})
                continue
            # сам тайл порта (сюда встаёт труба) и по одному соседу слева и справа —
            # чтобы трубу было куда подвести
            port_tiles.add((left + dx, dy))
            for offset in (-1, 0, 1):
                if 0 <= dx + offset < w:
                    x = left + dx + offset
                    tiles.add((x, dy))
                    by_machine.setdefault(i, []).append((x, dy))
    return {"tiles": sorted(tiles), "port_tiles": sorted(port_tiles), "by_machine": by_machine,
            "ports": {"inputs": [p["side"] for p in chosen if p["production"] == "input"],
                      "outputs": [p["side"] for p in chosen if p["production"] == "output"]},
            "fluids": {"inputs": inputs, "outputs": outputs}, "unreachable": unreachable}


def block_plan(spec: "BlockSpec", geometry: dict | None = None) -> dict:
    """Поворот завода и зарезервированные тайлы — ровно то, что применит генератор.

    Отдельная функция нужна, чтобы проверки и тесты считали то же самое, а не
    свою копию правил: поворот меняет, на какую стену смотрит вход жидкости, а
    значит и то, какие тайлы остаются свободными.
    """
    geom = geometry if geometry is not None else bp.load_geometry()
    size = bp.entity_size(spec.machine, geom)
    if not size:
        raise ValueError(f"не знаю размер постройки {spec.machine}")
    empty = {"tiles": [], "port_tiles": [], "by_machine": {}, "ports": {},
             "fluids": {"inputs": [], "outputs": []}, "unreachable": []}
    if not spec.reserve_fluid_tiles:
        return {"rotation": {"direction": 0, "inputs": [], "outputs": [], "note": ""},
                "direction": 0, "reservation": empty}
    rotation = pick_rotation(spec.machine, spec.recipe, geom, spec.dataset_id, size[1])
    direction = int(rotation.get("direction") or 0)
    reservation = reserve_fluid_tiles(spec.machine, spec.recipe, spec.count, geom,
                                      spec.dataset_id, direction)
    return {"rotation": rotation, "direction": direction, "reservation": reservation}


def _entity(number: int, name: str, left: int, top: int, size, direction: int = 0) -> dict:
    """Запись сущности в формате блюпринта (позиция — центр постройки)."""
    ent = {"entity_number": number, "name": name,
           "position": bp.position_for_tile(left, top, size[0], size[1])}
    if direction:
        ent["direction"] = int(direction)
    return ent


def _module_items(modules: dict, inventory: int = CRAFTER_MODULES_INVENTORY) -> list | None:
    """Модули в том виде, в каком их пишет игра 2.0."""
    out = []
    for name, count in modules.items():
        if count <= 0:
            continue
        out.append({
            "id": {"name": name},
            "items": {"in_inventory": [
                {"inventory": int(inventory), "stack": i} for i in range(int(count))
            ]},
        })
    return out or None


def generate_row_block(spec: BlockSpec, geometry: dict | None = None) -> dict:
    """Собирает блюпринт «ряд заводов» и возвращает объект {"blueprint": {...}}."""
    geom = geometry if geometry is not None else bp.load_geometry()
    size = bp.entity_size(spec.machine, geom)
    if not size:
        raise ValueError(f"не знаю размер постройки {spec.machine}")
    w, h = size
    if spec.count < 1:
        raise ValueError("нужен хотя бы один завод")

    entities: list[dict] = []
    number = 1
    row_width = spec.count * w
    x_from = -spec.stub
    x_to = row_width + spec.stub - 1

    # ленты: сверху вход (на восток), снизу выход (на запад)
    for x in range(x_from, x_to + 1):
        entities.append(_entity(number, spec.belt, x, -2, (1, 1), 4))
        number += 1
    for x in range(x_from, x_to + 1):
        entities.append(_entity(number, spec.belt, x, h + 1, (1, 1), 12))
        number += 1

    # заводы вплотную друг к другу; поворот подбираем так, чтобы вход жидкости
    # смотрел на входную ленту (она сверху), а выход — на выходную (снизу)
    plan = block_plan(spec, geom)
    rotation = plan["rotation"]
    machine_direction = plan["direction"]
    for i in range(spec.count):
        left = i * w
        ent = _entity(number, spec.machine, left, 0, size, machine_direction)
        if spec.recipe:
            ent["recipe"] = spec.recipe
            ent["recipe_quality"] = "normal"
        modules = _module_items(spec.modules)
        if modules:
            ent["items"] = modules
        entities.append(ent)
        number += 1

    # --- газ и жидкость: тайлы подключения РЕЗЕРВИРУЕМ, но труб не ставим ---
    #
    # Пользователь проводит трубы сам. Наша задача — не занять тайл, куда труба
    # обязана прийти (и по одному соседнему с каждой стороны): ни столбом, ни
    # манипулятором, ни лентой. Иначе завод останется без газа и встанет.
    reservation = plan["reservation"]
    reserved: set = set(reservation["tiles"])

    occupied: set = set(reserved)  # сюда манипулятор и столб не встанут
    taken: set = set()
    center_offset = (w - 1) // 2
    for i, row, name in ([(i, -1, spec.inserter_in) for i in range(spec.count)] +
                         [(i, h, spec.inserter_out) for i in range(spec.count)]):
        left = i * w
        candidates = sorted(range(left, left + w), key=lambda x: (abs(x - (left + center_offset)), x))
        for x in candidates:
            if (x, row) not in occupied:
                occupied.add((x, row))
                taken.add((x, row))
                entities.append(_entity(number, name, x, row, (1, 1), 0))
                number += 1
                break

    # --- электричество: столбы только для тех, кому оно нужно ---
    #
    # Часть заводов и манипуляторов работает на топливе (burner/void) — им
    # электричество не нужно вообще, и столбы рядом с ними только мешают.
    # Поэтому сначала собираем список потребителей, и если он пуст — столбов нет.
    consumers: list[tuple[int, int, int, int]] = []
    if spec.pole:
        if needs_power(spec.machine, geom):
            for i in range(spec.count):
                consumers.append((i * w, 0, w, h))
        # манипуляторы берём из уже расставленных: на топливе среди них не потребители
        for ent in entities:
            rec = bp.entity_record(ent["name"], geom) or {}
            if rec.get("type") != "inserter" or not needs_power(ent["name"], geom):
                continue
            t = bp.tiles_of(ent, geom)
            if t:
                consumers.append(t)

    power = {"tiles": [], "problems": [], "row": None, "supply": 0.0, "wire": 0.0}
    if spec.pole and consumers:
        free_rows = {}
        for row in (h, -1):
            free_rows[row] = sorted(x for x in range(x_from, x_to + 1) if (x, row) not in occupied)
        power = plan_poles(spec.pole, consumers, free_rows, geom, x_from, x_to)
        for (px, py) in power["tiles"]:
            entities.append(_entity(number, spec.pole, px, py, (1, 1), 0))
            number += 1
        # Провода между столбами: в игре чертёж строит ИМЕННО прописанные связи,
        # без них столбы встают без проводов (bp.connect_power_wires).
        bp.connect_power_wires({"blueprint": {"entities": entities}}, geom)

    blueprint = {
        "item": "blueprint",
        "version": BLUEPRINT_VERSION,
        "entities": entities,
    }
    if spec.label:
        blueprint["label"] = spec.label
    return {"blueprint": blueprint}


def needs_power(name: str, geometry: dict | None = None) -> bool:
    """Нужно ли этой постройке электричество.

    Смотрим на источник энергии в прототипе: у печей и манипуляторов на топливе
    он burner (а бывает и void — как у пи-манипулятора на топливе), и такие
    потребителями НЕ являются. Столбы для них — просто мусор в блюпринте.
    """
    rec = bp.entity_record(name, geometry) or {}
    machine_source = (rec.get("machine") or {}).get("energy_source")
    inserter_source = (rec.get("inserter") or {}).get("energy_source")
    return machine_source == "electric" or inserter_source == "electric"


def _supply_and_wire(pole: str, geometry: dict | None) -> tuple[float, float]:
    rec = bp.entity_record(pole, geometry) or {}
    electric = rec.get("electric") or {}
    supply = float(electric.get("supply_area_distance") or 2.5)
    wire = float(electric.get("maximum_wire_distance") or 7.5)
    return supply, wire


def drops_to_belt(machine: str, geometry: dict | None = None) -> list[float] | None:
    """Вектор выгрузки «своими руками» или None, если машина так не умеет.

    У буров, Py-экстракторов (экстрактор грунта, бур земли, классификатор) и
    литейных аппаратов в прототипе есть vector_to_place_result: постройка сама
    кладёт продукт на землю или ленту перед собой. Вектор задан в тайлах от
    центра постройки и поворачивается вместе с ней.

    Такой постройке манипулятор на выход НЕ нужен — зато тайл выгрузки обязан
    быть свободен или занят лентой: если там окажется соседний завод, постройка
    встанет (класть продукт некуда).
    """
    rec = bp.entity_record(machine, geometry) or {}
    vec = rec.get("drops_to_belt")
    if not vec:
        return None
    x, y = float(vec[0]), float(vec[1])
    if abs(x) < 1e-6 and abs(y) < 1e-6:
        return None
    return [x, y]


def drop_tile(machine: str, direction: int, geometry: dict | None = None) -> tuple[int, int] | None:
    """Тайл выгрузки в координатах постройки (левый верхний тайл = 0,0)."""
    vec = drops_to_belt(machine, geometry)
    size = bp.entity_size(machine, geometry)
    if vec is None or not size:
        return None
    w, h = size
    steps = (int(direction) // 4) % 4
    px, py = vec
    for _ in range(steps):
        px, py = -py, px
    ww, hh = (h, w) if steps % 2 else (w, h)
    return (int(math.floor(ww / 2 + px)), int(math.floor(hh / 2 + py)))


def machine_drop_side(machine: str, direction: int, geometry: dict | None = None) -> int | None:
    """На какую сторону постройка выгружает: 4 — восток, 12 — запад, 0 — север, 8 — юг."""
    tile = drop_tile(machine, direction, geometry)
    size = bp.entity_size(machine, geometry)
    if tile is None or not size:
        return None
    w, h = size
    steps = (int(direction) // 4) % 4
    ww, hh = (h, w) if steps % 2 else (w, h)
    x, y = tile
    if x < 0:
        return 12
    if x >= ww:
        return 4
    if y < 0:
        return 0
    if y >= hh:
        return 8
    return None


def _covers(pole_tile: tuple[int, int], consumer: tuple[int, int, int, int], supply: float) -> bool:
    """Попадает ли постройка в зону питания столба.

    В игре постройка питается, если её габарит пересекается с зоной питания,
    поэтому проверяем именно пересечение прямоугольников, а не центр.
    """
    px, py = pole_tile[0] + 0.5, pole_tile[1] + 0.5
    left, top, w, h = consumer
    return (left < px + supply and left + w > px - supply
            and top < py + supply and top + h > py - supply)


def pole_components(poles: list[tuple[int, int]], wire: float) -> list[list[tuple[int, int]]]:
    """Сети столбов: внутри сети провод дотягивается, между сетями — нет.

    В игре два столба соединяются обычным проводом, если расстояние между их
    центрами не больше maximum_wire_distance. Столбы 1×1 стоят по центрам тайлов,
    поэтому расстояние — это обычная гипотенуза по тайлам.

    Молл — это тысячи столбов, поэтому соседей ищем по сетке, а не перебором всех
    пар: иначе на один чертёж уходили десятки миллионов проверок.
    """
    parent = list(range(len(poles)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    cell = max(1.0, wire)
    grid: dict[tuple[int, int], list[int]] = {}
    for index, (x, y) in enumerate(poles):
        grid.setdefault((int(x // cell), int(y // cell)), []).append(index)
    limit2 = (wire + 1e-9) ** 2
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
                        ax, ay = poles[i]
                        bx, by = poles[j]
                        if (ax - bx) ** 2 + (ay - by) ** 2 <= limit2:
                            parent[find(i)] = find(j)
    groups: dict[int, list[tuple[int, int]]] = {}
    for index, tile in enumerate(poles):
        groups.setdefault(find(index), []).append(tile)
    return sorted(groups.values(), key=len, reverse=True)


def connect_pole_network(poles: list[tuple[int, int]], blocked: set,
                         wire: float) -> tuple[list[tuple[int, int]], list[str]]:
    """Дотягивает провод между отдельными сетями столбов и возвращает добавленные.

    Зачем: колонки столбов считаются по группам заводов, и у блока из нескольких
    групп (или из нескольких рядов) каждая группа получала СВОЮ цепочку. Между
    соседними группами расстояние больше длины провода — в игре это выглядит как
    «столбы стоят, а провода между ними нет»: часть блока под напряжением, часть
    нет. Поэтому после расстановки сети проверяются и между ними ставятся
    промежуточные столбы: сначала пробуем один (тайл, от которого провод
    дотянется до обеих сетей), а если сети дальше двух проводов — идём шагами по
    проводу в сторону второй сети. Тайл обязан быть свободным: не завод, не
    лента, не манипулятор, не тайл под трубу.

    Возвращает (добавленные столбы, замечания). Если связать нечем (свободного
    тайла между сетями нет), об этом честно сказано в замечаниях.
    """
    poles = list(poles)
    blocked = set(blocked)
    added: list[tuple[int, int]] = []
    notes: list[str] = []
    reach = int(math.ceil(wire))

    # «Не липнуть к соседям»: тайлы в двух шагах от любого столба заняты под
    # частокол. Считаем их один раз и обновляем при каждой вставке — иначе на
    # каждый тайл пришлось бы перебирать все столбы.
    near: set = set()

    def mark_near(tile: tuple[int, int]) -> None:
        for dx in range(-2, 3):
            for dy in range(-2, 3):
                near.add((tile[0] + dx, tile[1] + dy))

    for tile in poles:
        mark_near(tile)

    def closest_pair(comps: list[list[tuple[int, int]]]):
        """Самая близкая пара тайлов из РАЗНЫХ сетей — там и нужен провод.

        Перебор пар сетей с отсечением по габаритам: у молла столбов тысячи, и
        честный перебор всех пар «каждый с каждым» стоил бы секунды на один шаг.
        """
        boxes = []
        for comp in comps:
            xs = [p[0] for p in comp]
            ys = [p[1] for p in comp]
            boxes.append((min(xs), min(ys), max(xs), max(ys)))
        best = None
        for i in range(len(comps)):
            for j in range(i + 1, len(comps)):
                ax0, ay0, ax1, ay1 = boxes[i]
                bx0, by0, bx1, by1 = boxes[j]
                dx = max(bx0 - ax1, ax0 - bx1, 0)
                dy = max(by0 - ay1, ay0 - by1, 0)
                if best is not None and math.hypot(dx, dy) >= best[0]:
                    continue          # сети и так дальше текущего лучшего
                for a in comps[i]:
                    for b in comps[j]:
                        d = math.dist(a, b)
                        if best is None or d < best[0]:
                            best = (d, a, b)
        return best

    def free_tile_between(a: tuple[int, int], b: tuple[int, int], both: bool):
        """Свободный тайл: в пределах провода от `a` и (если both) от `b`.

        Без `both` берём тайл, который ближе всего подводит ко второй сети, — это
        шаг вдоль провода, когда одним столбом сети не сшить.
        """
        best = None
        for x in range(min(a[0], b[0]) - reach, max(a[0], b[0]) + reach + 1):
            for y in range(min(a[1], b[1]) - reach, max(a[1], b[1]) + reach + 1):
                if (x, y) in blocked or (x, y) in near:
                    continue
                da = math.dist((x, y), a)
                if da > wire + 1e-9:
                    continue
                db = math.dist((x, y), b)
                if both:
                    if db > wire + 1e-9:
                        continue
                    score = da + db
                else:
                    score = db
                if best is None or score < best[0]:
                    best = (score, (x, y))
        return best[1] if best else None

    for _ in range(4 * len(poles) + 8):
        comps = pole_components(poles + added, wire)
        if len(comps) < 2:
            break
        pair = closest_pair(comps)
        if pair is None:
            break
        distance, left, right = pair
        tile = free_tile_between(left, right, both=True)
        if tile is None and distance > wire:
            # Сети дальше двух проводов: идём к второй сети шагами, но только если
            # шаг реально приближает — иначе топтались бы на месте.
            step = free_tile_between(left, right, both=False)
            if step is not None and math.dist(step, right) <= distance - 1.0:
                tile = step
        if tile is None:
            notes.append(
                f"столбы распались на {len(comps)} сетей: между ними {distance:.0f} тайлов, "
                f"а провод тянется на {wire:.0f} — свободного места под промежуточный столб "
                f"нет, соедини сети проводом вручную")
            break
        added.append(tile)
        blocked.add(tile)
        mark_near(tile)

    return added, notes


def _column_reaches(column: int, consumer: tuple[int, int, int, int], supply: float) -> bool:
    """Достаёт ли столб в этой колонке до постройки по горизонтали.

    Нужно, чтобы колонка не пыталась «накрыть» постройку у противоположной
    стены: до неё она всё равно не дотянется, и поиск столба застревал.
    """
    px = column + 0.5
    left, _top, w, _h = consumer
    return left < px + supply and left + w > px - supply


def plan_poles(pole: str | None, consumers: list[tuple[int, int, int, int]],
               free_rows: dict, geometry: dict | None = None,
               x_from: int = 0, x_to: int = 0) -> dict:
    """Ставит столбы так, чтобы запитать всех потребителей и связать их в цепочку.

    * потребителей нет (всё на топливе) — столбов не ставим вовсе;
    * иначе идём вдоль ряда свободных тайлов с шагом по зоне питания (не больше
      длины провода, иначе цепочка разорвётся) и после расстановки проверяем,
      что каждый потребитель накрыт и что соседние столбы достают друг до друга.

    free_rows: {ряд: отсортированный список свободных x}.
    """
    if not pole or not consumers:
        return {"tiles": [], "problems": [], "row": None, "supply": 0.0, "wire": 0.0}
    supply, wire = _supply_and_wire(pole, geometry)
    step = max(1, int(min(2 * supply, wire)))
    best = None
    for row, candidates in free_rows.items():
        if not candidates:
            continue
        tiles: list[tuple[int, int]] = []
        last_x = None
        for x in range(x_from, x_to + 1):
            if last_x is not None and x - last_x < step:
                continue
            if x not in candidates:
                continue
            if last_x is not None and x - last_x > wire:
                break  # дальше цепочка не дотянется
            tiles.append((x, row))
            last_x = x
        if not tiles:
            continue
        uncovered = [c for c in consumers if not any(_covers(t, c, supply) for t in tiles)]
        # если кто-то остался без питания — пробуем добить столбами рядом с ним
        for consumer in list(uncovered):
            centre = consumer[0] + consumer[2] / 2
            near = [c for c in candidates if abs(c + 0.5 - centre) <= supply]
            near = [c for c in near if all(abs(c - t[0]) <= wire for t in tiles)] or near
            if not near:
                continue
            pick = min(near, key=lambda c: abs(c + 0.5 - centre))
            tiles.append((pick, row))
            tiles.sort()
        uncovered = [c for c in consumers if not any(_covers(t, c, supply) for t in tiles)]
        broken = [(a, b) for a, b in zip(tiles, tiles[1:]) if abs(a[0] - b[0]) > wire]
        score = (len(uncovered), len(broken), len(tiles))
        if best is None or score < best["score"]:
            best = {"tiles": tiles, "uncovered": uncovered, "broken": broken, "score": score,
                    "row": row, "supply": supply, "wire": wire}
    if best is None:
        return {"tiles": [], "problems": ["нет свободных тайлов под столбы"], "row": None,
                "supply": supply, "wire": wire}
    problems = []
    if best["uncovered"]:
        problems.append(f"без питания остались {len(best['uncovered'])} построек: "
                        f"{[c[:2] for c in best['uncovered'][:4]]}")
    if best["broken"]:
        problems.append(f"разрыв цепочки между столбами: {best['broken'][:3]}")
    return {"tiles": best["tiles"], "problems": problems, "row": best["row"],
            "supply": best["supply"], "wire": best["wire"]}


def check_fluid_access(obj: dict, geometry: dict | None = None,
                       dataset_id: str | None = None) -> list[dict]:
    """Проверяет, что входы/выходы газа и жидкости не закрыты чужими постройками.

    Трубы генератор не ставит, но тайл, куда труба обязана прийти, должен быть
    свободен. Для каждого завода с рецептом берём жидкости рецепта, находим
    подходящие точки подключения и смотрим, что стоит на тайле подхода:

      * пусто — всё хорошо;
      * труба — тоже хорошо (значит её уже провели);
      * манипулятор, столб, лента и прочее — ошибка: завод встанет без газа;
      * соседний завод — не ошибка, а справка: в ряду заводы стоят вплотную,
        и такое подключение просто недостижимо (у бокса обычно есть другое).

    Возвращает список замечаний: {level, machine, tile, production, blocker, text}.
    """
    geom = geometry if geometry is not None else bp.load_geometry()
    records = bp.entity_records(geom)
    placed: dict = {}
    for ent in bp.iter_entities(obj):
        t = bp.tiles_of(ent, geom)
        if not t:
            continue
        for x in range(t[0], t[0] + t[2]):
            for y in range(t[1], t[1] + t[3]):
                placed[(x, y)] = ent.get("name") or "?"

    problems: list[dict] = []
    pipes = ("pipe", "pipe-to-ground", "infinity-pipe", "heat-pipe", "valve")
    for ent in bp.iter_entities(obj):
        name = ent.get("name") or "?"
        rec = records.get(name) or {}
        if rec.get("type") not in bp.MACHINE_TYPES:
            continue
        inputs, outputs = recipe_fluids(ent.get("recipe"), dataset_id)
        if not (inputs or outputs):
            continue
        # Смотрим ПО БОКСАМ: у завода может быть несколько подходов к одному
        # боксу, и если хотя бы один свободен или уже с трубой — завод в порядке.
        # Ошибка только когда перекрыты ВСЕ подходы нужного бокса.
        boxes: dict = {}
        for conn in bp.fluid_connections(ent, geom):
            if conn["kind"] == "underground":
                continue
            needed = (conn["production"] == "input" and inputs) or \
                     (conn["production"] == "output" and outputs)
            if not needed:
                continue
            tile = conn["approach_tile"]
            blocker = placed.get(tile)
            if blocker is None or blocker == name or (records.get(blocker) or {}).get("type") in pipes:
                state = "ok"
            elif (records.get(blocker) or {}).get("type") in bp.MACHINE_TYPES:
                state = "machine"
            else:
                state = "blocked"
            boxes.setdefault((conn["box"], conn["production"]), []).append(
                {"tile": tile, "side": conn["side"], "state": state, "blocker": blocker})

        for (box, production), entries in sorted(boxes.items()):
            if any(e["state"] == "ok" for e in entries):
                continue  # бокс обслуживается другим подходом
            only_machines = all(e["state"] == "machine" for e in entries)
            problems.append({
                "level": "info" if only_machines else "error",
                "machine": name,
                "production": production,
                "box": box,
                "tiles": [e["tile"] for e in entries],
                "blockers": sorted({e["blocker"] for e in entries if e["blocker"]}),
                "text": (f"{name}: бокс #{box} ({production}) недоступен — все подходы заняты: "
                         + ", ".join(f"{e['tile']} ({e['blocker']})" for e in entries)),
            })
    return problems


def far_reach_inserter(geometry: dict | None = None) -> str | None:
    """Манипулятор, который достаёт ДАЛЬНЮЮ ленту (вылет на 2 тайла).

    Вторую ленту подачи обычный манипулятор не видит — он берёт только с соседнего
    тайла. Длиннорукий достаёт через ленту, поэтому из пары «2 ленты = 2
    манипулятора» дальнюю берёт именно он.
    """
    records = bp.entity_records(geometry)
    candidates = []
    for name, rec in records.items():
        if rec.get("type") != "inserter":
            continue
        ins = rec.get("inserter") or {}
        pickup = ins.get("pickup") or [0, -1]
        reach = abs(float(pickup[1])) if len(pickup) > 1 else 1
        if reach >= 2:
            candidates.append(name)
    if not candidates:
        return None
    for preferred in ("long-handed-inserter", "bob-long-handed-inserter"):
        if preferred in candidates:
            return preferred
    return sorted(candidates)[0]


def _recipe_of(recipe: str | None, dataset_id: str | None = None) -> dict:
    """Рецепт из датасета (или пустой словарь, если его там нет)."""
    path = dataset_path(dataset_id)
    if not path or not recipe:
        return {}
    import json as _json

    with path.open(encoding="utf-8") as f:
        data = _json.load(f)
    return (data.get("recipes") or {}).get(recipe) or {}


def has_solid_products(spec: "BlockSpec", dataset_id: str | None = None) -> bool:
    """Есть ли у рецепта ТВЁРДЫЕ продукты.

    Если нет (например «Битум»: на входе и на выходе только жидкости), лента
    выгрузки и манипуляторы не нужны вовсе — всё уходит трубами.
    """
    rec = _recipe_of(spec.recipe, dataset_id)
    if not rec:
        return True   # рецепта не знаем — считаем, что лента выгрузки нужна
    return any(i.get("type") == "item" for i in (rec.get("products") or []))


def supply_belt_count(spec: "BlockSpec", dataset_id: str | None = None) -> int:
    """Сколько лент подачи нужно рецепту: 0, 1, 2 или 3.

    Считаем ТВЁРДЫЕ входы рецепта (жидкости идут трубами, их не считаем):
      ничего твёрдого — лент нет вообще,
      до 2 предметов — одна лента (по предмету на сторону),
      3-4 — две,
      5 и больше — три.
    Исключение — топка: твёрдое топливо тоже привозят лентой, поэтому печи и
    другим burner-постройкам лента нужна даже при «жидкостном» рецепте.
    Если рецепт неизвестен — одна лента.
    """
    path = dataset_path(dataset_id)
    if not path or not spec.recipe:
        return 1
    import json as _json

    with path.open(encoding="utf-8") as f:
        data = _json.load(f)
    rec = (data.get("recipes") or {}).get(spec.recipe) or {}
    solids = [i for i in (rec.get("ingredients") or []) if i.get("type") == "item"]
    count = len(solids)
    if count == 0:
        machine = (data.get("entities") or {}).get(spec.machine) or {}
        if str(machine.get("energy_source_type") or "").lower() == "burner":
            return 1   # топливо едет лентой
        return 0
    if count <= 2:
        return 1
    if count <= 4:
        return 2
    return 3


def _column_plan(spec: BlockSpec, geometry: dict, count: int, wall_in: int,
                 drop_wall: int | None = None, pitch: int | None = None) -> dict:
    """Поворот завода под нужную внешнюю стену и зарезервированные тайлы столбца.

    `pitch` — шаг заводов в столбце (высота завода плюс, если постройка сама
    кладёт продукт на ленту, клетка под трубы). По нему считаются ряды портов:
    с шагом h порты нижних заводов «уезжали» на чужое место, и манипулятор
    вставал ровно на устье трубы.
    """
    wall_out = 4 if wall_in == 12 else 12
    rotation = pick_rotation(spec.machine, spec.recipe, geometry, spec.dataset_id,
                             None, wall_in=wall_in, wall_out=wall_out, drop_wall=drop_wall)
    direction = int(rotation.get("direction") or 0)
    if not spec.reserve_fluid_tiles:
        return {"rotation": rotation, "direction": direction, "reserved": set(), "ports": []}
    size = bp.entity_size(spec.machine, geometry)
    w, h = size
    step = h if not pitch else pitch
    reserved: set = set()
    ports: list = []
    chosen = rotation.get("inputs", []) + rotation.get("outputs", [])
    # Резервируем ВСЕ порты завода в этом повороте, а не только выбранные боксы:
    # у многобоксовых построек (например отливной аппарат) есть устья с обеих
    # сторон, и манипулятор, вставший на такое устье, закрывает трубу — игрок
    # просил этого не делать.
    every_port = machine_ports(spec.machine, geometry, direction)
    for index in range(count):
        top = index * step
        for port in chosen:
            for dy in (-1, 0, 1):  # сам тайл порта и по соседу вдоль коридора
                reserved.add((port["dx"], top + port["dy"] + dy))
            ports.append((port["dx"], top + port["dy"]))
        for port in every_port:
            for dy in (-1, 0, 1):
                reserved.add((port["dx"], top + port["dy"] + dy))
    return {"rotation": rotation, "direction": direction, "reserved": reserved, "ports": ports}


def layout_group_rows(groups: list[int], row_groups: list | None) -> list[list[int]]:
    """Индексы групп по рядам блока: [[0,1,2], [3,4], ...].

    `row_groups` — сколько групп человек хочет в каждом ряду (сайт даёт ввести
    число в каждой строке). Ряды идут по порядку групп: сначала первые N1 групп,
    потом следующие N2 и так далее.

    Пусто — все группы в один ряд (как было раньше). Сумма рядов, не совпавшая с
    числом групп, — ошибка: иначе в чертёж попала бы только часть этапа, а
    человек узнал бы об этом уже в игре.
    """
    indices = list(range(len(groups)))
    if not row_groups:
        return [indices] if indices else []
    wanted = [int(n) for n in row_groups]
    if any(n <= 0 for n in wanted):
        raise ValueError("в ряду не может быть меньше одной группы")
    if sum(wanted) != len(indices):
        raise ValueError(
            f"в рядах {sum(wanted)} групп, а у этапа {len(indices)}: "
            f"сумма по рядам должна совпадать с числом групп")
    out: list[list[int]] = []
    pos = 0
    for n in wanted:
        out.append(indices[pos:pos + n])
        pos += n
    return out


def group_width_tiles(w: int, supply_belts: int, out_belt: bool, dumps: bool = False) -> int:
    """Ширина одной группы в тайлах — как её раскладывает generate_sandwich_block.

        [ленты подачи][манипулятор][заводы][манипулятор][лента выгрузки][манипулятор][заводы][манипулятор][ленты подачи]

    `dumps` — постройка сама кладёт продукт на ленту (см. drops_to_belt): тогда
    между столбцами нет манипуляторов, а лента стоит вплотную к заводам.
    """
    width = (supply_belts + 1) if supply_belts else 0   # ленты подачи + ряд манипуляторов
    width += w                                          # левый столбец заводов
    width += 1 if (dumps or not out_belt) else 3        # лента выгрузки вплотную или манипулятор+лента+манипулятор
    width += w                                          # правый столбец заводов
    if supply_belts:
        width += 1 + supply_belts                       # манипулятор + ленты подачи
    return width


def group_placements(groups: list[int], placements: list) -> list:
    """[(номер группы, заводов в ней, левый x, верхний y)] — по одному на группу."""
    return [(index, groups[index], x, y) for (index, x, y) in placements]


# ---------------------------------------------------------------------------
# маяки этапа
# ---------------------------------------------------------------------------
#
# Маяк — постройка рядом с заводами, которая раздаёт им эффект модулей. В ЧЕРТЁЖ
# БЛОКА маяки не ставятся (просьба игрока: «из генерации блюпринт компановки
# групп убери маяки, только в сундук запроса и подсчет итогового числа фабрик»):
# раскладка — это заводы, ленты, манипуляторы и столбы, а маяки игрок ставит сам.
#
# Здесь остаётся только разбор строк маяков для ЗАКУПКИ: сайт присылает строки
# («один маяк, что в нём лежит и сколько заводов он накрывает»), а сундук запроса
# заказывает сами маяки и модули к ним. Эффект маяков и число заводов сайт считает
# сам, до похода на сервер.


def beacon_rows(raw) -> list[dict]:
    """Строки маяков с сайта в одном виде: [{"name", "count", "covers", "modules"}].

    Модули приводим к {имя: сколько} — как модули завода: и чертёж, и закупка
    считают их одинаково, а мусор в поле не должен ломать весь этап.
    """
    out: list[dict] = []
    for row in (raw or []):
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        modules: dict = {}
        for module in (row.get("modules") or []):
            if not isinstance(module, dict) or not module.get("name"):
                continue
            count = int(module.get("count") or 0)
            if count > 0:
                key = str(module["name"])
                modules[key] = modules.get(key, 0) + count
        out.append({"name": name,
                    "count": int(row.get("count") or 0),
                    "covers": int(row.get("covers") or 0),
                    "modules": modules})
    return out


def occupied_tiles(entities: list, geometry: dict | None = None,
                   extra: set | None = None) -> set:
    """Все тайлы, занятые постройками (полными габаритами), плюс зарезервированные.

    tiles_of отдаёт только левый верхний тайл, а маяк нельзя поставить внутрь
    7×7 завода — поэтому габарит разворачивается в тайлы. `extra` — тайлы под
    газ/жидкость: их резервирует генератор, чтобы игрок провёл туда трубу, и
    занимать их маяком нельзя так же, как столбом.
    """
    out: set = set(extra or ())
    for entity in entities:
        tile = bp.tiles_of(entity, geometry)
        if not tile:
            continue
        left, top, w, h = tile
        out.update((left + dx, top + dy) for dx in range(w) for dy in range(h))
    return out


def generate_sandwich_block(spec: BlockSpec, geometry: dict | None = None) -> dict:
    """Группа заводов «бутербродом»: два столбца, между ними лента выгрузки.

    Раскладка повторяет заготовку пользователя (templates/bp.txt, теплицы):

        [лента подачи][манипулятор][заводы][манипулятор][лента выгрузки][манипулятор][заводы][манипулятор][лента подачи]

    Заводы в столбце стоят вплотную, лента выгрузки одна на группу и and едет
    вниз, ленты подачи — по внешним сторонам, каждая кормит свой столбец.
    Группа из count заводов делится на два столбца поровну (20 → 10 и 10, 21 →
    11 и 10). Групп может быть несколько — тогда они стоят рядом, а если человек
    задал `row_groups`, группы раскладываются по НЕСКОЛЬКИМ рядам: ряд из групп
    идёт вдоль, следующий — ниже с отступом ROW_GAP (10 тайлов).
    """
    geom = geometry if geometry is not None else bp.load_geometry()
    size = bp.entity_size(spec.machine, geom)
    if not size:
        raise ValueError(f"не знаю размер постройки {spec.machine}")
    w, h = size
    groups = [int(g) for g in (spec.groups or []) if int(g) > 0] or [spec.count]
    if not spec.groups and spec.count > 0:
        groups = [spec.count]
    # Ряды групп: [[индексы первого ряда], [второго], ...]. Ошибку «сумма не
    # сходится» бросает layout_group_rows — сервер отдаёт её текстом наверх.
    layout_rows = layout_group_rows(groups, spec.row_groups)

    entities: list = []
    number = 1
    gap = 2  # между группами в ряду ровно две ленты
    reserved_all: set = set()
    port_all: list = []
    rotations: list = []
    sandwich_problems: list = []
    sandwich_notes: list = []
    placed_poles: list = []   # столбы всего блока: их видят все группы
    # Куда ставить каждую группу: (номер группы, левый x, верхний y). Внутри ряда
    # группы стоят вплотную друг к другу (как и раньше), а следующий РЯД начинается
    # ниже на высоту самого высокого ряда плюс ROW_GAP — 10 тайлов на проход.
    # Ширина и высота группы тут считаются так же, как их считает раскладка ниже
    # (ширина — group_width_tiles, высота — ceil(заводов/2) рядов заводов); за тем,
    # что формулы не разъехались, следит тест test_group_rows_*.
    wanted_belts_all = int(spec.input_belts or supply_belt_count(spec, spec.dataset_id))
    supply_belts_all = max(0, min(2, wanted_belts_all))
    out_belt_all = bool(has_solid_products(spec, spec.dataset_id))
    # Постройка сама кладёт продукт на ленту (буры, Py-экстракторы, литейные
    # аппараты)? Тогда манипулятор на выход не нужен, лента встаёт вплотную к
    # столбцу — ровно на тайл выгрузки, и поворот обязан смотреть на неё.
    self_dump = drops_to_belt(spec.machine, geom) is not None and out_belt_all
    fluid_in_all, fluid_out_all = recipe_fluids(spec.recipe, spec.dataset_id)
    # Зазор в клетку между заводами: вместе с поворотом «выгрузка на ленту» порты
    # жидкости уезжают на север/юг, а в тесном столбце трубу к ним не подвести —
    # соседний завод занимает ровно тот тайл. Пустая клетка и есть труба.
    col_gap = 1 if (self_dump and (fluid_in_all or fluid_out_all)
                    and spec.reserve_fluid_tiles) else 0
    pitch = h + col_gap
    group_width = group_width_tiles(w, supply_belts_all, out_belt_all, dumps=self_dump)
    placements: list = []          # [(номер группы, x, y)]
    y_row = 0
    for row_ids in layout_rows:
        x_row = 0
        row_height = 0
        for group_index in row_ids:
            placements.append((group_index, x_row, y_row))
            row_height = max(row_height, ((groups[group_index] + 1) // 2) * pitch)
            x_row += group_width + gap
        y_row += row_height + ROW_GAP
    for group_index, count, x_cursor, y0 in group_placements(groups, placements):
        left_count = (count + 1) // 2          # 20 -> 10 и 10, 21 -> 11 и 10
        right_count = count - left_count
        rows = max(left_count, right_count)
        # столбцы: [подача][манипулятор][заводы][манипулятор][выгрузка][манипулятор][заводы][манипулятор][подача]
        # Снаружи столбца идут ЛЕНТЫ ПОДАЧИ ВПЛОТНУЮ, за ними один ряд
        # манипуляторов, потом заводы: [ленты][манипуляторы][заводы][манипуляторы][выгрузка]...
        # Число лент — по числу твёрдых входов рецепта (1..3), см. supply_belt_count.
        wanted_belts = int(spec.input_belts or supply_belt_count(spec, spec.dataset_id))
        # Больше двух лент подачи снаружи столбца не помещается: третью не достаёт
        # ни один манипулятор (вылет максимум 2 тайла). Поэтому потолок — 2, а про
        # лишние честно пишем в описание блюпринта.
        supply_belts = max(0, min(2, wanted_belts))
        # Приписка про «лишние» ленты — ниже, когда уже видно, выбрал ли игрок
        # погрузчик: тогда ленты подачи не строятся вовсе, и обещать «сгенерированы
        # 2 ленты» было бы враньём.
        # Только жидкости: ни лент подачи, ни ленты выгрузки, ни манипуляторов —
        # всё уходит трубами. Столбцы под них не занимаем, чтобы блок не пух.
        out_belt = has_solid_products(spec, spec.dataset_id)
        if not supply_belts and not out_belt:
            sandwich_notes.append("у рецепта только жидкости: лент и манипуляторов нет — "
                                  "вход и выход трубами, тайлы под них свободны")
        elif not supply_belts:
            sandwich_notes.append("твёрдых входов у рецепта нет: ленты подачи и манипуляторы "
                                  "на вход не ставились (эти жидкости приходят трубами)")
        elif not out_belt:
            sandwich_notes.append("твёрдых продуктов у рецепта нет: ленты выгрузки и манипуляторы "
                                  "на выход не ставились (продукты уходят трубами)")
        # Поворот каждого столбца — ДО раскладки: от него зависит, попадёт ли
        # выгрузка «своими руками» на ленту (тогда манипулятор на выход не нужен).
        plan_left = _column_plan(spec, geom, left_count, wall_in=12,
                                 drop_wall=4 if (out_belt and self_dump) else None,
                                 pitch=pitch)
        plan_right = _column_plan(spec, geom, right_count, wall_in=4,
                                  drop_wall=12 if (out_belt and self_dump) else None,
                                  pitch=pitch)
        drops_on_belt = (out_belt and self_dump
                         and machine_drop_side(spec.machine, plan_left["direction"], geom) == 4
                         and machine_drop_side(spec.machine, plan_right["direction"], geom) == 12)
        if out_belt and self_dump and not drops_on_belt:
            for plan in (plan_left, plan_right):
                if plan["rotation"].get("note"):
                    sandwich_problems.append(plan["rotation"]["note"])
        # ширина группы: ленты подачи + манипуляторы + заводы + манипулятор + выгрузка
        x_left_first_belt = x_left_ins = None
        if supply_belts:
            x_left_first_belt = x_cursor
            x_left_ins = x_left_first_belt + supply_belts
            x_left = x_left_ins + 1
        else:
            x_left = x_cursor
        if drops_on_belt:
            # Постройка сама кладёт продукт на ленту: манипуляторов на выход нет,
            # а лента стоит ВПЛОТНУЮ к столбцу — ровно на тайле выгрузки.
            x_mid_ins_l = x_mid_ins_r = None
            x_out_belt = x_left + w
            x_right = x_out_belt + 1
        elif out_belt:
            x_mid_ins_l = x_left + w
            x_out_belt = x_mid_ins_l + 1
            x_mid_ins_r = x_out_belt + 1
            x_right = x_mid_ins_r + 1
        else:
            # Тайл между столбцами оставляем пустым: в него смотрят выходы
            # жидкостей, и трубу туда поставить будет можно.
            x_mid_ins_l = x_out_belt = x_mid_ins_r = None
            x_right = x_left + w + 1
        x_right_ins = x_right_first_belt = None
        if supply_belts:
            x_right_ins = x_right + w
            x_right_first_belt = x_right_ins + 1
        # правый край группы: за лентой подачи, а без неё — сразу за заводами.
        # Ширина группы заранее посчитана в group_width_tiles — по ней раскладывались
        # ряды; здесь она не нужна (позиции групп заданы placements).
        x_end = (x_right_first_belt + supply_belts) if supply_belts else (x_right + w)
        height = (rows - 1) * pitch + h

        rotations.append((plan_left["direction"], plan_right["direction"]))
        for plan, x0 in ((plan_left, x_left), (plan_right, x_right)):
            for (px, py) in plan["reserved"]:
                reserved_all.add((x0 + px, py))
            port_all.extend((x0 + px, py) for (px, py) in plan["ports"])
        if drops_on_belt:
            sandwich_notes.append(
                "постройка сама кладёт продукт на ленту — манипуляторов на выход нет"
                + ("; между заводами оставлена клетка: в неё встаёт труба к портам"
                   if col_gap else ""))

        def put(name, x, y, direction=0, pickup=None, entity_type=None):
            nonlocal number
            ent = _entity(number, name, x, y, (1, 1), direction)
            if pickup is not None:
                # вылет на 2 тайла тем же манипулятором (bobinserters): поле в
                # координатах карты, как это пишет сама игра
                ent["pickup_position"] = bp.rotate_vec((0.0, -2.0), direction)
            if entity_type:
                # Роль погрузчика игра пишет полем `type` ("input"/"output") — так
                # это лежит в собственных чертежах игрока, см. device_place.
                ent["type"] = entity_type
            entities.append(ent)
            number += 1

        def machine(x, y, direction):
            nonlocal number
            ent = _entity(number, spec.machine, x, y, size, direction)
            if spec.recipe:
                ent["recipe"] = spec.recipe
                ent["recipe_quality"] = "normal"
            modules = _module_items(spec.modules)
            if modules:
                ent["items"] = modules
            entities.append(ent)
            number += 1

        def free_rows(column: int, top: int, need: int, ports: set | None = None) -> list[int]:
            """Свободные ряды коридора у этого завода — ближние к середине.

            Нужны, когда манипулятор один поток не тянет и его надо несколько:
            каждый встаёт в свой ряд, тайлы подключения труб остаются свободны.

            Если свободных рядов нет вовсе (у 3×3 завода с портами сверху и снизу
            вся полоса занята «соседями портов»), берём ряд, который не является
            тайлом самого порта: подключиться по нему всё равно можно, а без
            манипулятора завод просто встанет.
            """
            middle = top + h // 2
            candidates: list[int] = []
            for shift in (0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8):
                y = max(top, min(top + h - 1, middle + shift))
                if y not in candidates:
                    candidates.append(y)
            free = [y for y in candidates if (column, y) not in reserved_all]
            if len(free) >= need:
                return free[:need]
            # Добор: ряды рядом с портом, но не сам тайл порта.
            spare = [y for y in candidates if y not in free
                     and (not ports or (column, y) not in ports)]
            return (free + spare)[:need]

        def place_inserters(column: int, rows: list[int], name: str, direction: int,
                            far: bool = False, loader_type: str | None = None) -> None:
            """Манипуляторы у завода по уже посчитанным рядам (см. ниже).

            Последний ряд получает вылет на 2 тайла, если лент подачи две:
            он и берёт со второй, дальней ленты. Погрузчику вылет не помогает: он
            соединяет две СОСЕДНИЕ постройки, поэтому ему `pickup_position` не пишем
            (см. device_place и order_belts_for_reach).
            """
            if not name:
                return             # числа неизвестны — манипуляторов не ставим
            is_loader = device_is_loader(name, geom)
            place_direction, place_type = device_place(name, direction, geom, loader_type)
            for index, row in enumerate(rows):
                pickup = 2 if (far and index == len(rows) - 1 and not is_loader) else None
                put(name, column, row, place_direction, pickup, entity_type=place_type)

        def belt_rows_of_machine(machine_rows: list[int], entry_index: int) -> list[int]:
            """Ряды устройств одного завода, которые приходятся на эту ЛЕНТУ подачи.

            Лент подачи бывает две, у каждой свой манипулятор, и ряды делятся между
            ними по порядку (у дальней — свои ряды). И раскладка устройств, и
            разворот ленты в погрузчик обязаны считать это ОДИНАКОВО, иначе лента
            разворачивается не в тот ряд (этим и ломалось направление).
            """
            at = 0
            for index, belt in enumerate(in_belts):
                part = machine_rows[at:at + int(belt["count"])]
                at += len(part)
                if index == entry_index:
                    return part
            return []

        def place_input_inserters(column: int, rows: list[int], direction: int) -> None:
            """Манипуляторы на ВХОД: у каждой ленты подачи свой.

            `in_belts` идёт от ближней ленты к дальней, поэтому первые ряды берут с
            ближней ленты, а последние — с дальней (им и нужен вылет на 2 тайла).
            Так в чертеже оказывается ровно то, что посчитал сайт: например, на
            ленте угольной пыли погрузчик, а на ленте пары ресурсов механический
            манипулятор — по одному на завод, а не три погрузчика подряд.

            Устройство на входе обязано ВОЗИТЬ ОТ ЛЕНТЫ В ЗАВОД: у манипулятора это
            даёт направление 12 (запад), а у погрузчика — 4 (восток) и type "input"
            (см. device_place).
            """
            if not rows:
                return
            if not in_belts:
                place_inserters(column, rows, spec.inserter_in, direction, in_far,
                                loader_type="input")
                return
            for index, belt in enumerate(in_belts):
                # Ряды этой ленты считает belt_rows_of_machine: тот же расчёт нужен
                # и развороту ленты в погрузчик (belt_turn), иначе они разойдутся.
                part = belt_rows_of_machine(rows, index)
                name = belt["name"]
                is_loader = device_is_loader(name, geom)
                place_direction, place_type = device_place(name, direction, geom, "input")
                for row in part:
                    # Дальняя лента: вылет на 2 тайла — только манипулятору, и только
                    # если ленты подачи в блоке вообще есть (при погрузчике их нет —
                    # игрок подводит свою прямо к устройству, вылет не нужен).
                    pickup = 2 if (index > 0 and not is_loader
                                   and not loader_without_belts) else None
                    put(name, column, row, place_direction, pickup, entity_type=place_type)

        # Тайлы подключения труб всего блока: манипулятор на них не ставим.
        # Считаем ДО лент: свободные ряды решают, где встанут манипуляторы, а
        # значит и где кончаются ленты (см. belt_span ниже).
        port_tiles = set()
        for plan, x0 in ((plan_left, x_left), (plan_right, x_right)):
            port_tiles.update((x0 + px, py) for (px, py) in plan["ports"])

        in_far = supply_belts >= 2
        # Манипуляторы: имя приходит с сайта, оно выбрано в разделе
        # «Манипуляторы». Пустое имя = числа неизвестны (полный дамп без правок),
        # и тогда манипуляторы НЕ ставим вовсе: угадывать «за раз» и скорость
        # хуже, чем отдать честный скелет блока (заводы, ленты, столбы), в
        # который игрок поставит свои манипуляторы сам. Про это пишем в описании.
        #
        # Вход бывает НЕ ОДИН: у каждой ленты подачи свой манипулятор (сайт считает
        # ленты отдельно). Тогда работает список `in_belts`, и на дальней ленте
        # стоит тот, кто до неё достаёт (см. order_belts_for_reach).
        in_belts = inserter_belt_plan(spec.inserter_in_rows, supply_belts)
        if in_belts and in_far:
            in_belts = order_belts_for_reach(in_belts, geom, sandwich_notes)
        has_in_inserters = bool(in_belts) or bool(spec.inserter_in)
        has_out_inserters = bool(spec.inserter_out)
        out_count = max(1, int(spec.inserter_out_count or 1)) if has_out_inserters else 0
        # Сколько РЯДОВ входных манипуляторов нужно одному заводу.
        if in_belts:
            in_count = sum(int(belt["count"]) for belt in in_belts)
        else:
            in_count = (max(1, int(spec.inserter_in_count or 1)) + (1 if in_far else 0)
                        if spec.inserter_in else 0)
        if supply_belts and not has_in_inserters:
            sandwich_notes.append(
                "манипуляторы на вход не поставлены: неизвестно, какие у тебя есть и сколько "
                "они берут за раз — впиши их в разделе «Манипуляторы», и они появятся в чертеже")
        if out_belt and not has_out_inserters:
            sandwich_notes.append(
                "манипуляторы на выход не поставлены: неизвестно, какие у тебя есть и сколько "
                "они берут за раз — впиши их в разделе «Манипуляторы», и они появятся в чертеже")
        # «Если на вход был выбран погрузчик, ленты не строим вообще на подачу
        # ресурсов» (игрок). Причина: погрузчик берёт ленту ЦЕЛИКОМ, одной лентой
        # ряд заводов не кормится (её съест первый же погрузчик по ходу), а мод
        # Loaders Modernized вдобавок переворачивает погрузчик в «выгрузку», если
        # лента рядом идёт поперёк (scripts/snapping.lua). Поэтому ленты подачи не
        # ставим вовсе, а место под них оставляем — игрок подводит свои, прямо в
        # погрузчики (и в манипуляторы, если на другой ленте они).
        loader_without_belts = (any(device_is_loader(b["name"], geom) for b in in_belts)
                                or device_is_loader(spec.inserter_in, geom))
        if loader_without_belts and supply_belts:
            sandwich_notes.append(
                "на входе погрузчик: ленты подачи не построены — место под них оставлено, "
                "подведи их сам (погрузчик берёт ленту целиком, на ленту — один-два завода)")
        elif wanted_belts > 2:
            # Приписка, которую просил игрок: ясно сказать, СКОЛЬКО лент будет в
            # чертеже и сколько останется подвести самому.
            sandwich_problems.append(
                f"на вход нужно {wanted_belts} лент подачи, а в блоке помещается только 2 — "
                f"сгенерированы 2 ленты подачи, остальные {wanted_belts - supply_belts} "
                f"подведи сбоку вручную")

        def inserter_rows(column: int, top: int, count: int, far: bool) -> list[int]:
            """Ряды манипуляторов одного завода — те же, что встанут в чертёж."""
            if int(count or 0) <= 0:
                return []          # манипуляторов нет вовсе (см. has_*_inserters)
            need = max(1, int(count or 1)) + (1 if far else 0)
            rows = free_rows(column, top, need, port_tiles)
            if len(rows) < need:
                sandwich_notes.append(
                    f"манипуляторов нужно {need} у одного завода, а свободных тайлов "
                    f"рядом только {len(rows)} — часть придётся поставить вручную")
            return rows

        # Ряды манипуляторов по всем заводам группы: столбец подачи и выгрузки.
        # Шаг столбца — pitch (высота завода плюс, если надо, клетка под трубы).
        left_in_rows = [inserter_rows(x_left_ins, y0 + i * pitch, in_count, False)
                        for i in range(left_count)] if x_left_ins is not None else []
        mid_l_rows = [inserter_rows(x_mid_ins_l, y0 + i * pitch, out_count, False)
                      for i in range(left_count)] if x_mid_ins_l is not None else []
        right_in_rows = [inserter_rows(x_right_ins, y0 + i * pitch, in_count, False)
                         for i in range(right_count)] if x_right_ins is not None else []
        mid_r_rows = [inserter_rows(x_mid_ins_r, y0 + i * pitch, out_count, False)
                      for i in range(right_count)] if x_mid_ins_r is not None else []

        # Тайлы выгрузки «своими руками»: лента выгрузки обязана их накрыть —
        # иначе постройке некуда класть продукт и она встанет.
        drop_rows: list[int] = []
        if drops_on_belt:
            for plan, total in ((plan_left, left_count), (plan_right, right_count)):
                tile = drop_tile(spec.machine, plan["direction"], geom)
                if tile is None:
                    continue
                drop_rows.extend(y0 + index * pitch + tile[1] for index in range(total))

        def flat(rows_by_machine: list[list[int]]) -> list[int]:
            """Ряды всех машин группы одним списком."""
            return [y for machine_rows in rows_by_machine for y in machine_rows]

        def belt_span(rows: list[int]) -> tuple[int, int]:
            """Где начинается и где кончается лента: от крайнего манипулятора до крайнего.

            Манипулятор стоит в СЕРЕДИНЕ завода, поэтому лента по всей высоте
            столбцов торчала на ползавода выше первого манипулятора и на столько
            же ниже последнего — подключать её всё равно приходится у
            манипулятора, а лишние тайлы только мешают.
            """
            if not rows:
                return y0, y0 + height - 1
            return min(rows), max(rows)

        # Погрузчику нужна лента, которая ЕДЕТ В НЕГО: он берёт предметы с тайла
        # за спиной, а не сбоку. Иначе мод Loaders Modernized на постройке видит
        # ленту, идущую поперёк, и сам переключает погрузчик в «выгрузку»
        # (scripts/snapping.lua: «elseif belt.direction ~= entity.direction then
        # entity.loader_type = "output"»). Поэтому тайл ленты ПРЯМО ЗА погрузчиком
        # разворачиваем в него — ровно так в своих чертежах делает сам игрок:
        # лента заворачивает в погрузчик, а погрузчик кладёт в завод.
        # Выгрузке это не нужно: погрузчик на выходе кладёт на проходящую ленту
        # сбоку, а мод такую ленту и считает выходной (роль «output» не меняет).
        belt_turn: dict = {}
        if not loader_without_belts:
            for side_rows, x_first_belt, flip in (
                (left_in_rows, x_left_first_belt, True),
                (right_in_rows, x_right_first_belt, False),
            ):
                if x_first_belt is None or not in_belts:
                    continue
                for index, belt in enumerate(in_belts):
                    if not device_is_loader(belt["name"], geom):
                        continue
                    # Ближняя лента — та, что рядом с погрузчиком.
                    offset = (supply_belts - 1 - index) if flip else index
                    if offset < 0 or offset >= supply_belts:
                        continue
                    load_direction, _load_type = device_place(belt["name"],
                                                            12 if flip else 4, geom, "input")
                    for machine_rows in side_rows:
                        for row in belt_rows_of_machine(machine_rows, index):
                            belt_turn[(x_first_belt + offset, row)] = load_direction

        # Ленты подачи едут на север. Лента выгрузки — на юг (в другую сторону,
        # как в исходной заготовке) или тоже на север, если человек выбрал «в одну
        # сторону»: тогда и подача, и выгрузка подключаются с одного конца блока.
        # Если твёрдого нет ничего — лент не ставим вовсе (всё трубами).
        out_direction = 0 if spec.belt_sides == "same" else 8
        group_rows = flat(left_in_rows + mid_l_rows + right_in_rows + mid_r_rows)
        for x_first, count, span_rows, direction, is_input in (
            (x_left_first_belt, supply_belts, flat(left_in_rows), 0, True),
            (x_right_first_belt, supply_belts, flat(right_in_rows), 0, True),
            (x_out_belt, 1 if x_out_belt is not None else 0,
             drop_rows or flat(mid_l_rows + mid_r_rows), out_direction, False),
        ):
            if x_first is None or not count:
                continue
            if is_input and loader_without_belts:
                # Ленты подачи не строим: погрузчик берёт ленту целиком, а место под
                # неё оставляем свободным — игрок подводит свои (см. loader_without_belts).
                continue
            # У ленты своей стороны манипуляторов нет (группа из одного завода —
            # все заводы в левом столбце): тогда лента идёт по манипуляторам всей
            # группы, чтобы концы блока совпадали.
            span_from, span_to = belt_span(span_rows or group_rows)
            for y in range(span_from, span_to + 1):
                for offset in range(count):
                    # Тайл перед погрузчиком развёрнут В него (см. belt_turn выше):
                    # погрузчик берёт только то, что едет ему в спину.
                    put(spec.belt, x_first + offset, y,
                        belt_turn.get((x_first + offset, y), direction))

        for index in range(left_count):
            top = y0 + index * pitch
            machine(x_left, top, plan_left["direction"])
            if x_left_ins is not None:
                place_input_inserters(x_left_ins, left_in_rows[index], 12)
            if x_mid_ins_l is not None:
                place_inserters(x_mid_ins_l, mid_l_rows[index], spec.inserter_out, 12,
                                loader_type="output")
        for index in range(right_count):
            top = y0 + index * pitch
            machine(x_right, top, plan_right["direction"])
            if x_right_ins is not None:
                place_input_inserters(x_right_ins, right_in_rows[index], 4)
            if x_mid_ins_r is not None:
                place_inserters(x_mid_ins_r, mid_r_rows[index], spec.inserter_out, 4,
                                loader_type="output")

        # столбы: только для тех, кому нужно электричество, цепочкой вдоль коридоров
        if spec.pole:
            supply, wire = _supply_and_wire(spec.pole, geom)
            step = max(1, int(min(2 * supply, wire)))
            consumers = [bp.tiles_of(e, geom) for e in entities if needs_power(e["name"], geom)
                         and bp.tiles_of(e, geom)]
            occupied = {(bp.tiles_of(e, geom)[0], bp.tiles_of(e, geom)[1]) for e in entities
                        if bp.tiles_of(e, geom)} | reserved_all
            # Столб ставим ТОЛЬКО когда кто-то остался без питания, и он реально
            # накрывает кого-то нового: частокол из столбов не нужен — зона
            # покрытия у каждого широкая.
            #
            # Список столбов — на ВЕСЬ блок, а не на группу: иначе проверка
            # питания видела заводы прошлых групп и писала «без питания остался»,
            # хотя их накрывал столб соседней группы.
            last_in_column: dict = {}
            problems: list = []
            # `placed` — все столбы блока (по ним проверяем покрытие), а
            # `new_poles` — только что поставленные этой группой: их и добавляем
            # в блок, иначе столбы прошлых групп попадали бы в чертёж дважды.
            placed = placed_poles
            new_poles: list = []
            # Колонки для столбов прореживаем по горизонтали: зона покрытия
            # широкая, и четыре колонки подряд — лишний частокол.
            every = int(min(2 * supply, wire)) or 1
            # Столбцы для столбов — там, где стоят манипуляторы: они тоже
            # потребители, и столб у внешней стены до них не достаёт. Если
            # манипуляторов нет вовсе (этап на одних жидкостях), ставим столбы
            # сразу за портами труб, чтобы не загораживать подключение.
            pole_columns = [column for column in (x_left_ins, x_mid_ins_l, x_mid_ins_r, x_right_ins)
                            if column is not None]
            # Если рядом с манипуляторами свободных тайлов нет вовсе (у 3×3 завода
            # коридор целиком занят портами труб), ставим столбы у внешних стен —
            # там место есть, и заводы будут запитан, даже если до манипуляторов
            # столб не дотянется.
            usable = [c for c in pole_columns
                      if any((c, y) not in occupied for y in range(y0, y0 + height))]
            if not usable:
                usable = [x_left - 2, x_right + w + 1]
                sandwich_notes.append(
                    "рядом с манипуляторами места под столб нет — столбы поставлены "
                    "у внешних стен, часть манипуляторов придётся запитать вручную")
            pole_columns = usable
            columns: list = []
            for column in pole_columns:
                if not columns or column - columns[-1] >= every:
                    columns.append(column)
            last_column = pole_columns[-1]
            if last_column not in columns and last_column - columns[-1] >= every / 2:
                columns.append(last_column)
            for column in columns:
                y = y0
                while y < y0 + height:
                    if (column, y) in occupied:
                        y += 1
                        continue
                    uncovered = [c for c in consumers
                                 if not any(_covers(pl, c, supply) for pl in placed)]
                    # Только те, до кого ЭТА колонка вообще достаёт: столб у
                    # левой стены не накроет завод у правой, и раньше цикл
                    # застревал на нём до самого низа блока.
                    mine = [c for c in uncovered if _column_reaches(column, c, supply)]
                    if not mine:
                        # Этой колонке больше нечего накрывать: столб нужен
                        # только чтобы цепочка вдоль неё не разорвалась.
                        previous = last_in_column.get(column)
                        if previous is not None and (y - previous) >= wire:
                            placed.append((column, y))
                            new_poles.append((column, y))
                            occupied.add((column, y))
                            last_in_column[column] = y
                        y += 1
                        continue
                    # Столб ставим как можно НИЖЕ, пока он ещё накрывает самый
                    # верхний непокрытый завод: так он захватывает и следующие.
                    # Раньше столб вставал в первой же точке, где был полезен —
                    # и выходил частокол: 47 бойлеров обслуживали 45 столбов.
                    target = min(mine, key=lambda c: c[1])
                    previous = last_in_column.get(column)
                    # Дальше длины провода столб не поставить: иначе цепочка
                    # разорвётся. Так сам столб становится звеном.
                    #
                    # Предел — ДО КОНЦА ПОЛОСЫ ЭТОЙ ГРУППЫ (y0 + height - 1), а не
                    # «height - 1»: у второго и следующих рядов блока y0 уже
                    # десятки тайлов, и относительный предел делал range пустым —
                    # столбы в нижних рядах не ставились ВООБЩЕ, а заводы
                    # оставались без питания («без питания осталось построек»).
                    last_y = y0 + height - 1
                    limit = last_y if previous is None else min(
                        last_y, previous + max(1, int(wire)))
                    best = None
                    for candidate in range(y, limit + 1):
                        if (column, candidate) in occupied:
                            continue
                        # Накрытие по вертикали — интервал: слишком высоко ещё
                        # не достаёт, слишком низко уже не достаёт. Поэтому
                        # берём САМЫЙ НИЖНИЙ подходящий тайл, а не первый.
                        if _covers((column, candidate), target, supply):
                            best = candidate
                    if best is None:
                        # Накрыть в пределах провода нечем: ставим хотя бы
                        # звено цепочки, а покрытие догоним ниже.
                        for candidate in range(y, limit + 1):
                            if (column, candidate) not in occupied:
                                best = candidate
                    if best is None:
                        y += 1
                        continue
                    placed.append((column, best))
                    new_poles.append((column, best))
                    occupied.add((column, best))
                    last_in_column[column] = best
                    y = best + 1
            # проверяем, что все потребители накрыты и что цепочка вдоль столбца цела
            starved = [consumer for consumer in consumers
                       if not any(_covers(p, consumer, supply) for p in placed)]
            if starved:
                # Одним замечанием, а не двадцатью строками: список построек в
                # описании чертежа читать невозможно.
                sandwich_notes.append(
                    f"без питания осталось построек: {len(starved)} — поставь столбы вручную")
            for column in pole_columns:
                ys = sorted(y for (x, y) in new_poles if x == column)
                gaps = [b - a for a, b in zip(ys, ys[1:])]
                if any(g > wire for g in gaps):
                    problems.append(f"разрыв цепочки столбов в колонке x={column}: {gaps}")
            placed_poles.extend(new_poles)
            for (px, py) in new_poles:
                entities.append(_entity(number, spec.pole, px, py, (1, 1), 0))
                number += 1
            if problems:
                sandwich_problems.extend(problems)

    # Сеть столбов должна быть ОДНОЙ. Колонки считаются по группам, поэтому у
    # блока из нескольких групп (или рядов) цепи оказывались не связанными: между
    # группами больше длины провода, и в игре это выглядит как «столбы стоят, а
    # провода нет». Здесь между такими сетями ставится промежуточный столб.
    if spec.pole and placed_poles:
        _supply, wire = _supply_and_wire(spec.pole, geom)
        # Занятые тайлы — ПОЛНЫМИ габаритами построек: tiles_of даёт только левый
        # верхний тайл, а столб внутри 6×6 завода ставить нельзя.
        blocked: set = occupied_tiles(entities, geom, reserved_all)
        extra_poles, wire_notes = connect_pole_network(
            placed_poles, blocked, wire=wire)
        for (px, py) in extra_poles:
            entities.append(_entity(number, spec.pole, px, py, (1, 1), 0))
            number += 1
        if extra_poles:
            placed_poles.extend(extra_poles)
        sandwich_problems.extend(wire_notes)

    total = sum(groups)
    split = "+".join(str(g) for g in groups)
    label = spec.label or f"{spec.machine} × {total}"
    # Куда едет выгрузка — видно в описании чертежа: подключаясь к блоку, это
    # первое, что нужно знать.
    if out_belt:
        if spec.belt_sides == "same":
            sandwich_notes.append(
                "лента выгрузки едет в ту же сторону, что ленты подачи: и вход, и выход "
                "подключаются с одного конца блока (настройка «в одну сторону»)")
        else:
            sandwich_notes.append(
                "лента выгрузки едет в другую сторону от подачи: вход с одного конца "
                "блока, выход с другого (настройка «в разные стороны»)")
    # ПРОВОДА между столбами: без них игра ставит столбы без проводов (чертёж
    # помнит связи и всегда строит именно их — см. bp.connect_power_wires).
    if spec.pole:
        wires = bp.connect_power_wires({"blueprint": {"entities": entities}}, geom)
        if len(wires["components"]) > 1:
            sandwich_problems.append(
                f"столбы разбились на {len(wires['components'])} сети: провод между ними "
                f"не дотягивается — часть блока останется без питания, поставь столб между ними")
        elif wires["poles"] > 1 and not wires["wires"]:
            sandwich_problems.append(
                "провода между столбами не прописаны: они стоят дальше вылета провода")
    # Завод, который в игре не скрафтить: сказать об этом в самом чертеже.
    craft_note = machine_craft_note(spec.machine, spec.dataset_id)
    if craft_note:
        sandwich_problems.append(craft_note)
    blueprint = {"item": "blueprint", "version": BLUEPRINT_VERSION,
                 "label": f"{label} ({split})", "entities": entities}
    if sandwich_problems or sandwich_notes:
        # предупреждения (например «нужно 3 ленты подачи, а влезает 2») и пояснения
        # (например «у рецепта только жидкости») видны прямо в описании блюпринта.
        # Повторы убираем: заметки собираются по ГРУППАМ, а факт общий («на входе
        # погрузчик: ленты подачи не построены») — один на весь блок.
        seen: set = set()
        lines: list = []
        for line in sandwich_problems + sandwich_notes:
            if line in seen:
                continue
            seen.add(line)
            lines.append(line)
        blueprint["description"] = "\n".join(lines)
    return {"blueprint": blueprint}


def generate_grouped_block(spec: BlockSpec, geometry: dict | None = None) -> dict:
    """Устаревшее имя: теперь группы собираются «бутербродом»."""
    return generate_sandwich_block(spec, geometry)


def _legacy_row_groups(spec: BlockSpec, geometry: dict | None = None) -> dict:
    """Блок из нескольких рядов — по одному на каждую группу заводов.

    Калькулятор делит этап на группы по ёмкости ленты (например графит:
    17+17+17+17+16+16 — шесть групп, каждой своя лента). Строить это одним
    рядом в сотню заводов бессмысленно: лента столько не увезёт. Поэтому каждая
    группа становится СВОИМ рядом со своей входной и выходной лентой, а ряды
    ставятся друг под другом с зазором в один тайл.
    """
    geom = geometry if geometry is not None else bp.load_geometry()
    size = bp.entity_size(spec.machine, geom)
    if not size:
        raise ValueError(f"не знаю размер постройки {spec.machine}")
    groups = [int(g) for g in (spec.groups or []) if int(g) > 0]
    if not groups:
        groups = [spec.count]
    if len(groups) == 1:
        return generate_row_block(replace(spec, count=groups[0], groups=None), geom)

    pitch = size[1] + 5  # ряд заводов + 2 ленты + 2 ряда манипуляторов + зазор
    entities: list = []
    number = 1
    for index, count in enumerate(groups):
        row = generate_row_block(replace(spec, count=count, groups=None), geom)
        row = bp.translate(row, 0, index * pitch)
        for ent in bp.blueprint_of(row).get("entities") or []:
            ent["entity_number"] = number
            number += 1
            entities.append(ent)

    total = sum(groups)
    split = "+".join(str(g) for g in groups)
    label = spec.label or f"{spec.machine} × {total}"
    if spec.pole:
        # Столбы рядов соединяем ПОСЛЕ сборки: ряды ставятся друг под другом, и
        # провод между рядами надо тянуть по всему блоку, а не внутри ряда.
        wires = bp.connect_power_wires({"blueprint": {"entities": entities}}, geom)
        if len(wires["components"]) > 1:
            sandwich_problems.append(
                f"столбы рядов разбились на {len(wires['components'])} сети: провод между ними "
                f"не дотягивается — поставь столб между рядами, иначе часть блока без питания")
    blueprint = {"item": "blueprint", "version": BLUEPRINT_VERSION,
                 "label": f"{label} ({split})", "entities": entities}
    if sandwich_problems:
        blueprint["description"] = "\n".join(sandwich_problems)
    return {"blueprint": blueprint}


def block_string(spec: BlockSpec, geometry: dict | None = None) -> str:
    return bp.encode_string(generate_grouped_block(spec, geometry))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Собрать блюпринт «ряд заводов» (шаблон 1)")
    ap.add_argument("machine")
    ap.add_argument("recipe", nargs="?", default=None)
    ap.add_argument("count", nargs="?", type=int, default=5)
    ap.add_argument("--belt", default="transport-belt")
    ap.add_argument("--inserter-in", default="inserter", dest="inserter_in")
    ap.add_argument("--inserter-out", default="inserter", dest="inserter_out")
    ap.add_argument("--pole", default=None)
    ap.add_argument("--module", action="append", default=[], help="имя=количество")
    ap.add_argument("--stub", type=int, default=DEFAULT_STUB)
    ap.add_argument("--label", default="")
    ap.add_argument("--json", action="store_true", help="напечатать JSON блюпринта")
    args = ap.parse_args(argv[1:])

    modules = {}
    for item in args.module:
        name, _, count = item.partition("=")
        modules[name] = int(count or 0)

    spec = BlockSpec(machine=args.machine, count=args.count, recipe=args.recipe, modules=modules,
                     belt=args.belt, inserter_in=args.inserter_in, inserter_out=args.inserter_out,
                     pole=args.pole, stub=args.stub, label=args.label)
    obj = generate_row_block(spec)
    if args.json:
        print(json.dumps(obj, ensure_ascii=False, indent=1))
    else:
        print(block_string(spec))
        print()
        print(bp.layout_summary(obj))
        problems = bp.validate(obj)
        print("Замечания:", problems if problems else "нет")
        reservation = reserve_fluid_tiles(spec.machine, spec.recipe, spec.count,
                                          None, spec.dataset_id)
        if reservation["tiles"]:
            print(f"Тайлы под газ/жидкость оставлены свободными ({len(reservation['tiles'])}): "
                  f"{reservation['tiles'][:12]}{' ...' if len(reservation['tiles']) > 12 else ''}")
            print("  жидкости рецепта:", reservation["fluids"])
        if reservation["unreachable"]:
            print(f"Недостижимые подключения (тайл занимает сам завод или сосед): "
                  f"{len(reservation['unreachable'])}")
        access = check_fluid_access(obj, None, spec.dataset_id)
        bad = [p for p in access if p["level"] == "error"]
        print("Проверка доступа труб:", "все тайлы свободны" if not bad else bad)
    return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv))


def chain_blueprint(stages: list[dict], geometry: dict | None = None,
                    dataset_id: str | None = None, chest: str = "requester-chest",
                    provider: str = "passive-provider-chest",
                    inserter: str = "inserter") -> dict:
    """Чертёж ВСЕЙ цепочки на сундуках запроса.

    Каждый этап — свой ряд:

        [сундук запроса][манипулятор][заводы ...][манипулятор][сундук-поставщик]

    В сундуке запроса выставлено, ЧТО этапу нужно (твёрдые входы рецепта, с
    количеством на весь ряд заводов), а продукция уезжает в сундук-поставщик —
    следующий этап запросит её сам. Так цепочку можно отстроить и проверить
    числами, не протягивая ленты через всю базу.

    stages: [{machine, recipe, count, modules, inputs?}] — по одному на этап.
    """
    geom = geometry if geometry is not None else bp.load_geometry()
    entities: list = []
    number = 1
    y = 0
    notes: list = []
    for stage in stages:
        machine = stage.get("machine")
        recipe = stage.get("recipe")
        count = max(1, int(stage.get("count") or 1))
        size = bp.entity_size(machine, geom)
        if not size:
            notes.append(f"{machine}: не знаю размер, этап пропущен")
            continue
        w, h = size
        solids = stage.get("inputs")
        if solids is None:
            solids = stage_solid_inputs(recipe, count, dataset_id)
        # сундук запроса с тем, что нужно этапу
        chest_ent = _entity(number, chest, -3, y, (1, 1), 0)
        number += 1
        filters = request_filters([{"name": n, "count": int(round(a))}
                                   for n, a in solids.items()])
        if filters:
            chest_ent["request_filters"] = {"sections": [{"index": 1, "filters": filters}]}
        entities.append(chest_ent)
        entities.append(_entity(number, inserter, -2, y, (1, 1), 12))
        number += 1
        for i in range(count):
            ent = _entity(number, machine, i * w, y, size, 0)
            if recipe:
                ent["recipe"] = recipe
                ent["recipe_quality"] = "normal"
            modules = _module_items(stage.get("modules") or {})
            if modules:
                ent["items"] = modules
            entities.append(ent)
            number += 1
        entities.append(_entity(number, inserter, count * w, y, (1, 1), 4))
        number += 1
        entities.append(_entity(number, provider, count * w + 1, y, (1, 1), 0))
        number += 1
        # Маяков в чертеже цепочки тоже нет: их игрок ставит сам, а сайт считает
        # их в эффектах и в сундуке запроса (см. build_list).
        y += h + 2

    label = "Цепочка на сундуках запроса"
    blueprint = {"item": "blueprint", "version": BLUEPRINT_VERSION,
                 "label": label, "entities": entities}
    if notes:
        blueprint["description"] = "\n".join(notes)
    return {"blueprint": blueprint}


def stage_solid_inputs(recipe: str | None, machines: int, dataset_id: str | None = None) -> dict:
    """Твёрдые входы рецепта на весь ряд заводов: {предмет: сколько за один цикл}."""
    path = dataset_path(dataset_id)
    if not path or not recipe:
        return {}
    import json as _json

    with path.open(encoding="utf-8") as f:
        data = _json.load(f)
    rec = (data.get("recipes") or {}).get(recipe) or {}
    out = {}
    for ing in rec.get("ingredients") or []:
        if ing.get("type") != "item":
            continue
        out[ing.get("name")] = (ing.get("amount") or 1) * max(1, machines)
    return out


def dataset_items(dataset_id: str | None = None) -> dict:
    """Таблица предметов датасета: нужно и для имён, и для подписей."""
    path = dataset_path(dataset_id)
    if not path:
        return {}
    import json as _json

    with path.open(encoding="utf-8") as f:
        data = _json.load(f)
    return data.get("items") or {}


def dataset_item_names(dataset_id: str | None = None) -> set:
    """Имена предметов датасета (нужны, чтобы понять, чем ставится постройка)."""
    return set(dataset_items(dataset_id).keys())


def build_list(stages: list[dict], geometry: dict | None = None,
               dataset_id: str | None = None) -> dict:
    """Что нужно, чтобы отстроить цепочку: {предмет: количество}.

    Считаем не сырьё, а СТРОЙМАТЕРИАЛЫ: собираем блок каждого этапа тем же
    генератором, что и кнопка «Блюпринт», и считаем, сколько каких предметов в
    него встало — заводы, ленты, манипуляторы, столбы, модули, сундуки.
    """
    geom = geometry if geometry is not None else bp.load_geometry()
    counts: dict = {}
    items_table = dataset_items(dataset_id)
    known_items = set(items_table.keys())

    dropped: set = set()

    def add(name: str | None, amount: int = 1):
        if not name or amount <= 0:
            return
        if known_items and name not in known_items:
            # такого предмета в игре нет — запрос по нему игра выбросит
            dropped.add(name)
            return
        counts[name] = counts.get(name, 0) + amount

    notes: list = []
    partial = False

    def add_beacons(rows: list) -> None:
        """Маяки этапа в закупку — по ЗАКАЗАННОМУ числу.

        Число маяков посчитал сайт (по одному на строку — строка и есть маяк):
        игроку нужно построить именно столько. Модули считаем на КАЖДЫЙ маяк: в
        одном маяке лежит столько, сколько описано в его строке. В раскладку
        блока маяки не входят вовсе (их игрок ставит сам), поэтому сверять тут
        не с чем — закупка берёт заказ как есть.
        """
        for row in rows:
            if row["count"] <= 0:
                continue
            add(_item_of(row["name"], geom, known_items), row["count"])
            for module_name, module_count in row["modules"].items():
                add(module_name, module_count * row["count"])

    for stage in stages:
        count = max(1, int(stage.get("count") or 1))
        machine = stage.get("machine")
        # Манипуляторы: null значит «числа неизвестны» (полный дамп без правок) —
        # тогда их не ставим и не заказываем (см. has_*_inserters в генераторе).
        inserter_in = stage.get("inserterIn") or None
        inserter_out = stage.get("inserterOut") or None
        # Вход по лентам: у каждой ленты свой манипулятор (см. BlockSpec.inserter_in_rows).
        # Пусто — старый формат с одним именем на весь вход.
        inserter_in_rows = stage.get("inserterInRows") or None
        beacon_order = beacon_rows(stage.get("beacons"))
        spec = BlockSpec(machine=machine, recipe=stage.get("recipe"), count=count,
                         groups=stage.get("groups"),
                         modules=dict(stage.get("modules") or {}),
                         belt=stage.get("belt") or "transport-belt",
                         inserter_in=inserter_in,
                         inserter_out=inserter_out,
                         inserter_in_rows=inserter_in_rows,
                         inserter_in_count=max(1, int(stage.get("inserterInCount") or 1)) if inserter_in else 0,
                         inserter_out_count=max(1, int(stage.get("inserterOutCount") or 1)) if inserter_out else 0,
                         pole=stage.get("pole"),
                         belt_sides=stage.get("beltSides") or "same",
                         row_groups=stage.get("rowGroups"),
                         input_belts=stage.get("inputBelts"))
        try:
            obj = generate_sandwich_block(spec, geom)
        except Exception as exc:   # noqa: BLE001 — закупка нужна при любой поломке блока
            # Блок не собирается (например завод неизвестен) — но закупка всё
            # равно нужна: считаем хотя бы заводы и манипуляторы к ним.
            # Блок не собрать: считаем по одному манипулятору на вход и на выход
            # (как в обычной раскладке с одной лентой подачи).
            partial = True
            add(_item_of(machine, geom, known_items), count)
            # Манипуляторы — только если их имя известно (см. inserter_in выше):
            # при null заказывать нечего, и обещать их в закупке нельзя.
            add(_item_of(inserter_in, geom, known_items), count)
            add(_item_of(inserter_out, geom, known_items), count)
            # Маяки нужны и здесь: не из-за раскладки, а потому что игрок их
            # заказал — «блок не встал» не отменяет модули в маяках.
            add_beacons(beacon_order)
            ins_tail = "" if (inserter_in or inserter_out) else " (манипуляторов нет: их числа неизвестны)"
            tail = ("; маяки с модулями — по заказу игрока" if beacon_order else "")
            notes.append(f"{machine or stage.get('recipe')}: блок не собрать ({exc}) — "
                         f"в закупке только заводы и манипуляторы{tail}{ins_tail}")
            continue
        # Завод, который в игре не скрафтить (только скрытым рецептом), в сундуке
        # запроса — не мелочь: игрок закажет постройку, которой у него быть не может.
        craft_note = machine_craft_note(machine, dataset_id)
        if craft_note:
            notes.append(f"{machine}: {craft_note}")
        # Больше двух лент подачи — блок собирается, но предупреждаем: часть
        # придётся доделывать руками. Та же приписка, что в описании чертежа:
        # сколько лент будет в блоке и сколько останется подвести самому.
        # Число лент подачи: с сайта (там игрок мог задать группы) или своё,
        # посчитанное по рецепту — иначе честная приписка не дошла бы до игрока
        # в том случае, когда ленты считает генератор, а не сайт.
        needed = int(stage.get("inputBelts") or supply_belt_count(spec, spec.dataset_id) or 0)
        if needed > 2:
            notes.append(f"{machine}: на вход нужно {needed} лент подачи, в блоке помещается "
                         f"только 2 — сгенерированы 2 ленты подачи, остальные {needed - 2} "
                         f"подведи сбоку вручную")
        for ent in bp.iter_entities(obj):
            name = ent.get("name")
            add(_item_of(name, geom, known_items))   # чем ставится постройка
            for module_name, module_count in (entity_modules_of(ent)).items():
                add(module_name, int(module_count))
        # Маяки в закупке — по заказу игрока; в чертеже блока их нет, поэтому и
        # сверять «сколько встало» не с чем.
        add_beacons(beacon_order)
    if dropped:
        notes.append("в запрос не попали предметы, которых нет в игре: " + ", ".join(sorted(dropped)))
    if partial:
        notes.append("собрать всю цепочку не получилось — в сундуке только фабрики и "
                     "манипуляторы тех этапов, где блок не встал, и маяки, если этап их заказывал")
    # Подпись предмета в описании чертежа: её же видно в игре в тултипе.
    names = {}
    for k in counts:
        row = items_table.get(k)
        names[k] = (row or {}).get("display_name") if isinstance(row, dict) else None
    return {"items": [{"name": k, "count": v, "display": names.get(k) or k}
                      for k, v in sorted(counts.items())],
            "notes": notes,
            "partial": partial}


def build_minimal_list(stages: list[dict], geometry: dict | None = None,
                       dataset_id: str | None = None) -> dict:
    """Закупка «на худой конец»: заводы, манипуляторы и маяки, без раскладки.

    Нужна на случай, когда считать блоки не выходит совсем. Сундук запроса всё
    равно должен создаться — по одному манипулятору на вход и на выход каждому
    заводу (как в обычной раскладке с одной лентой подачи). Маяки этапа сюда
    тоже попадают: их заказал игрок, и «раскладка не собралась» не отменяет ни
    самих маяков, ни модулей в них.
    """
    geom = geometry if geometry is not None else bp.load_geometry()
    items_table = dataset_items(dataset_id)
    known_items = set(items_table.keys())
    counts: dict = {}

    def put(name: str | None, amount: int):
        item = _item_of(name, geom, known_items)
        if item and (not known_items or item in known_items) and amount > 0:
            counts[item] = counts.get(item, 0) + amount

    for stage in stages:
        count = max(1, int(stage.get("count") or 1))
        for name in (stage.get("machine"),
                     stage.get("inserterIn") or "inserter",
                     stage.get("inserterOut") or "inserter"):
            put(name, count)
        for row in beacon_rows(stage.get("beacons")):
            put(row["name"], row["count"])
            for module_name, module_count in row["modules"].items():
                put(module_name, module_count * max(0, row["count"]))
    names = {}
    for k in counts:
        row = items_table.get(k)
        names[k] = (row or {}).get("display_name") if isinstance(row, dict) else None
    return {"items": [{"name": k, "count": v, "display": names.get(k) or k}
                      for k, v in sorted(counts.items())],
            "notes": ["раскладку собрать не удалось — в сундуке только фабрики, "
                      "манипуляторы и маяки с модулями"],
            "partial": True}


def _item_of(name: str | None, geometry: dict | None = None,
             known_items: set | None = None) -> str | None:
    """Предмет, которым ставится постройка.

    Сначала пробуем имя самой постройки: у модов поле placeable_by бывает
    переопределено (в этом дампе, например, сущность bob-red-inserter помечена
    как ставящаяся предметом long-handed-inserter), а игроку нужен тот предмет,
    который реально лежит в сундуке.
    """
    if not name:
        return None
    if known_items and name in known_items:
        return name
    rec = bp.entity_record(name, geometry) or {}
    # Имя постройки не предмет (так бывает у модов: сущность bob-red-inserter
    # ставится предметом long-handed-inserter) — берём то, что в дампе
    # записано в placeable_by/minable. Несуществующий предмет игра из запросов
    # выбрасывает, и сундук остаётся пустым.
    return rec.get("item") or name


def entity_modules_of(ent: dict) -> dict:
    """Модули в записи блюпринта: {имя: количество} (формат игры 2.0)."""
    out: dict = {}
    raw = ent.get("items") or []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            ident = item.get("id")
            name = ident.get("name") if isinstance(ident, dict) else ident
            inner = item.get("items")
            count = item.get("items_in_inventory")
            if count is None and isinstance(inner, dict) and isinstance(inner.get("in_inventory"), list):
                count = len(inner["in_inventory"])
            if name:
                out[name] = max(out.get(name, 0), int(count or 0))
    return out


def blueprint_entities(obj: dict) -> list[dict]:
    """Сущности блюпринта — и простого, и книги чертежей.

    Книга раскладывается: считаем всё, что в ней лежит, а не только первую
    страницу — иначе сундук не попросит половину нужного.
    """
    out: list = []
    blueprints = obj.get("blueprints") if isinstance(obj, dict) else None
    if isinstance(blueprints, list):
        for item in blueprints:
            if isinstance(item, dict):
                out.extend(blueprint_entities(item))
        return out
    inner = obj.get("blueprint") if isinstance(obj, dict) else None
    if isinstance(inner, dict):
        out.extend(_as_list(inner.get("entities")))
        for item in _as_list(inner.get("blueprints")):
            out.extend(blueprint_entities(item))
    return out


def _as_list(value) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return list(value.values())
    return []


def items_for_blueprint(obj: dict, geometry: dict | None = None,
                        dataset_id: str | None = None) -> dict:
    """Что нужно, чтобы построить этот чертёж: предметы и их количество.

    Считаем ровно то, чем игра ставит постройки (поле placeable_by в дампе), и
    модули, которые лежат ВНУТРИ построек — их тоже надо принести. Тайлы пола и
    «настройки» построек (рецепты, фильтры) предметами не являются.
    """
    geom = geometry if geometry is not None else bp.load_geometry()
    items_table = dataset_items(dataset_id)
    known_items = set(items_table.keys())
    counts: dict = {}
    per_entity: dict = {}
    unknown: set = set()
    dropped: set = set()

    def add(name: str | None, amount: int = 1):
        if not name or amount <= 0:
            return
        if known_items and name not in known_items:
            dropped.add(name)
            return
        counts[name] = counts.get(name, 0) + amount

    for ent in blueprint_entities(obj):
        if not isinstance(ent, dict):
            continue
        name = ent.get("name")
        if not name:
            continue
        item = _item_of(name, geom, known_items)
        add(item)
        per_entity[name] = per_entity.get(name, 0) + 1
        if not item or (known_items and item not in known_items):
            unknown.add(str(name))
        for module_name, module_count in entity_modules_of(ent).items():
            add(module_name, int(module_count))

    names = {}
    for key in counts:
        row = items_table.get(key)
        names[key] = (row or {}).get("display_name") if isinstance(row, dict) else None
    return {
        "items": [{"name": k, "count": v, "display": names.get(k) or k}
                  for k, v in sorted(counts.items())],
        "entities": [{"name": k, "count": v} for k, v in sorted(per_entity.items())],
        "total_entities": sum(per_entity.values()),
        "unknown": sorted(unknown),
        "dropped": sorted(dropped),
    }


def chest_for_blueprint(obj: dict, geometry: dict | None = None,
                        dataset_id: str | None = None,
                        label: str | None = None) -> dict:
    """Сундук запроса на всё, что нужно для вставленного чертежа."""
    data = items_for_blueprint(obj, geometry, dataset_id)
    if label:
        chest = shopping_chest(data["items"], label=label)
    else:
        # «по вставленному блюпринту» — готовая фраза, а не имя цепочки.
        chest = shopping_chest(data["items"], phrase="по вставленному блюпринту")
    return {"chest": chest, **data}


def request_filters(items: list[dict], per_request_cap: int = 100000) -> list[dict]:
    """Запросы сундука в формате Factorio 2.0.

    Набор полей снят с рабочего чертежа игрока: index, name, quality,
    comparator, count (max_count игра не пишет). Плоский список запросов игра
    молча игнорирует — сундук ставится пустым.
    """
    out: list = []
    for row in items:
        if not row.get("name") or not row.get("count"):
            continue
        out.append({"index": len(out) + 1, "name": row["name"],
                    "quality": "normal", "comparator": "=",
                    "count": min(int(row["count"]), int(per_request_cap))})
    return out


def _positions_ru(n: int) -> str:
    """«3 позиции», а не «3 позиций» — название чертежа видит игрок."""
    n10, n100 = n % 10, n % 100
    if n10 == 1 and n100 != 11:
        return f"{n} позиция"
    if 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        return f"{n} позиции"
    return f"{n} позиций"


def shopping_chest(items: list[dict], chest: str = "requester-chest",
                   per_request_cap: int = 100000,
                   label: str | None = None,
                   item_names: dict | None = None,
                   phrase: str | None = None) -> dict:
    """Один сундук запроса, в котором выставлено всё, что нужно для постройки.

    label — имя цепочки с сайта: попадает в название чертежа, чтобы в игре было
    видно, к какой цепочке сундук относится. phrase — готовая фраза вместо имени
    цепочки (например «по вставленному блюпринту»). item_names — как показывать
    предметы в описании (по-русски), если сайт их знает.
    """
    entities: list = []
    chest_ent = _entity(1, chest, 0, 0, (1, 1), 0)
    filters = request_filters(items, per_request_cap)
    if filters:
        chest_ent["request_filters"] = {"sections": [{"index": 1, "filters": filters}]}
    entities.append(chest_ent)
    if phrase:
        chain = f" {phrase}"
    elif label:
        chain = f" для цепочки «{label}»"
    else:
        chain = " на цепочку"
    shown = dict(item_names or {})
    for row in items:
        if row.get("name") and row.get("display"):
            shown.setdefault(row["name"], row["display"])
    if langtr.is_en():   # English page: the dump's Russian names -> readable internal ids
        shown = {name: name.replace("-", " ").replace("_", " ").capitalize() for name in shown}
        shown.update({f["name"]: f["name"].replace("-", " ").replace("_", " ").capitalize() for f in filters})
    lines = [f"  {shown.get(f['name']) or f['name']} — {f['count']}" for f in filters]
    description = (f"Сундук запроса{chain}: {_positions_ru(len(filters))}.\n"
                   "Вставь его рядом со стройкой — он сам запросит всё это из логистики.\n"
                   + "\n".join(lines))
    return {"blueprint": {"item": "blueprint", "version": BLUEPRINT_VERSION,
                          "label": f"Закупка{chain} ({_positions_ru(len(filters))})",
                          "description": description,
                          "entities": entities}}
