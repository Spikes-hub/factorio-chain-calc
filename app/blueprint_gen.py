"""Генератор раскладки блюпринтов.

Основная раскладка — блок «бутербродом» (generate_sandwich_block): два столбца заводов,
между ними лента выгрузки, ленты подачи по внешним сторонам, манипуляторы или
погрузчики между лентами и заводами, столбы электропередачи по коридорам.

Раскладка в один ряд (generate_row_block), в тайлах (W — ширина завода, H — высота):

    y = -2      входная лента, едет на ВОСТОК
    y = -1      манипуляторы: берут с севера (лента), кладут на юг (в завод)
    y = 0..H-1  ряд заводов вплотную (шаг = W)
    y = H       манипуляторы: берут с севера (из завода), кладут на юг (на ленту)
    y = H+1     выходная лента, едет на ЗАПАД

Столбы ставятся в ряд манипуляторов (y = H) в свободные тайлы с шагом по зоне
питания, а если места не хватило — в ряд входных манипуляторов (y = -1).

Пример запуска:

    python app\\blueprint_gen.py automated-screener-mk01 coarse-coal 5 ^
        --belt fast-transport-belt --inserter-in burner-inserter ^
        --inserter-out bob-red-inserter --pole bob-medium-electric-pole-2
"""
from __future__ import annotations

import argparse
import contextvars
import json
import math
from dataclasses import dataclass, field, replace
from pathlib import Path

import block_pipes
import blueprint as bp
import langtr

# Версия блюпринта (формат Factorio 2.0.77).
BLUEPRINT_VERSION = 562949958467584

# Инвентарь модулей завода в блюпринте: inventory = 4 (defines.inventory.crafter_modules).
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
    # Резервировать ли тайлы под газ/жидкость: трубы не ставятся, но тайлы остаются свободными.
    reserve_fluid_tiles: bool = True
    # Маяки в раскладку не входят: их считает сайт (эффект заводов и сундук запроса).
    dataset_id: str | None = None
    # Подземные трубы от портов жидкости, смотрящих наружу блока (см. block_pipes).
    # Выключено по умолчанию: ширина промежутка между группами растёт под стволы.
    pipes: bool = False
    pipe: str = "pipe"
    pipe_ground: str = "pipe-to-ground"
    # Топливо, которое жжёт завод. Если от него остаётся пепел (burnt_result), пепел уезжает с завода по ленте
    # выгрузки, даже когда продукты рецепта — одни жидкости.
    fuel: str | None = None


NO_SAMPLE_MARKS = ("смотрит вдоль стенки", "нет бокса под жидкость", "уже идёт цепочка другой жидкости",
                   "в одну сеть труб")


class UnsupportedLayout(ValueError):
    """Для этой ситуации нет образца раскладки: блок не собирается, а причина пишется пользователю."""


def unsupported_message(spec: "BlockSpec", reasons: list[str]) -> str:
    """Текст отказа: что именно не удалось и как получить блок."""
    seen: list[str] = []
    for reason in reasons:
        if reason not in seen:
            seen.append(reason)
    shown = "; ".join(seen[:4]) + (f"; и ещё {len(seen) - 4}" if len(seen) > 4 else "")
    return (f"Блок «{spec.recipe or '?'}» на заводе «{spec.machine}» пока собрать нельзя: для этой ситуации нет "
            f"образца раскладки труб. Что не удалось: {shown}. "
            "Пришли шаблон, как такой блок строится вручную (папка templates), и генератор научится. "
            "Без подземных труб блок собирается: сними галочку «подземные трубы от внешних портов жидкости», тайлы под "
            "жидкости останутся свободными.")


def machine_is_craftable(machine: str | None, dataset_id: str | None = None) -> bool | None:
    """Можно ли получить этот завод: False — только скрытым рецептом.

    Рецепт с `hidden` в меню крафта не показывается. В Py так скрыт ванильный
    химический завод: он есть в дампе и подходит под «химию», но построить его нельзя.

    True — есть хотя бы один обычный рецепт-постановщик, False — все скрытые,
    None — рецепта в дампе нет. Тот же смысл у machineBuildable в public/js/app.js.
    """
    path = dataset_path(dataset_id)
    if not path or not machine:
        return None
    import json as _json

    data = _dataset(path)
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

    Пишется в сам чертёж, чтобы оно было видно и после импорта в игру.
    """
    if machine_is_craftable(machine, dataset_id) is not False:
        return None
    label = machine
    path = dataset_path(dataset_id)
    if path:
        import json as _json

        data = _dataset(path)
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

    Манипулятор: направление — «откуда берёт» (12 = берёт с запада, кладёт на восток).
    Погрузчик: направление — «куда везёт» (берёт с тайла за спиной, кладёт вперёд),
    поэтому для того же переноса число противоположно манипулятору, а роль задаётся
    полем `type` ("input" на входе, "output" на выходе).
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


_DATASET_CACHE: dict = {}


def _dataset(path: Path) -> dict:
    """Дамп из файла с памятью: генератор спрашивает его по нескольку раз на блок, а
    файл весит ~10 МБ (на каждое чтение уходило около 0.1 с). Ключ — путь, время
    изменения и размер, поэтому новый дамп подхватывается сразу. Держим один дамп."""
    stat = path.stat()
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    cached = _DATASET_CACHE.get("entry")
    if cached and cached[0] == key:
        return cached[1]
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    _DATASET_CACHE["entry"] = (key, data)
    return data


def dataset_path(dataset_id: str | None = None) -> Path | None:
    # Папка датасетов у каждого кабинета своя.
    directory = bp.dataset_dir()
    if not directory.is_dir():
        return None
    if dataset_id:
        path = directory / f"{dataset_id}.json"
        return path if path.is_file() else None
    files = sorted(directory.glob("*.json"))
    return files[-1] if files else None


FUEL_FLUID = "топливо"        # имя жидкого топлива, когда какое именно — неважно (ключ ствола, подпись)


def machine_burns_fluid(machine: str | None, geometry: dict | None = None) -> bool:
    """У завода жидкое топливо: вход топлива — отдельный fluid box источника энергии (в геометрии первый, energy)."""
    boxes = (bp.entity_record(machine, geometry) or {}).get("fluids") if machine else None
    return bool(boxes and boxes[0].get("energy"))


def energy_passthrough(machine: str | None, geometry: dict | None = None) -> tuple | None:
    """Завод на жидком топливе, у которого вход топлива сквозной: два противоположных устья «вход-выход».

    Такие заводы (стекольный, ядерный реактор) принимают топливо с одной стороны и отдают дальше стоящему рядом,
    поэтому у столбца заводов вплотную топливо подводится только к торцам. Возвращает направления двух устьев."""
    boxes = (bp.entity_record(machine, geometry) or {}).get("fluids") if machine else None
    if not boxes or not boxes[0].get("energy"):
        return None
    pipes = [c for c in boxes[0].get("pipes") or [] if c.get("type") != "underground"]
    if len(pipes) == 2 and all(c.get("flow") == "input-output" for c in pipes):
        a, b = int(pipes[0].get("dir") or 0), int(pipes[1].get("dir") or 0)
        if (a - b) % 16 == 8:
            return (a, b)
    return None


def recipe_fluids(recipe: str | None, dataset_id: str | None = None, machine: str | None = None,
                  geometry: dict | None = None) -> tuple[list, list]:
    """Жидкости рецепта: (входы, выходы) по порядку записи в рецепте.

    Завод на жидком топливе принимает топливо в свой первый вход, поэтому топливо — первая жидкость входов."""
    inputs: list = []
    outputs: list = []
    path = dataset_path(dataset_id)
    if path and recipe:
        data = _dataset(path)
        rec = (data.get("recipes") or {}).get(recipe) or {}
        inputs = [i.get("name") for i in (rec.get("ingredients") or []) if i.get("type") == "fluid"]
        outputs = [p.get("name") for p in (rec.get("products") or []) if p.get("type") == "fluid"]
    if machine_burns_fluid(machine, geometry) and not energy_passthrough(machine, geometry):
        inputs = [FUEL_FLUID] + inputs
    return inputs, outputs


# Ориентация завода — число: поворот (0/4/8/12) плюс 16, если завод зеркальный (mirror из Factorio 2.0). Зеркало
# переворачивает порты слева направо, не меняя их ряды, поэтому у пары заводов один и тот же порт оказывается на
# одном ряду по обе стороны коридора или зазора. Зеркальные ориентации берутся, только когда без них нет раскладки.
MIRROR = 16
_MIRROR_OK: contextvars.ContextVar = contextvars.ContextVar("mirror_ok", default=False)
# Какие боксы завода реально несут жидкость рецепта: (левый x, верхний y, бокс, (роль, жидкость)); нужно проверке смешения
_USED_BOXES: contextvars.ContextVar = contextvars.ContextVar("used_boxes", default=None)
# Правый столбец — зеркальное отражение левого (порты на тех же рядах): так стволы труб не перекрещиваются
_SYMMETRIC: contextvars.ContextVar = contextvars.ContextVar("symmetric", default=False)
_FORCED_ORIENTATION: contextvars.ContextVar = contextvars.ContextVar("forced_orientation", default=None)


def flipped(orientation: int) -> int:
    """Ориентация, в которую переходит завод при отражении слева направо (север/юг те же, восток↔запад)."""
    rotation, mirrored = _unmirror(orientation)
    return (-rotation) % 16 + (0 if mirrored else MIRROR)


def _unmirror(orientation: int) -> tuple[int, bool]:
    return int(orientation) % MIRROR, int(orientation) >= MIRROR


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
    direction, mirrored = _unmirror(direction)
    steps = (int(direction) // 4) % 4
    ww, hh = (h, w) if steps % 2 else (w, h)
    out = []
    for index, box in enumerate(rec.get("fluids") or []):
        for conn in box.get("pipes") or []:
            if conn.get("type") == "underground":
                continue
            pos = conn.get("pos") or [0, 0]
            px, py = float(pos[0]), float(pos[1])
            conn_dir = int(conn.get("dir") or 0)
            if mirrored:
                px = -px
                if conn_dir in (4, 12):
                    conn_dir = 16 - conn_dir
            for _ in range(steps):
                px, py = -py, px
            cdir = (conn_dir + steps * 4) % 16
            dx_dir, dy_dir = bp.DIR_VECTORS.get(cdir, (0, 0))
            cx, cy = ww / 2 + px, hh / 2 + py
            machine_tile = (int(math.floor(cx)), int(math.floor(cy)))
            out.append({"production": box.get("production"), "box": index,
                        "machine_tile": machine_tile,
                        "dx": machine_tile[0] + dx_dir, "dy": machine_tile[1] + dy_dir,
                        "side": bp.DIRECTIONS.get(cdir, str(cdir)),
                        "direction": cdir, "filter": conn.get("filter"),
                        "energy": bool(box.get("energy")), "flow": conn.get("flow"),
                        "width": ww, "height": hh})
    return out


def choose_ports(ports: list[dict], kind: str, need: int, wall: int | None = None) -> list[dict]:
    """Порты под жидкости рецепта: i-я жидкость идёт в i-й бокс порядка block_pipes.ordered_boxes.

    Игра кладёт жидкость в любой подходящий вход, поэтому первыми берутся боксы с устьем на нужную стену (wall)."""
    if need <= 0:
        return []
    by_box: dict = {}
    for port in ports:
        if port["production"] != kind:
            continue
        by_box.setdefault(port["box"], []).append(port)
    chosen: list[dict] = []
    for box in block_pipes.ordered_boxes(ports, kind, wall)[:need]:
        # у бокса может быть несколько устьев — берём верхнее, при равных рядах правое
        chosen.append(sorted(by_box[box], key=lambda p: (p["dy"], -p["dx"]))[0])
    return chosen


def allowed_rotations(machine: str, geometry: dict | None = None) -> tuple:
    """Повороты, при которых габарит завода остаётся тем же, что считает раскладка.

    У квадратной постройки годятся все четыре. У прямоугольной (7×11) поворот на
    восток/запад меняет ширину и высоту местами, а столбцы, ленты и манипуляторы
    расставлены под исходный габарит — завод наезжал на ленту (находка прогона по
    всем рецептам Py: «Постройки пересекаются»). Поэтому им — только север и юг,
    а порт жидкости, не попавший на нужную стену, остаётся свободным тайлом.
    """
    size = bp.entity_size(machine, geometry)
    forced = _FORCED_ORIENTATION.get()
    if forced is not None:
        return (forced,)
    rotations = (0, 8) if (size and size[0] != size[1]) else (0, 4, 8, 12)
    if _MIRROR_OK.get():
        rotations = rotations + tuple(r + MIRROR for r in rotations)
    through = energy_passthrough(machine, geometry)
    if through:
        # сквозное топливо должно идти вдоль столбца заводов (на север и юг), иначе соседи его не передадут
        along = tuple(r for r in rotations if (through[0] + r) % 16 in (0, 8))
        if along:
            return along
    return rotations


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
    inputs, outputs = recipe_fluids(recipe, dataset_id, machine, geometry)
    need_in = 1 if inputs else 0
    need_out = 1 if outputs else 0
    candidates: list[tuple[int, int, list]] = []
    for direction in allowed_rotations(machine, geometry):
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


def _reachable_fluid_boxes(ports: list[dict], need_in: int, need_out: int) -> int:
    """Сколько боксов под жидкости рецепта имеют устье, смотрящее в коридор (на запад или восток)."""
    count = 0
    for role, need in (("input", need_in), ("output", need_out)):
        boxes = {p["box"] for p in ports if p["production"] == role
                 and any(q["box"] == p["box"] and q["direction"] in (4, 12) for q in ports)}
        count += min(need, len(boxes))
    return count


def pick_rotation(machine: str, recipe: str | None, geometry: dict | None = None,
                  dataset_id: str | None = None, h: int | None = None,
                  wall_in: int | None = None, wall_out: int | None = None,
                  drop_wall: int | None = None, all_fluids: bool = False) -> dict:
    """Подбирает поворот завода так, чтобы жидкости смотрели в нужную сторону.

    all_fluids — у каждой жидкости рецепта порт должен смотреть на нужную стену (в центре блока лента подачи, туда
    трубу не подвести): иначе проверяется только первая жидкость входа и первая выхода.

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
    inputs, outputs = recipe_fluids(recipe, dataset_id, machine, geometry)
    need_in = 1 if inputs else 0
    need_out = 1 if outputs else 0
    if not need_in and not need_out and drop_wall is None:
        return {"direction": 0, "inputs": [], "outputs": [], "note": ""}
    if drop_wall is not None:
        by_drop = _rotation_for_drop(machine, recipe, geometry, dataset_id,
                                     wall_in, wall_out, drop_wall)
        if by_drop is not None:
            return by_drop

    if all_fluids:
        # Лента подачи по центру: сколько жидкостей рецепта смотрит наружу (на wall_in), столько и труб без цепочек
        # через центр. Берём поворот, где наружу смотрит больше всего портов выбранных боксов.
        best = None
        for direction in allowed_rotations(machine, geometry):
            ports = machine_ports(machine, geometry, direction)
            chosen_in = choose_ports(ports, "input", len(inputs), wall_in)
            chosen_out = choose_ports(ports, "output", len(outputs), wall_in)
            if len(inputs) and not chosen_in:
                continue
            outward = sum(1 for p in chosen_in + chosen_out if p["direction"] == wall_in)
            score = outward - (0 if direction in (0, 8) else 0.01)
            if best is None or score > best["score"]:
                best = {"direction": direction, "inputs": chosen_in, "outputs": chosen_out, "score": score,
                        "note": "" if outward == len(chosen_in) + len(chosen_out)
                        else "часть жидкостей смотрит в центр блока: туда идёт цепочка труб"}
        if best is not None:
            return best

    def fits(kind, ports, wall, row):
        chosen = choose_ports(ports, kind, (len(inputs) if kind == "input" else len(outputs)) if all_fluids else 1,
                              wall)
        if not chosen:
            return None
        if wall is None:
            ok = all(p["dy"] == row for p in chosen) if row is not None else True
        else:
            ok = all(p["direction"] == wall for p in chosen)
        return chosen if ok else None

    best = None
    for direction in allowed_rotations(machine, geometry):
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
        # При равенстве — поворот, в котором к трубам больше жидкостей рецепта достаёт
        # коридор (у остальных порты смотрят вдоль стенки, и трубу туда не подвести).
        score += 0.1 * _reachable_fluid_boxes(ports, len(inputs), len(outputs))
        if best is None or score > best["score"]:
            best = {"direction": direction, "inputs": chosen_in or [], "outputs": chosen_out or [],
                    "score": score, "note": ""}
    if best is not None:
        return best
    # строгие требования не выполнились — берём хоть какой-то вариант с входом
    for direction in allowed_rotations(machine, geometry):
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
    """Тайлы, которые надо оставить свободными под газ/жидкость.

    Тайл подхода к порту и по одному соседнему тайлу вдоль коридора не должны занимать
    столб, лента или манипулятор.

    Возвращает {"tiles": [...], "by_machine": {i: [...]}, "ports": {...},
                "fluids": {...}, "unreachable": [...]}
    """
    size = bp.entity_size(machine, geometry)
    if not size:
        return {"tiles": [], "by_machine": {}, "ports": {}, "fluids": {}, "unreachable": []}
    w, h = size
    inputs, outputs = recipe_fluids(recipe, dataset_id, machine, geometry)
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
    direction, mirrored = _unmirror(direction)
    if direction:
        ent["direction"] = direction
    if mirrored:
        ent["mirror"] = True
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

    # --- газ и жидкость: тайлы подключения резервируются ---
    #
    # Тайл подхода к порту и по одному соседнему с каждой стороны остаются свободными:
    # ни столб, ни манипулятор, ни лента их не занимают.
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
    direction, mirrored = _unmirror(direction)
    steps = (int(direction) // 4) % 4
    px, py = vec
    if mirrored:
        px = -px
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

    def closest_pair(comps: list[list[tuple[int, int]]], skip: set):
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
                        if (a, b) in skip or (b, a) in skip:
                            continue
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

    skip: set = set()                 # пары, которые сшить нечем (например, через ряд заводов): берём следующие
    failed = None
    for _ in range(4 * len(poles) + 8):
        comps = pole_components(poles + added, wire)
        if len(comps) < 2:
            failed = None
            break
        pair = closest_pair(comps, skip)
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
            failed = (len(comps), distance)
            skip.add((left, right))
            continue
        added.append(tile)
        blocked.add(tile)
        mark_near(tile)

    if len(pole_components(poles + added, wire)) > 1:
        comps_left = len(pole_components(poles + added, wire))
        notes.append(
            f"столбы распались на {comps_left} сетей: между ними нет свободного места под промежуточный столб "
            f"(провод тянется на {wire:.0f} тайлов), соедини сети проводом вручную")
    return added, notes


def repair_pole_coverage(entities: list, pole: str, geometry: dict | None, blocked: set,
                        placed: list) -> tuple[list, int]:
    """Добавляет столбы тем, кого основной расчёт столбов оставил без питания.

    Находка прогона по всем рецептам Py: у больших заводов (11-22 тайла) манипуляторы
    стоят посередине стенки, а столбы — только по краям, и зона питания (9×9 у
    среднего столба) до них не дотягивается. Здесь жадно: на каждом шаге берём
    свободный тайл, который накрывает больше всего непитающихся построек (при равенстве —
    ближайший к уже стоящим столбам, чтобы провод дотянулся).

    Возвращает (новые столбы [(x, y)], сколько построек так и осталось без питания).
    """
    supply, _wire = _supply_and_wire(pole, geometry)
    consumers = []
    for ent in entities:
        if ent.get("name") == pole or not needs_power(ent.get("name") or "", geometry):
            continue
        tile = bp.tiles_of(ent, geometry)
        if tile:
            consumers.append(tile)
    poles = list(placed)
    starved = [c for c in consumers if not any(_covers(p, c, supply) for p in poles)]
    added: list = []
    reach = int(math.ceil(supply))
    for _ in range(400):
        if not starved:
            break
        best = None
        candidates: set = set()
        for (left, top, w, h) in starved:
            for x in range(left - reach, left + w + reach):
                for y in range(top - reach, top + h + reach):
                    if (x, y) not in blocked:
                        candidates.add((x, y))
        for tile in candidates:
            covered = sum(1 for c in starved if _covers(tile, c, supply))
            if not covered:
                continue
            near = min((abs(tile[0] - p[0]) + abs(tile[1] - p[1]) for p in poles), default=0)
            score = (-covered, near, tile[1], tile[0])
            if best is None or score < best[0]:
                best = (score, tile)
        if best is None:
            break
        tile = best[1]
        added.append(tile)
        poles.append(tile)
        blocked.add(tile)
        starved = [c for c in starved if not _covers(tile, c, supply)]
    return added, len(starved)


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
        inputs, outputs = recipe_fluids(ent.get("recipe"), dataset_id, name, geom)
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

    data = _dataset(path)
    return (data.get("recipes") or {}).get(recipe) or {}


def burnt_result(fuel: str | None, dataset_id: str | None = None) -> str | None:
    """Что остаётся после сгорания топлива (пепел) или None."""
    path = dataset_path(dataset_id)
    if not path or not fuel:
        return None
    item = (_dataset(path).get("items") or {}).get(fuel) or {}
    return item.get("burnt_result") or None


def has_solid_products(spec: "BlockSpec", dataset_id: str | None = None) -> bool:
    """Есть ли у рецепта ТВЁРДЫЕ продукты.

    Если нет (например «Битум»: на входе и на выходе только жидкости), лента
    выгрузки и манипуляторы не нужны вовсе — всё уходит трубами.
    """
    rec = _recipe_of(spec.recipe, dataset_id)
    if not rec:
        return True   # рецепта не знаем — считаем, что лента выгрузки нужна
    if burnt_result(spec.fuel, dataset_id):
        return True   # пепел от топлива едет лентой выгрузки
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

    data = _dataset(path)
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
                 drop_wall: int | None = None, pitch: int | None = None, center: bool = False,
                 split_outputs: bool = False) -> dict:
    """Поворот завода под нужную внешнюю стену и зарезервированные тайлы столбца.

    `pitch` — шаг заводов в столбце (высота завода плюс, если постройка сама
    кладёт продукт на ленту, клетка под трубы). По нему считаются ряды портов:
    с шагом h порты нижних заводов «уезжали» на чужое место, и манипулятор
    вставал ровно на устье трубы.
    """
    wall_out = wall_in if center else (4 if wall_in == 12 else 12)
    rotation = pick_rotation(spec.machine, spec.recipe, geometry, spec.dataset_id,
                             None, wall_in=wall_in, wall_out=wall_out, drop_wall=drop_wall, all_fluids=center)
    direction = int(rotation.get("direction") or 0)
    size = bp.entity_size(spec.machine, geometry)
    w, h = size
    step = h if not pitch else pitch
    if not spec.reserve_fluid_tiles:
        return {"rotation": rotation, "direction": direction, "reserved": set(), "ports": [], "all_ports": [],
                "used_ports": [], "offsets": [index * step for index in range(count)],
                "directions": [direction] * count}
    reserved: set = set()
    ports: list = []
    all_ports: list = []   # ВСЕ устья завода: на них тоже нельзя ставить манипулятор
    chosen = rotation.get("inputs", []) + rotation.get("outputs", [])
    # Резервируются все порты завода в этом повороте, а не только выбранные боксы: у
    # многобоксовых построек устья бывают с обеих сторон.
    every_port = machine_ports(spec.machine, geometry, direction)
    # Устья ИСПОЛЬЗУЕМЫХ боксов (по одному на каждую жидкость рецепта), смотрящие в коридор:
    # к ним ведут трубы, и манипулятор рядом с ними не нужен.
    inputs_f, outputs_f = recipe_fluids(spec.recipe, spec.dataset_id, spec.machine, geometry)
    used_boxes: set = set()
    for role, fluids in (("input", inputs_f), ("output", outputs_f)):
        boxes = block_pipes.ordered_boxes(every_port, role, wall_in if role == "input" else wall_out,
                                          alternate=split_outputs and role == "output", count=len(fluids))
        used_boxes.update(boxes[:len(fluids)])
    used_mouths = [p for p in every_port if p["box"] in used_boxes and p["direction"] in (4, 12)]
    used_ports: list = []
    for index in range(count):
        for port in used_mouths:
            used_ports.append((port["dx"], index * step + port["dy"]))
    for index in range(count):
        top = index * step
        for port in chosen:
            for dy in (-1, 0, 1):  # сам тайл порта и по соседу вдоль коридора
                reserved.add((port["dx"], top + port["dy"] + dy))
            ports.append((port["dx"], top + port["dy"]))
        for port in every_port:
            all_ports.append((port["dx"], top + port["dy"]))
            for dy in (-1, 0, 1):
                reserved.add((port["dx"], top + port["dy"] + dy))
    return {"rotation": rotation, "direction": direction, "reserved": reserved, "ports": ports,
            "all_ports": all_ports, "used_ports": used_ports,
            "offsets": [index * step for index in range(count)], "directions": [direction] * count}


def _gap_offsets(count: int, h: int) -> list[int]:
    """Верхи заводов столбца парами: завод, зазор в один тайл, завод; пары стоят вплотную друг к другу."""
    return [(i // 2) * (2 * h + 1) + (i % 2) * (h + 1) for i in range(count)]


def _column_height(count: int, h: int, pitch: int, gap_pairs: bool) -> int:
    """Высота столбца из count заводов."""
    if count <= 0:
        return 0
    if gap_pairs == 2:
        return count * (h + 1) + 1                     # зазор над первым, между всеми и под последним заводом
    if gap_pairs:
        return _gap_offsets(count, h)[-1] + h
    return (count - 1) * pitch + h


class _GapUnavailable(ValueError):
    """Раскладка парами с зазором для этой постройки и рецепта невозможна."""


def _flip_vertical(orientation: int) -> int:
    """Отражение сверху вниз (через горизонтальную ось): поворот на 180° плюс зеркало. Все порты отражённого завода
    встают точно напротив своих образов: порт, смотрящий вниз, и такой же порт соседа, смотрящий вверх, — в одной клетке."""
    rotation, mirrored = _unmirror(orientation)
    # зеркало по горизонтальной оси = поворот на 180° и зеркало слева направо: R(180°)·M·R(θ) = R(180° − θ)·M
    return (8 - rotation) % 16 + (0 if mirrored else MIRROR)


def _gap_column(spec: BlockSpec, geometry: dict, count: int, wall_in: int, uniform: bool = False,
                drop_wall: int | None = None) -> dict | None:
    """Столбец парами с зазором: верхний завод смотрит устьем жидкости вниз, нижний — вверх, между ними зазор.

    Для жидкости, чей порт стоит по центру стенки и смотрит вдоль столбца (шаблон «Фабрика наноматериалов»):
    труба в зазоре подключает сразу два соседних завода. Остальные жидкости идут как обычно (наружу и в коридор).

    uniform — зазор между КАЖДЫМИ двумя заводами (и по краям столбца): заводы чередуются «как есть» и «отражённый
    сверху вниз», поэтому зазоры по очереди несут две жидкости (порт «вниз» пары и порт «вверх»), что нужно заводам с
    портами по центру всех четырёх стен (теплообменник). None — подходящей раскладки нет."""
    size = bp.entity_size(spec.machine, geometry)
    if not size:
        return None
    w, h = size
    wall_out = 4 if wall_in == 12 else 12
    walls = {"input": wall_in, "output": wall_out}
    inputs_f, outputs_f = recipe_fluids(spec.recipe, spec.dataset_id, spec.machine, geometry)
    fluids = [("input", f) for f in inputs_f] + [("output", f) for f in outputs_f]
    allowed = allowed_rotations(spec.machine, geometry)
    for r_a in allowed:
        rot_a, mirrored_a = _unmirror(r_a)
        partners = [(rot_a + 8) % 16 + (MIRROR if mirrored_a else 0)]      # тот же завод, повёрнутый на 180°
        if uniform:
            # при зазоре в каждой паре заводы чередуются, и порты слева и справа у всех должны быть на одних сторонах:
            # годится только отражение сверху вниз (поворот на 180° поменял бы входы и выходы местами)
            partners = [_flip_vertical(r_a)] if _MIRROR_OK.get() else []
        elif _MIRROR_OK.get():
            partners.append(_flip_vertical(r_a))                           # или отражённый сверху вниз
        for r_b in partners:
            if r_b not in allowed or r_b == r_a:
                continue
            if drop_wall is not None and (machine_drop_side(spec.machine, r_a, geometry) != drop_wall
                                          or machine_drop_side(spec.machine, r_b, geometry) != drop_wall):
                continue                              # постройка сама выгружает на ленту: оба завода — на нужную стену
            ports = {r_a: machine_ports(spec.machine, geometry, r_a),
                     r_b: machine_ports(spec.machine, geometry, r_b)}
            # Боксы, у которых устье смотрит вниз у верхнего завода пары и вверх у нижнего (зазор А), и наоборот (зазор Б)
            cand_a: list = []
            cand_b: list = []
            for pa in ports[r_a]:
                if pa["direction"] != 8 or pa.get("energy"):
                    continue
                pb = next((p for p in ports[r_b] if p["box"] == pa["box"]), None)
                if pb is not None and pb["direction"] == 0 and pb["dx"] == pa["dx"]:
                    cand_a.append(pa)
            if uniform:
                for pb in ports[r_b]:
                    if pb["direction"] != 8 or pb.get("energy"):
                        continue
                    pa = next((p for p in ports[r_a] if p["box"] == pb["box"]), None)
                    if pa is not None and pa["direction"] == 0 and pa["dx"] == pb["dx"]:
                        cand_b.append(pb)
            # варианты: (жидкость в зазоре А, жидкость в зазоре Б) — сначала с одной жидкостью в зазорах
            options: list = []
            for pa in cand_a:
                for fl in fluids:
                    if fl[0] == pa["production"]:
                        options.append(((pa, fl), None))
            if uniform:
                for pb in cand_b:
                    for fl in fluids:
                        if fl[0] == pb["production"]:
                            options.append((None, (pb, fl)))
                for pa in cand_a:
                    for fa in fluids:
                        if fa[0] != pa["production"]:
                            continue
                        for pb in cand_b:
                            for fb in fluids:
                                if fb[0] == pb["production"] and fb != fa:
                                    options.append(((pa, fa), (pb, fb)))
            for gap_a, gap_b in options:
                gaps_used = [g for g in (gap_a, gap_b) if g]
                gap_boxes = {g[0]["box"] for g in gaps_used}
                gap_fluids = {g[1] for g in gaps_used}
                others = {r: [f for rl, f in fluids if rl == r and (rl, f) not in gap_fluids]
                          for r in ("input", "output")}
                good = True
                chosen: dict = {}
                for direction in (r_a, r_b):
                    mine = [p for p in ports[direction] if p["box"] not in gap_boxes]
                    picked = []
                    for r in ("input", "output"):
                        boxes = block_pipes.ordered_boxes(mine, r, walls[r])[:len(others[r])]
                        for box in boxes:
                            mouths = [p for p in mine if p["box"] == box]
                            # у повёрнутого на 180° завода пары стены меняются местами: порт может смотреть и в
                            # коридор — это тоже годится (цепочка в центре), не годится только вдоль столбца
                            facing = ([p for p in mouths if p["direction"] == walls[r]]
                                      or [p for p in mouths if p["direction"] in (4, 12)])
                            if not facing:
                                good = False
                                break
                            picked.append(sorted(facing, key=lambda p: (p["dy"], -p["dx"]))[0])
                        if not good:
                            break
                    if not good:
                        break
                    chosen[direction] = picked
                if not good:
                    continue
                directions = [r_a if i % 2 == 0 else r_b for i in range(count)]
                if uniform:
                    offsets = [1 + i * (h + 1) for i in range(count)]
                else:
                    offsets = _gap_offsets(count, h)
                reserved: set = set()
                ports_out: list = []
                all_ports: list = []
                used_ports: list = []
                for index, (direction, top) in enumerate(zip(directions, offsets)):
                    every = ports[direction]
                    gap_ports = [next(p for p in every if p["box"] == box) for box in sorted(gap_boxes)]
                    for port in chosen[direction] + gap_ports:
                        for dy in (-1, 0, 1):
                            reserved.add((port["dx"], top + port["dy"] + dy))
                        ports_out.append((port["dx"], top + port["dy"]))
                    for port in every:
                        all_ports.append((port["dx"], top + port["dy"]))
                        for dy in (-1, 0, 1):
                            reserved.add((port["dx"], top + port["dy"] + dy))
                    used = gap_boxes | {p["box"] for p in chosen[direction]}
                    used_ports += [(p["dx"], top + p["dy"]) for p in every if p["box"] in used
                                   and p["direction"] in (4, 12)]
                gaps: list = []
                if uniform:
                    rows_a: list = []
                    rows_b: list = []
                    dx_a = gap_a[0]["dx"] if gap_a else None
                    dx_b = gap_b[0]["dx"] if gap_b else None
                    for index, top in enumerate(offsets):
                        below = top + h                           # ряд зазора под заводом
                        if index % 2 == 0 and dx_a is not None:
                            rows_a.append((below, dx_a))
                        if index % 2 == 1 and dx_b is not None:
                            rows_b.append((below, dx_b))
                    if dx_b is not None:
                        rows_b.append((0, dx_b))                  # ряд над первым заводом (он «как есть»)
                    if gap_a:
                        gaps.append({"key": gap_a[1], "box": gap_a[0]["box"], "rows": rows_a, "dx": dx_a})
                    if gap_b:
                        gaps.append({"key": gap_b[1], "box": gap_b[0]["box"], "rows": rows_b, "dx": dx_b})
                else:
                    rows: list = []
                    for index, top in enumerate(offsets):
                        if index % 2 == 0:                        # верхний завод пары (или одиночный последний)
                            rows.append((top + h, gap_a[0]["dx"]))
                    gaps.append({"key": gap_a[1], "box": gap_a[0]["box"], "rows": rows, "dx": gap_a[0]["dx"]})
                return {"rotation": {"direction": r_a, "inputs": [], "outputs": [], "note": ""},
                        "direction": r_a, "directions": directions, "offsets": offsets, "reserved": reserved,
                        "ports": ports_out, "all_ports": all_ports, "used_ports": used_ports,
                        "gap": gaps[0], "gaps": gaps, "uniform": uniform}
    return None


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


def group_width_tiles(w: int, supply_belts: int, out_belt: bool, dumps: bool = False,
                      single_column: bool = False, center_supply: bool = False, center_extra: int = 0) -> int:
    """Ширина одной группы в тайлах — как её раскладывает generate_sandwich_block.

        [ленты подачи][манипулятор][заводы][манипулятор][лента выгрузки][манипулятор][заводы][манипулятор][ленты подачи]

    `dumps` — постройка сама кладёт продукт на ленту (см. drops_to_belt): тогда
    между столбцами нет манипуляторов, а лента стоит вплотную к заводам.
    """
    if center_supply:
        return w + 3 + w                                # манипулятор + лента подачи + манипулятор между столбцами
    width = (supply_belts + 1) if supply_belts else 0   # ленты подачи + ряд манипуляторов
    width += w                                          # левый столбец заводов
    if single_column:
        return width + 1                                # погрузчик на тайле выгрузки, дальше — ленты игрока
    width += 1 if (dumps or not out_belt) else 3        # лента выгрузки вплотную или манипулятор+лента+манипулятор
    if not out_belt:
        width += center_extra                           # стволы жидкостей в середине коридора
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
# В блок маяки не ставятся. Здесь только разбор строк маяков для закупки: сайт
# присылает по строке на маяк (что в нём лежит и сколько заводов он накрывает), а
# сундук запроса заказывает маяки и модули к ним. Эффект и число заводов считает сайт.


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
    """Все тайлы, занятые постройками (полным габаритом), плюс зарезервированные.

    tiles_of возвращает только левый верхний тайл, поэтому габарит разворачивается
    в тайлы. `extra` — резерв под газ/жидкость: его не занимают ни маяки, ни столбы.
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
    """Группа заводов «бутербродом» (см. _sandwich_block). Если у порта жидкости нет образца из-за того, что он смотрит
    вдоль стенки, пробуем раскладку зеркальными парами с зазором, где труба в зазоре подключает два завода сразу."""
    geom = geometry if geometry is not None else bp.load_geometry()

    def attempt(gap_pairs: int = 0) -> dict:
        used: list = []
        token = _USED_BOXES.set(used)
        try:
            obj = _sandwich_block(spec, geom, gap_pairs=gap_pairs)
        finally:
            _USED_BOXES.reset(token)
        if spec.pipes:
            # Две разные жидкости одного завода не должны попасть в одну сеть: они смешаются, и завод встанет
            mixed = bp.pipe_net_conflicts(obj, geom, used={(x, y, box): key for x, y, box, key in used})
            if mixed:
                machines = sorted({m["machine"] for m in mixed})
                raise UnsupportedLayout(unsupported_message(spec, [
                    f"{', '.join(machines)}: вход и выход завода попадают в одну сеть труб — трубу проведи сам"]))
        return obj

    try:
        return attempt()
    except UnsupportedLayout as first:
        if not spec.pipes or not any(mark in str(first) for mark in NO_SAMPLE_MARKS):
            raise
        # Запасные раскладки по порядку: те же столбцы, но заводы могут стоять зеркально; затем пары через зазор
        for gap_pairs, mirror, symmetric in ((0, True, True), (0, True, False), (1, False, False), (1, True, False),
                                             (2, True, False)):
            if gap_pairs and "смотрит вдоль стенки" not in str(first):
                continue
            token = _MIRROR_OK.set(mirror)
            token_sym = _SYMMETRIC.set(symmetric)
            try:
                obj = attempt(gap_pairs)
            except (_GapUnavailable, UnsupportedLayout, ValueError):
                continue
            finally:
                _SYMMETRIC.reset(token_sym)
                _MIRROR_OK.reset(token)
            notes = bp.blueprint_of(obj).get("description") or ""
            if "соедини сам" in notes or "проведи сам" in notes:
                continue                                # раскладка вышла, но труба осталась разорванной
            return obj
        raise first


def _sandwich_block(spec: BlockSpec, geometry: dict | None = None, gap_pairs: int = 0) -> dict:
    """Группа заводов «бутербродом»: два столбца, между ними лента выгрузки.

        [лента подачи][манипулятор][заводы][манипулятор][лента выгрузки][манипулятор][заводы][манипулятор][лента подачи]

    Заводы в столбце стоят вплотную, лента выгрузки одна на группу, ленты подачи по
    внешним сторонам, каждая кормит свой столбец. Группа из count заводов делится на
    два столбца поровну (21 → 11 и 10). Групп может быть несколько — они стоят рядом;
    с `row_groups` группы раскладываются по нескольким рядам: следующий ряд ниже на
    высоту самого высокого ряда плюс ROW_GAP (10 тайлов).
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
    ports_global: set = set()   # устья труб ВСЕХ групп: столб, вставший на чужое устье, убираем
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
    # Постройка с выгрузкой не меньше целой ленты (литейная) сама на ленту не успевает: на тайле выгрузки стоит
    # погрузчик, и каждый завод выгружает на СВОЮ ленту (её тянет игрок). Заводы стоят одним столбцом: справа от
    # погрузчика место свободно, никакой общей ленты нет.
    loader_out = bool(spec.inserter_out) and device_is_loader(spec.inserter_out, geom)
    dump_capable = drops_to_belt(spec.machine, geom) is not None and out_belt_all
    own_loader = dump_capable and loader_out
    self_dump = dump_capable and not loader_out
    fluid_in_all, fluid_out_all = recipe_fluids(spec.recipe, spec.dataset_id, spec.machine, geom)
    # Зазор в клетку между заводами: вместе с поворотом «выгрузка на ленту» порты
    # жидкости уезжают на север/юг, а в тесном столбце трубу к ним не подвести —
    # соседний завод занимает ровно тот тайл. Пустая клетка и есть труба.
    col_gap = 1 if (self_dump and (fluid_in_all or fluid_out_all)
                    and spec.reserve_fluid_tiles) else 0
    pitch = h + col_gap
    # Твёрдого выхода нет, а лента подачи одна: она едет по центру, манипуляторы с обеих сторон берут с неё, а
    # жидкости идут цепочками снаружи столбцов (шаблон «Две выходные жидкости — ацетилен»).
    in_plan_all = inserter_belt_plan(spec.inserter_in_rows, supply_belts_all)
    input_loader_all = (any(device_is_loader(b["name"], geom) for b in in_plan_all)
                        or device_is_loader(spec.inserter_in, geom))
    # Центр свободен, пока выходная жидкость одна (шаблон с литейной «1 лента 1 жидкость на вход — 1 на выход»:
    # лента подачи снаружи, в середине общая труба). Две и больше выходных жидкостей в одном коридоре не поместятся.
    center_supply = (not out_belt_all and supply_belts_all == 1 and not input_loader_all and not own_loader
                     and len(fluid_out_all) >= 2)
    # Лента выгрузки занимает коридор: две выходные жидкости идут по разным стенам (одна в коридор, другая наружу)
    split_outputs = out_belt_all and not center_supply and not own_loader and len(fluid_out_all) > 1
    # Раскладка парами с зазором: рецепт, порт жидкости которого смотрит вдоль столбца (см. _gap_column)
    gap_left = gap_right = None
    fluid_in_eff, fluid_out_eff = fluid_in_all, fluid_out_all
    if gap_pairs:
        if center_supply or own_loader or (self_dump and gap_pairs != 2) or not spec.pipes:
            raise _GapUnavailable("раскладка парами для этого блока не годится")
        gap_left = _gap_column(spec, geom, 2, 12, uniform=gap_pairs == 2, drop_wall=4 if self_dump else None)
        gap_right = _gap_column(spec, geom, 2, 4, uniform=gap_pairs == 2, drop_wall=12 if self_dump else None)
        if (not gap_left or not gap_right
                or [g["key"] for g in gap_left["gaps"]] != [g["key"] for g in gap_right["gaps"]]
                or [g["box"] for g in gap_left["gaps"]] != [g["box"] for g in gap_right["gaps"]]):
            raise _GapUnavailable("нет раскладки парами")
        gap_keys = [g["key"] for g in gap_left["gaps"]]
        gap_boxes = {g["box"] for g in gap_left["gaps"]}
        fluid_in_eff = [f for f in fluid_in_all if ("input", f) not in gap_keys]
        fluid_out_eff = [f for f in fluid_out_all if ("output", f) not in gap_keys]
    # Жидкостей, которые идут в коридор между столбцами, больше одной (и ленты там нет): лишние получают стволы
    # посередине, коридор расширяется на полосу и по три тайла на ствол.
    center_extra = 0
    if (spec.pipes and not out_belt_all and not center_supply and not own_loader and not self_dump
            and (fluid_in_all or fluid_out_all)):
        if gap_pairs == 2:
            # зазор в каждой паре: у левого и правого столбцов внутрь коридора смотрят разные жидкости
            inward = list(block_pipes.inner_keys(
                [p for p in machine_ports(spec.machine, geom, gap_left["direction"]) if p["box"] not in gap_boxes],
                block_pipes.WEST, fluid_in_eff, fluid_out_eff))
            for key in block_pipes.inner_keys(
                    [p for p in machine_ports(spec.machine, geom, gap_right["direction"]) if p["box"] not in gap_boxes],
                    block_pipes.EAST, fluid_in_eff, fluid_out_eff):
                if key not in inward:
                    inward.append(key)
        elif not gap_pairs:
            rot = _column_plan(spec, geom, 1, wall_in=12, pitch=pitch)["rotation"]
            inward = block_pipes.inner_keys(machine_ports(spec.machine, geom, int(rot.get("direction") or 0)),
                                            block_pipes.WEST, fluid_in_all, fluid_out_all)
        else:
            inward = []
        if len(inward) > 1:
            center_extra = 1 + 3 * (len(inward) - 1)
    group_width = group_width_tiles(w, supply_belts_all, out_belt_all, dumps=self_dump, single_column=own_loader,
                                    center_supply=center_supply, center_extra=center_extra)
    placements: list = []          # [(номер группы, x, y)]
    # Под стволы труб с краёв группы нужны свободные столбцы: слева и справа от
    # каждой группы. Считаем их по повороту столбцов заранее — от них зависит и
    # промежуток между группами, и отступ первой группы от края блока.
    pipe_w_left = pipe_w_right = 0
    if spec.pipes and (fluid_in_all or fluid_out_all):
        dump_walls = (4, 12) if (out_belt_all and self_dump) else ((4, None) if own_loader else (None, None))
        rot_left = _column_plan(spec, geom, 1, wall_in=12, drop_wall=dump_walls[0], pitch=pitch,
                                center=center_supply, split_outputs=split_outputs)["rotation"]
        rot_right = _column_plan(spec, geom, 1, wall_in=4, drop_wall=dump_walls[1], pitch=pitch,
                                 center=center_supply, split_outputs=split_outputs)["rotation"]
        ports_left = machine_ports(spec.machine, geom, int(rot_left.get("direction") or 0))
        ports_right = machine_ports(spec.machine, geom, int(rot_right.get("direction") or 0))
        if gap_pairs:
            ports_left = [p for p in machine_ports(spec.machine, geom, gap_left["direction"])
                          if p["box"] not in gap_boxes]
            ports_right = [p for p in machine_ports(spec.machine, geom, gap_right["direction"])
                           if p["box"] not in gap_boxes]
        west_keys = block_pipes.outer_keys(
            ports_left, block_pipes.WEST, fluid_in_eff, fluid_out_eff, inward_outputs=not center_supply,
            split_outputs=split_outputs)
        east_keys = block_pipes.outer_keys(
            ports_right, block_pipes.EAST, fluid_in_eff, fluid_out_eff, inward_outputs=not center_supply,
            split_outputs=split_outputs)
        chain_ok = (block_pipes.chain_feasible(pitch, block_pipes._max_underground(geom, spec.pipe_ground))
                    and not gap_pairs)               # в режиме пар цепочку занимает жидкость из зазора
        west_keys = block_pipes.trunk_keys(west_keys, chain_ok)   # первая жидкость стороны идёт цепочкой у стенки
        east_keys = block_pipes.trunk_keys(east_keys, chain_ok)   # завода, ствол с краю группы нужен остальным
        if gap_pairs:
            # жидкость из зазоров: первая идёт цепочкой у стенки завода, если ряды зазоров достаёт подземная труба;
            # остальные (и она сама, когда цепочка не достаёт) — стволами
            spacing = 2 * (h + 1) if gap_pairs == 2 else 2 * h + 1
            chain_gap = spacing - 1 <= block_pipes._max_underground(geom, spec.pipe_ground)
            trunk_gap = list(gap_keys[1:]) if chain_gap else list(gap_keys)
            west_keys = trunk_gap + west_keys
            east_keys = trunk_gap + east_keys
        if own_loader:
            east_keys = []                        # заводов только в левом столбце, справа труб нет
        pipe_w_left = block_pipes.side_width(len(west_keys))
        pipe_w_right = block_pipes.side_width(len(east_keys))
        if center_supply:
            # снаружи столбцов лент подачи нет, а цепочка у стенки завода нуждается в своей полосе
            pipe_w_left += 1
            pipe_w_right += 1
        gap = max(gap, pipe_w_left + pipe_w_right)
        # Соседние стволы одной жидкости (правый ствол группы и левый следующей) сдвигаем на тайл, чтобы это
        # был один общий ствол, а не две трубы рядом. Если жидкости разные, между ними пустой тайл.
        if west_keys and east_keys:
            if west_keys[-1] == east_keys[-1]:
                gap -= 1
            elif west_keys != east_keys:
                gap += 1
    gap_extra: list = []           # (рамка группы, сторона, ключ, тайл полосы) — порты жидкости из зазоров (раскладка парами)
    group_boxes: list = []         # (левый x, правый x без края, верх, низ) каждой группы
    row_gap = ROW_GAP
    y_row = 0
    for row_ids in layout_rows:
        x_row = pipe_w_left
        row_height = 0
        for group_index in row_ids:
            placements.append((group_index, x_row, y_row))
            row_height = max(row_height, _column_height(
                groups[group_index] if own_loader else (groups[group_index] + 1) // 2, h, pitch, gap_pairs) + (
                    0 if gap_pairs else pitch - h))
            x_row += group_width + gap
        y_row += row_height + row_gap
    for group_index, count, x_cursor, y0 in group_placements(groups, placements):
        left_count = count if own_loader else (count + 1) // 2          # 20 -> 10 и 10, 21 -> 11 и 10
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
        # Приписка про «лишние» ленты — ниже, когда известно, выбран ли погрузчик
        # (тогда ленты подачи не строятся вовсе).
        # Только жидкости: ни лент подачи, ни ленты выгрузки, ни манипуляторов —
        # всё уходит трубами, столбцы под них не занимаются.
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
                                 drop_wall=4 if (out_belt and (self_dump or own_loader)) else None,
                                 pitch=pitch, center=center_supply, split_outputs=split_outputs)
        forced_token = None
        if _SYMMETRIC.get() and not gap_pairs:
            forced_token = _FORCED_ORIENTATION.set(flipped(plan_left["direction"]))
        try:
            plan_right = _column_plan(spec, geom, right_count, wall_in=4,
                                      drop_wall=12 if (out_belt and self_dump) else None,
                                      pitch=pitch, center=center_supply, split_outputs=split_outputs)
        finally:
            if forced_token is not None:
                _FORCED_ORIENTATION.reset(forced_token)
        if gap_pairs:
            plan_left = _gap_column(spec, geom, left_count, 12, uniform=gap_pairs == 2,
                                    drop_wall=4 if (out_belt and self_dump) else None)
            plan_right = _gap_column(spec, geom, right_count, 4, uniform=gap_pairs == 2,
                                     drop_wall=12 if (out_belt and self_dump) else None)
        drops_on_belt = (out_belt and self_dump
                         and machine_drop_side(spec.machine, plan_left["direction"], geom) == 4
                         and machine_drop_side(spec.machine, plan_right["direction"], geom) == 12)
        loader_drop = (out_belt and own_loader
                       and machine_drop_side(spec.machine, plan_left["direction"], geom) == 4)
        if out_belt and own_loader and not loader_drop:
            sandwich_problems.append("погрузчик не встал на тайл выгрузки: у этой постройки нет поворота, "
                                     "при котором она выгружает на восток, — поставь погрузчик сам")
        if out_belt and self_dump and not drops_on_belt:
            for plan in (plan_left, plan_right):
                if plan["rotation"].get("note"):
                    sandwich_problems.append(plan["rotation"]["note"])
        # ширина группы: ленты подачи + манипуляторы + заводы + манипулятор + выгрузка
        x_left_first_belt = x_left_ins = None
        if supply_belts and not center_supply:
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
        elif own_loader and loader_drop:
            # Погрузчик на тайле выгрузки, лента выгрузки каждого завода — своя, её тянет игрок.
            x_mid_ins_l = x_left + w
            x_out_belt = x_mid_ins_r = None
            x_right = x_mid_ins_l + 1
        elif center_supply:
            # Лента подачи по центру: манипуляторы по обе стороны берут с неё в заводы.
            x_mid_ins_l = x_left + w
            x_out_belt = x_mid_ins_l + 1
            x_mid_ins_r = x_out_belt + 1
            x_right = x_mid_ins_r + 1
        elif out_belt:
            x_mid_ins_l = x_left + w
            x_out_belt = x_mid_ins_l + 1
            x_mid_ins_r = x_out_belt + 1
            x_right = x_mid_ins_r + 1
        else:
            # Тайл между столбцами оставляем пустым: в него смотрят выходы
            # жидкостей, и трубу туда поставить будет можно.
            x_mid_ins_l = x_out_belt = x_mid_ins_r = None
            x_right = x_left + w + 1 + center_extra
        x_right_ins = x_right_first_belt = None
        if supply_belts and not own_loader and not center_supply:
            x_right_ins = x_right + w
            x_right_first_belt = x_right_ins + 1
        # правый край группы: за лентой подачи, а без неё — сразу за заводами.
        # Ширина группы заранее посчитана в group_width_tiles — по ней раскладывались
        # ряды; здесь она не нужна (позиции групп заданы placements).
        x_end = (x_right_first_belt + supply_belts) if (supply_belts and not own_loader and not center_supply) else (
            x_right if own_loader else x_right + w)
        height = _column_height(rows, h, pitch, gap_pairs)
        group_boxes.append((x_cursor, x_end, y0, y0 + height))

        rotations.append((plan_left["direction"], plan_right["direction"]))
        for plan, x0 in ((plan_left, x_left), (plan_right, x_right)):
            for (px, py) in plan["reserved"]:
                reserved_all.add((x0 + px, y0 + py))
            port_all.extend((x0 + px, y0 + py) for (px, py) in plan["ports"])
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
                # Роль погрузчика задаётся полем `type` ("input"/"output"), см. device_place.
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
            # Соседи ВЫБРАННЫХ портов лучше оставить трубам: между портами
            # подземные трубы встают именно туда (см. block_pipes, цепочки).
            spare.sort(key=lambda y: (column, y) in pipe_zone)
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
                    # Дальняя лента: вылет на 2 тайла только у манипулятора и только если ленты
                    # подачи в блоке есть (при погрузчике их нет, вылет не нужен).
                    pickup = 2 if (index > 0 and not is_loader
                                   and not loader_without_belts) else None
                    put(name, column, row, place_direction, pickup, entity_type=place_type)

        pipe_zone: set = set()   # соседи выбранных портов вдоль коридора (заполняется ниже)

        # Тайлы подключения труб всего блока: манипулятор на них не ставим.
        # Считаем ДО лент: свободные ряды решают, где встанут манипуляторы, а
        # значит и где кончаются ленты (см. belt_span ниже).
        port_tiles = set()
        for plan, x0 in ((plan_left, x_left), (plan_right, x_right)):
            port_tiles.update((x0 + px, y0 + py) for (px, py) in plan["ports"])
            # Не только выбранные боксы: манипулятор, вставший на устье ВТОРОГО входа
            # жидкости, закрывает его так же (находка прогона по всем рецептам Py).
            port_tiles.update((x0 + px, y0 + py) for (px, py) in plan.get("all_ports", []))
        ports_global.update(port_tiles)
        for plan, x0 in ((plan_left, x_left), (plan_right, x_right)):
            for (px, py) in list(plan["ports"]) + list(plan.get("used_ports", [])):
                pipe_zone.update(((x0 + px, y0 + py - 1), (x0 + px, y0 + py + 1)))

        in_far = supply_belts >= 2
        # Манипуляторы: имя приходит с сайта (раздел «Манипуляторы»). Пустое имя — числа
        # неизвестны (полный дамп без правок): манипуляторы не ставятся, об этом
        # пишется в описании чертежа.
        #
        # Входных лент может быть несколько, у каждой свой манипулятор: тогда работает
        # список `in_belts`, а на дальней ленте стоит тот, кто до неё достаёт
        # (см. order_belts_for_reach).
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
        # Если на входе выбран погрузчик, ленты подачи не строятся: погрузчик берёт ленту
        # целиком и одной лентой ряд заводов не кормится, а мод Loaders Modernized
        # переключает погрузчик в «выгрузку», если лента рядом идёт поперёк
        # (scripts/snapping.lua). Место под ленты остаётся свободным — пользователь
        # подводит их к погрузчикам сам.
        loader_without_belts = (any(device_is_loader(b["name"], geom) for b in in_belts)
                                or device_is_loader(spec.inserter_in, geom))
        if loader_without_belts and supply_belts:
            sandwich_notes.append(
                "на входе погрузчик: ленты подачи не построены — место под них оставлено, "
                "подведи их сам (погрузчик берёт ленту целиком, на ленту — один-два завода)")
        elif wanted_belts > 2:
            # Сколько лент будет в чертеже и сколько останется подвести вручную.
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
        left_in_rows = [inserter_rows(x_left_ins, y0 + plan_left["offsets"][i], in_count, False)
                        for i in range(left_count)] if x_left_ins is not None else []
        if own_loader and x_mid_ins_l is not None:
            drop_y = drop_tile(spec.machine, plan_left["direction"], geom)[1]
            mid_l_rows = [[y0 + plan_left["offsets"][i] + drop_y] for i in range(left_count)]
        else:
            mid_count = in_count if center_supply else out_count
            mid_l_rows = [inserter_rows(x_mid_ins_l, y0 + plan_left["offsets"][i], mid_count, False)
                          for i in range(left_count)] if x_mid_ins_l is not None else []
        right_in_rows = [inserter_rows(x_right_ins, y0 + plan_right["offsets"][i], in_count, False)
                         for i in range(right_count)] if x_right_ins is not None else []
        mid_r_rows = [inserter_rows(x_mid_ins_r, y0 + plan_right["offsets"][i], in_count if center_supply else out_count,
                                    False)
                      for i in range(right_count)] if x_mid_ins_r is not None else []

        # Тайлы выгрузки «своими руками»: лента выгрузки обязана их накрыть —
        # иначе постройке некуда класть продукт и она встанет.
        drop_rows: list[int] = []
        if drops_on_belt:
            for plan, total in ((plan_left, left_count), (plan_right, right_count)):
                tile = drop_tile(spec.machine, plan["direction"], geom)
                if tile is None:
                    continue
                drop_rows.extend(y0 + plan["offsets"][index] + tile[1] for index in range(total))

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

        # Погрузчику нужна лента, которая едет В НЕГО: он берёт предметы с тайла за
        # спиной. Если лента идёт поперёк, мод Loaders Modernized переключает погрузчик
        # в «выгрузку» (scripts/snapping.lua: belt.direction ~= entity.direction), поэтому
        # тайл ленты прямо за погрузчиком разворачивается в него.
        # Выгрузке это не нужно: погрузчик на выходе кладёт на проходящую ленту сбоку.
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

        # Ленты подачи едут на север. Лента выгрузки — на юг или тоже на север при
        # «в одну сторону» (вход и выход подключаются с одного конца блока).
        # Если твёрдого нет — лент нет вовсе (всё трубами).
        out_direction = 0 if spec.belt_sides == "same" else 8
        group_rows = flat(left_in_rows + mid_l_rows + right_in_rows + mid_r_rows)
        for x_first, count, span_rows, direction, is_input in (
            (x_left_first_belt, supply_belts, flat(left_in_rows), 0, True),
            (x_right_first_belt, supply_belts, flat(right_in_rows), 0, True),
            (x_out_belt, 1 if x_out_belt is not None else 0,
             drop_rows or flat(mid_l_rows + mid_r_rows), 0 if center_supply else out_direction, center_supply),
        ):
            if x_first is None or not count:
                continue
            if is_input and loader_without_belts:
                # Ленты подачи не строятся (погрузчик берёт ленту целиком), место под них свободно.
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
            top = y0 + plan_left["offsets"][index]
            machine(x_left, top, plan_left["directions"][index])
            if x_left_ins is not None:
                place_input_inserters(x_left_ins, left_in_rows[index], 12)
            if x_mid_ins_l is not None and center_supply:
                place_input_inserters(x_mid_ins_l, mid_l_rows[index], 4)
            elif x_mid_ins_l is not None:
                place_inserters(x_mid_ins_l, mid_l_rows[index], spec.inserter_out, 12,
                                loader_type="output")
        for index in range(right_count):
            top = y0 + plan_right["offsets"][index]
            machine(x_right, top, plan_right["directions"][index])
            if x_right_ins is not None:
                place_input_inserters(x_right_ins, right_in_rows[index], 4)
            if x_mid_ins_r is not None and center_supply:
                place_input_inserters(x_mid_ins_r, mid_r_rows[index], 12)
            elif x_mid_ins_r is not None:
                place_inserters(x_mid_ins_r, mid_r_rows[index], spec.inserter_out, 4,
                                loader_type="output")

        if gap_pairs:
            sandwich_notes.append(
                "порт жидкости смотрит вдоль стенки: заводы стоят парами через зазор в один тайл, труба в зазоре "
                "питает сразу два завода и по ряду зазора уходит к цепочке у полосы манипуляторов")
            # Труба из зазора между заводами пары идёт по ряду зазора к полосе столба: там её подхватывает цепочка
            for plan, x0, lane, side in ((plan_left, x_left, x_left - 1, block_pipes.WEST),
                                         (plan_right, x_right, x_right + w, block_pipes.EAST)):
                for gap in plan["gaps"]:
                    for rel_y, dx in gap["rows"]:
                        y_abs = y0 + rel_y
                        lo, hi = (lane + 1, x0 + dx) if side == block_pipes.WEST else (x0 + dx, lane - 1)
                        for xx in range(lo, hi + 1):
                            put(spec.pipe, xx, y_abs)
                        gap_extra.append(((x_cursor, x_end, y0, y0 + height), side, gap["key"], (lane, y_abs)))

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

    # Подземные трубы к портам, смотрящим наружу: после заводов и лент, до сети
    # столбов — столбам нельзя вставать на тайлы труб.
    unresolved_pipes: list = []
    if spec.pipes and (fluid_in_all or fluid_out_all):
        for (gx0, gx1, gy0, gy1) in group_boxes:
            new_pipes, number, pipe_notes = block_pipes.group_pipes(
                entities, number, machine=spec.machine, recipe_inputs=fluid_in_eff,
                recipe_outputs=fluid_out_eff, x0=gx0, x_end=gx1, y0=gy0, y1=gy1,
                geometry=geom, pipe=spec.pipe, pipe_ground=spec.pipe_ground, west_only=own_loader,
                inward_outputs=not center_supply, soft=spec.pole, center_trunks_ok=center_extra > 0,
                split_outputs=split_outputs, used_log=_USED_BOXES.get(),
                exclude_boxes=gap_boxes if gap_pairs else None, gap_keys=gap_keys if gap_pairs else None,
                extra_ports=[(side, key, tile) for box, side, key, tile in gap_extra
                             if box == (gx0, gx1, gy0, gy1)])
            entities.extend(new_pipes)
            sandwich_notes.extend(pipe_notes)
            # Отказ — только там, где по устройству порта трубу провести нечем и образца нет; мелкие осечки раскладки
            # (занятый тайл, нет места под подземную пару) остаются замечаниями в описании.
            unresolved_pipes.extend(n for n in pipe_notes if any(mark in n for mark in NO_SAMPLE_MARKS))
            # Столб, оказавшийся на тайле новой трубы, убираем: добор питания поставит его заново рядом
            pipe_tiles = occupied_tiles(new_pipes, geom)
            if spec.pole and pipe_tiles:
                gone = {tuple(bp.tiles_of(e, geom)[:2]) for e in entities if e.get("name") == spec.pole
                        and bp.tiles_of(e, geom) and tuple(bp.tiles_of(e, geom)[:2]) in pipe_tiles}
                if gone:
                    entities[:] = [e for e in entities if not (
                        e.get("name") == spec.pole and bp.tiles_of(e, geom)
                        and tuple(bp.tiles_of(e, geom)[:2]) in gone)]
                    placed_poles[:] = [p for p in placed_poles if p not in gone]
        if unresolved_pipes:
            raise UnsupportedLayout(unsupported_message(spec, unresolved_pipes))
        if any(e.get("name") == spec.pipe_ground for e in entities):
            sandwich_notes.append(
                "подземные трубы проведены от внешних портов жидкости к стволам по краям групп: "
                "осталось подвести жидкость к одному месту ствола")

    # Сквозное топливо (стекольный завод, реактор): заводы одного столбца вплотную передают его друг другу, поэтому
    # трубы нужны только у торцов столбца — туда игрок и подводит топливо.
    if spec.pipes and energy_passthrough(spec.machine, geom):
        taken_tiles = occupied_tiles([e for e in entities if e.get("name") != spec.pole], geom)
        for (gx0, gx1, gy0, gy1) in group_boxes:
            columns: dict = {}
            for e in entities:
                tile_box = bp.tiles_of(e, geom) if e.get("name") == spec.machine else None
                if tile_box and gx0 <= tile_box[0] < gx1 and gy0 <= tile_box[1] < gy1:
                    columns.setdefault(tile_box[0], []).append(e)
            for column in columns.values():
                column.sort(key=lambda e: bp.tiles_of(e, geom)[1])
                for end, machine_ent in (("top", column[0]), ("bottom", column[-1])):
                    box = bp.tiles_of(machine_ent, geom)
                    for conn in bp.fluid_connections(machine_ent, geom):
                        if not conn.get("energy"):
                            continue
                        tile = conn["approach_tile"]
                        if (tile[1] < box[1]) if end == "top" else (tile[1] >= box[1] + box[3]):
                            if tile in taken_tiles:
                                sandwich_notes.append(
                                    f"топливо: тайл {tile} у торца столбца занят — подведи топливо к заводу сам")
                                continue
                            entities[:] = [x for x in entities if not (
                                x.get("name") == spec.pole and bp.tiles_of(x, geom)
                                and tuple(bp.tiles_of(x, geom)[:2]) == tuple(tile))]
                            placed_poles[:] = [q for q in placed_poles if q != tuple(tile)]
                            entities.append(_entity(number, spec.pipe, tile[0], tile[1], (1, 1), 0))
                            number += 1
                            taken_tiles.add(tuple(tile))
        sandwich_notes.append(
            "топливо идёт сквозь заводы одного столбца: труба поставлена у торцов столбца, подведи топливо к ней")

    # Те, кого столбы по колонкам не накрыли (манипуляторы посреди стенки большого
    # завода), добираем отдельно; прежние замечания «без питания» заменяем итоговым.
    if spec.pole and placed_poles:
        # Столб соседней группы мог встать на устье трубы этой (резерв группы
        # появляется только когда до неё дошла очередь) — такие убираем.
        stray = {p for p in placed_poles if p in ports_global}
        if stray:
            entities[:] = [e for e in entities if not (
                e.get("name") == spec.pole and (bp.tiles_of(e, geom) or (None,))[0:2] and
                tuple((bp.tiles_of(e, geom) or (0, 0))[:2]) in stray)]
            placed_poles[:] = [p for p in placed_poles if p not in stray]
        repaired, still = repair_pole_coverage(
            entities, spec.pole, geom, occupied_tiles(entities, geom, reserved_all), placed_poles)
        for (px, py) in repaired:
            entities.append(_entity(number, spec.pole, px, py, (1, 1), 0))
            number += 1
        placed_poles.extend(repaired)
        sandwich_notes[:] = [n for n in sandwich_notes if not n.startswith("без питания осталось построек")]
        if still:
            sandwich_notes.append(f"без питания осталось построек: {still} — поставь столбы вручную")

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
        # Маяков в чертеже цепочки нет: их считает сайт (эффекты и сундук запроса, см. build_list).
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

    data = _dataset(path)
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

    data = _dataset(path)
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
        """Маяки этапа в закупку — по заказанному числу.

        Число маяков считает сайт (одна строка — один маяк). Модули считаются на каждый
        маяк по его строке. Сверять с раскладкой нечего: маяков в блоке нет.
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
                         fuel=stage.get("fuel"),
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
            # Маяки нужны и здесь: они заказаны независимо от раскладки.
            add_beacons(beacon_order)
            ins_tail = "" if (inserter_in or inserter_out) else " (манипуляторов нет: их числа неизвестны)"
            tail = ("; маяки с модулями — по заказу игрока" if beacon_order else "")
            notes.append(f"{machine or stage.get('recipe')}: блок не собрать ({exc}) — "
                         f"в закупке только заводы и манипуляторы{tail}{ins_tail}")
            continue
        # Завод, который в игре не скрафтить (только скрытым рецептом), в сундуке запроса — ошибка заказа.
        craft_note = machine_craft_note(machine, dataset_id)
        if craft_note:
            notes.append(f"{machine}: {craft_note}")
        # Больше двух лент подачи: блок собирается, но часть придётся подвести вручную.
        # Число лент берётся с сайта или считается по рецепту, когда ленты считает генератор.
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
        # Маяки в закупке — по заказу; в чертеже блока их нет.
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
    """Минимальная закупка: заводы, манипуляторы и маяки без раскладки.

    Запасной вариант, когда блоки посчитать не удалось: по одному манипулятору на вход и
    на выход каждому заводу. Маяки и модули в них заказываются как обычно.
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

    Сначала проверяется имя самой постройки: у модов поле placeable_by бывает
    переопределено (например bob-red-inserter ставится предметом long-handed-inserter),
    а в сундуке должен лежать предмет, который реально есть.
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

    Поля: index, name, quality, comparator, count (max_count игра не пишет). Плоский
    список запросов игра игнорирует — сундук ставится пустым.
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
    """«3 позиции», а не «3 позиций» — для названия чертежа."""
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
