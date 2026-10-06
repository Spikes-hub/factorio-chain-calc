"""Блюпринт «сборщики всего»: по автомату на каждый рецепт, который делает постройку.

Зачем: собрать «молл» — автоматы, каждый делает одну вещь, из которых состоит
завод (заводы, столбы, ленты, сундуки, манипуляторы, печи, буры…). У каждого
автомата ПОД ним в ряд два манипулятора и под ними два сундука: слева сундук
запроса (что нужно автомату), справа сундук снабжения (что он сделал).

Раскладка: автоматы разложены по группам меню крафта, как вкладки в игре, —
у каждой группы свой участок столбцов, между группами 7 клеток прохода, между
столбцами одной группы 2 клетки. В столбце до 20 автоматов вниз, порядок как в
меню крафта: подгруппа, название. Столбы ставятся в полосе под каждой клеткой и
связываются в ОДНУ сеть.

Что берём из дампа:
  * рецепты, у которых ВСЕ продукты — предметы и хотя бы один из них ставится в
    мире (place_result). Ресурсы (руда, вода, нефть) и промежуточные материалы
    (плиты, схемы, прутья) в этот список не попадают: их делает основное
    производство, а не молл;
  * завод для рецепта — самый простой ЭЛЕКТРИЧЕСКИЙ, который умеет нужную
    категорию (у Py их 185, обычный сборщик умеет четыре);
  * из рецепта в сундук запроса уезжают ТВЁРДЫЕ ингредиенты, умноженные на 4.
    Жидкость в сундук не положить, поэтому у таких рецептов тайлы портов
    остаются свободными — трубу игрок подводит сам (об этом сказано в описании).
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import blueprint as bp
import blueprint_gen as gen

PER_COLUMN = 20         # автоматов в одном столбце
PER_ROW = PER_COLUMN    # старое имя, оставлено для совместимости вызовов
# Сколько символов допускаем в одной строке чертежа. Окно импорта игры принимает
# строки разной длины: у игрока, который писал про «ошибку импорта», чертежи
# этапов были по 1.5–3.7 КБ, а строка всего молла — 120 КБ. Поэтому молл режется
# не по числу автоматов, а ПО ДЛИНЕ строки: каждая часть влезает в этот предел.
# Размер можно поднять (max_chars), если игра принимает строки длиннее.
MAX_CHARS = 4000
REQUEST_MULTIPLIER = 4  # во сколько раз умножать ингредиенты в сундуке запроса
GAP_X = 2               # между столбцами ВНУТРИ одной группы
GROUP_GAP = 7           # между группами (вкладками крафта) — проход
GAP_Y = 2               # между клетками в столбце (в этой полосе идут столбы)
MARGIN = 2              # отступ по краям
FLUID_GROUP_MIN = 3     # от стольких автоматов жидкость становится своей группой
PROVIDER_LIMIT = 20     # лимит сундука снабжения у «заводов», ячеек
REQUESTER = "requester-chest"
PROVIDER = "passive-provider-chest"
INSERTER = "inserter"
# Постройки, которые «сами что-то делают»: им в сундук снабжения ставим лимит,
# чтобы молл не забивал склад сотнями сборщиков. Столбы, ленты, рельсы,
# манипуляторы, сундуки и трубы — наоборот: пусть сундук наполняется целиком.
MACHINE_TYPES = {"assembling-machine", "furnace", "boiler", "generator", "mining-drill",
                 "lab", "rocket-silo", "offshore-pump"}


def _dataset(dataset_id: str | None) -> dict:
    path = gen.dataset_path(dataset_id)
    if not path:
        raise ValueError("нет датасета: сделай дамп данных (см. README)")
    with Path(path).open(encoding="utf-8") as f:
        return json.load(f)


def _product_for_menu(recipe: dict, items: dict) -> dict:
    """Предмет, по которому рецепт сортируется в меню (первый ставящийся)."""
    for product in recipe.get("products") or []:
        if product.get("type") != "item":
            continue
        item = items.get(product["name"]) or {}
        if item.get("place_result"):
            return {"name": product["name"], **item}
    return {}


def machines_by_category(entities: dict, geometry: dict | None = None) -> dict:
    """Категория рецепта -> заводы, от самого простого к самому навороченному.

    Считаем один раз на весь дамп: иначе на каждый из тысяч рецептов пришлось бы
    перебирать все заводы. Порядок: сперва ЭЛЕКТРИЧЕСКИЕ, потом маленькие, потом
    медленные — «простой завод» для молла. Рядом с именем лежит признак «есть
    бокс под жидкость»: рецепту с жидкостью годится только такой завод.
    """
    records = bp.entity_records(geometry if geometry is not None else bp.load_geometry())
    by_category: dict[str, list[tuple]] = {}
    for name, entity in entities.items():
        if not entity.get("is_machine"):
            continue
        categories = entity.get("crafting_categories")
        if isinstance(categories, dict):
            categories = list(categories)
        record = records.get(name) or {}
        size = record.get("size") or [entity.get("tile_width") or 1, entity.get("tile_height") or 1]
        source = str(entity.get("energy_source_type") or "").lower()
        electric = 0 if source == "electric" else 1
        key = (electric, int(size[0]) * int(size[1]),
               float(entity.get("crafting_speed") or 1), name)
        for category in categories or []:
            by_category.setdefault(category, []).append((*key, bool(record.get("fluids")), source))
    for rows in by_category.values():
        rows.sort()
    return by_category


def pick_machine(recipe: dict, by_category: dict) -> tuple[str, str] | None:
    """Самый простой завод под категорию рецепта: имя и его источник энергии.

    Электрический впереди: у молла нет топлива. Если под категорию есть ТОЛЬКО
    топливный завод (в Py так у стеклодувной), берём его и честно пишем об этом
    в описании чертежа.
    """
    needs_fluid = any(i.get("type") == "fluid" for i in (recipe.get("ingredients") or []))
    for _electric, _area, _speed, name, has_fluids, source in by_category.get(recipe.get("category")) or []:
        if needs_fluid and not has_fluids:
            continue
        return name, source
    return None


def product_limit(item: dict, entities: dict) -> int | None:
    """Лимит сундука снабжения для того, что делает автомат: ячейки или None.

    Просьба игрока: у заводов (сборщики, печи, буры, котлы, генераторы,
    лаборатории) в сундуке снабжения стоит ограничение — 20 ячеек, чтобы склад не
    забивался сотнями сборщиков. У всего, чего нужно много (столбы, рельсы,
    манипуляторы, ленты, сундуки), лимита нет: сундук наполняется целиком.
    """
    if not item.get("place_result"):
        return None
    record = entities.get(item["place_result"]) or {}
    if record.get("is_machine"):
        return PROVIDER_LIMIT
    if (item.get("place_result_type") or "") in MACHINE_TYPES:
        return PROVIDER_LIMIT
    return None


def building_recipes(dataset: dict, geometry: dict | None = None) -> list[dict]:
    """Рецепты построек в порядке меню крафта, с выбранным заводом.

    Пропускаем скрытые рецепты (их нет в меню — это внутренние заготовки мода) и
    параметрические (служебные рецепты чертежей).
    """
    items = dataset.get("items") or {}
    entities = dataset.get("entities") or {}
    recipes = dataset.get("recipes") or {}
    by_category = machines_by_category(entities, geometry)
    out: list[dict] = []
    for name, recipe in recipes.items():
        products = recipe.get("products") or []
        if not products or any(p.get("type") != "item" for p in products):
            continue
        item = _product_for_menu(recipe, items)
        if not item:
            continue
        if recipe.get("hidden") or recipe.get("parameter") or recipe.get("category") == "parameters":
            continue
        machine = pick_machine(recipe, by_category)
        if not machine:
            continue
        machine_name, energy_source = machine
        out.append({
            "recipe": name,
            "machine": machine_name,
            "energy": energy_source,
            "item": item["name"],
            "group": item.get("group") or "other",
            "subgroup": item.get("subgroup") or "",
            "title": item.get("display_name") or item["name"],
            "limit": product_limit(item, entities),
            "solids": [i for i in (recipe.get("ingredients") or []) if i.get("type") == "item"],
            "fluids": [i for i in (recipe.get("ingredients") or []) if i.get("type") == "fluid"],
            "products": [p for p in products if p.get("type") == "item"],
        })
    out.sort(key=lambda r: (r["group"], r["subgroup"], r["title"], r["recipe"]))
    return out


def request_filters_for(recipe: dict, multiplier: int = REQUEST_MULTIPLIER,
                        cap: int = 100000) -> list[dict]:
    """Что положить в сундук запроса: твёрдые ингредиенты × multiplier.

    Индексы идут подряд, качество — обычное: ровно так игра читает фильтры
    сундука запроса (см. gen.request_filters).
    """
    rows: list[dict] = []
    for ingredient in recipe["solids"]:
        amount = float(ingredient.get("amount") or 0)
        if amount <= 0:
            continue
        count = min(int(math.ceil(amount * multiplier - 1e-9)), cap)
        if count <= 0:
            continue
        rows.append({"index": len(rows) + 1, "name": ingredient["name"],
                     "quality": "normal", "comparator": "=", "count": count})
    return rows


def pole_columns(cell: dict, supply: float) -> list[int]:
    """Колонки столбов в клетке: чтобы каждый потребитель попал в зону питания.

    Зона питания столба — квадрат `supply` вокруг его центра, то есть столб в
    колонке p питает тайлы p-supply…p+supply. Идём слева направо и ставим
    следующий столб в самой правой свободной колонке, которая ещё накрывает
    первый непокрытый тайл: у клетки шириной 7 (обычный сборщик) выходит один
    столб, у широких заводов (11 и 14 клеток) — два-три, иначе дальний
    манипулятор остаётся без электричества.

    Колонки из `poleForbidden` пропускаем: там проходят трубы к портам завода.
    """
    width = int(cell["width"])
    forbidden = set(cell.get("poleForbidden") or ())
    allowed = [col for col in range(width) if col not in forbidden]
    if not allowed:
        allowed = list(range(width))
    reach = max(1, int(math.floor(supply)))
    out: list[int] = []
    left = 0
    while left < width:
        near = [col for col in allowed if left - reach <= col <= left + reach]
        if not near:
            break
        column = max(near)
        out.append(column)
        left = column + reach + 1
    return out


def _west_input_ports(machine: str, direction: int, geometry: dict) -> list[dict]:
    """Патрубки, в которые жидкость входит СЛЕВА от завода (тайл трубы на запад)."""
    out = []
    for port in gen.machine_ports(machine, geometry, direction):
        if (port.get("production") or "input") == "output":
            continue
        if int(port["dx"]) < 0:
            out.append(port)
    return out


def _machine_direction(machine: str, geometry: dict, left_input: bool = False) -> int:
    """Поворот завода: сброс самосбрасывающих — на юг, вход жидкости — налево.

    Два правила:
      * у буров и литейных аппаратов продукт падает сам (vector_to_place_result),
        и тайл сброса обязан быть свободен или занят лентой. Низ завода занят
        манипулятором и сундуками, поэтому такой завод разворачиваем сбросом на
        юг: под ним остаётся пустой тайл, а манипулятор забирает продукт с него;
      * у заводов в жидкостных группах (left_input) вход жидкости разворачиваем
        налево — труба подходит с западной стороны, где ничего не стоит.

    Если правила спорят (завод и сбрасывает сам, и требует жидкость), сброс
    важнее: без свободного тайла под продуктом завод просто встанет.
    """
    dump_dirs = [d for d in (0, 4, 8, 12)
                 if gen.drops_to_belt(machine, geometry)
                 and gen.machine_drop_side(machine, d, geometry) == 8]
    if left_input:
        for direction in (12, 4, 8, 0):
            if not _west_input_ports(machine, direction, geometry):
                continue
            if not dump_dirs or direction in dump_dirs:
                return direction
    if dump_dirs:
        return dump_dirs[0]
    return 0


def _cell_plan(entry: dict, geometry: dict, left_input: bool = False) -> dict:
    """Как ставить одну клетку: поворот завода, колонки сундуков, высота.

    Клетка: сверху завод, ПОД ним в ряд два манипулятора, под ними два сундука —
    слева сундук запроса, справа сундук снабжения. Направление манипулятора в
    игре — это сторона, С КОТОРОЙ он берёт: загрузка берёт из сундука снизу
    (направление 8, юг), выгрузка берёт из завода сверху (направление 0, север).

    Колонки под манипуляторы выбираем свободные от портов жидкости: устье,
    закрытое манипулятором или сундуком, — это труба, которую игрок уже не
    подведёт.
    """
    machine = entry["machine"]
    direction = _machine_direction(machine, geometry, left_input)
    size = bp.entity_size(machine, geometry, direction) or (1, 1)
    width, height = int(size[0]), int(size[1])
    ports = gen.machine_ports(machine, geometry, direction)
    bottom_ports = {int(p["dx"]) for p in ports if int(p["dy"]) >= height}
    top_ports = {int(p["dx"]) for p in ports if int(p["dy"]) < 0}
    free = [x for x in range(width) if x not in bottom_ports]
    if not free:
        free = list(range(width))
    in_col, out_col = free[0], free[-1]
    if out_col == in_col and len(free) > 1:
        out_col = free[-2]
    drop = gen.drop_tile(machine, direction, geometry) if gen.drops_to_belt(machine, geometry) else None
    drop_col = None
    if drop and 0 <= int(drop[0]) < width and int(drop[1]) >= height:
        drop_col = int(drop[0])
        if drop_col in bottom_ports:
            # на тайле сброса стоит труба: продукт класть некуда — ставим как обычно
            drop_col = None
    if drop_col is not None and in_col == drop_col:
        others = [x for x in free if x != drop_col]
        in_col = others[0] if others else in_col
    return {
        **entry,
        "direction": direction,
        "size": (width, height),
        "width": width,
        # высота клетки: завод + ряд манипуляторов + ряд сундуков (+ ряд сброса)
        "rows": height + (3 if drop_col is not None else 2),
        "inCol": in_col,
        "outCol": out_col,
        "dropCol": drop_col,
        "bottomPorts": tuple(sorted(bottom_ports)),
        "topPorts": tuple(sorted(top_ports)),
    }


def group_order(geometry: dict | None = None) -> dict[str, str]:
    """Порядок вкладок крафта: имя группы -> её order из дампа.

    В датасете порядка групп нет, а в игре вкладки меню крафта идут по полю order
    прототипа (у Py это «a», «t2», «v»…). Его кладёт в файл геометрии
    tools/extract_geometry.py. Если файл старый и порядка в нём нет — группы
    идут по алфавиту: раскладка от этого не ломается, меняется только порядок
    участков групп.
    """
    groups = (geometry if geometry is not None else bp.load_geometry()).get("groups") or {}
    out: dict[str, str] = {}
    for name, record in groups.items():
        order = (record or {}).get("order") if isinstance(record, dict) else record
        if order:
            out[str(name)] = str(order)
    return out


def standard_size(entries: list[dict], geometry: dict) -> tuple[int, int]:
    """Самый частый размер завода в молле: остальные считаем нестандартными.

    В Py почти всё делается сборщиком 7×7 (1086 рецептов из 1138), а 45 рецептов
    требуют широких заводов (11×11, 14×14) и одного узкого (5×5). Такие автоматы
    игрок просил убирать вниз своей группы, чтобы ровные столбцы не рвались.
    """
    counts: dict[tuple[int, int], int] = {}
    for entry in entries:
        size = bp.entity_size(entry["machine"], geometry, 0) or (1, 1)
        key = (int(size[0]), int(size[1]))
        counts[key] = counts.get(key, 0) + 1
    if not counts:
        return (1, 1)
    return max(counts.items(), key=lambda kv: (kv[1], kv[0]))[0]


def plan_groups(entries: list[dict], dataset: dict, geometry: dict) -> dict:
    """План раскладки: группы меню крафта, жидкостные группы и остатки.

    Правила (просьбы игрока):
      * автоматы, которым нужна ОДНА жидкость или газ и которых набралось
        FLUID_GROUP_MIN и больше, уезжают в СВОЮ группу по типу жидкости — такие
        группы стоят правее основных, и вход жидкости у них разворачивается
        налево;
      * если таких автоматов 1–2, отдельной группы нет: они уходят ВНИЗ своей
        основной группы;
      * автоматы, которым нужно 2+ жидкости, тоже уходят вниз своей группы;
      * нестандартные по размеру заводы — вниз своей группы.

    Возвращает {"groups": [...], "fluidGroups": [...], "standard": (w, h)}:
    группы идут в порядке вкладок, жидкостные — после них, по числу автоматов.
    """
    order = group_order(geometry)
    standard = standard_size(entries, geometry)
    by_fluid: dict[str, list[dict]] = {}
    multi: list[dict] = []
    for entry in entries:
        names = [fluid["name"] for fluid in entry["fluids"]]
        if len(names) == 1:
            by_fluid.setdefault(names[0], []).append(entry)
        elif names:
            multi.append(entry)
    big = {name: group for name, group in by_fluid.items() if len(group) >= FLUID_GROUP_MIN}
    moved = {id(entry) for group in big.values() for entry in group}
    flu_fluids = dataset.get("fluids") or {}

    def fluid_title(name: str) -> str:
        record = flu_fluids.get(name) or {}
        kind = "газ" if str(record.get("type") or "").lower() == "gas" else "жидкость"
        return f"{kind}: {record.get('display_name') or name}"

    # --- основные группы: обычные автоматы по порядку меню, «специальные» — вниз
    leftovers = {id(entry) for entry in multi}
    leftovers |= {id(entry) for name, group in by_fluid.items() if name not in big
                  for entry in group}
    by_group: dict[str, list[dict]] = {}
    for entry in entries:
        if id(entry) in moved:
            continue
        by_group.setdefault(entry["group"], []).append(entry)

    def sort_key(entry: dict) -> tuple:
        return (1 if id(entry) in leftovers else 0, 1 if _is_odd(entry) else 0,
                entry["subgroup"], entry["title"], entry["recipe"])

    def _is_odd(entry: dict) -> bool:
        size = bp.entity_size(entry["machine"], geometry, 0) or (1, 1)
        return (int(size[0]), int(size[1])) != standard

    plain_entries = [entry for entry in entries if id(entry) not in moved]
    fluid_names = sorted(big, key=lambda name: (-len(big[name]), name))
    groups: list[dict] = []
    for name in sorted(by_group, key=lambda g: (g not in order, order.get(g, ""), g)):
        mixed = sorted(by_group[name], key=sort_key)
        for entry in mixed:
            entry["bottomOfGroup"] = bool(id(entry) in leftovers or _is_odd(entry))
            entry["fluidGroup"] = None
        groups.append({
            "group": name,
            "title": name,
            "fluid": None,
            "leftInput": False,
            "entries": mixed,
        })
    fluid_groups: list[dict] = []
    for name in fluid_names:
        mixed = sorted(big[name], key=sort_key)
        for entry in mixed:
            entry["bottomOfGroup"] = bool(_is_odd(entry))
            entry["fluidGroup"] = name
        fluid_groups.append({
            "group": name,
            "title": fluid_title(name),
            "fluid": name,
            "leftInput": True,
            "entries": mixed,
        })
    return {"groups": groups, "fluidGroups": fluid_groups, "standard": standard,
            "entries": plain_entries}


def layout_columns(entries: list[dict], geometry: dict, per_row: int = PER_COLUMN,
                   dataset: dict | None = None, plan: dict | None = None) -> list[dict]:
    """Столбцы автоматов: группа — вкладка крафта, в столбце не больше per_row.

    Группы идут как вкладки в игре (по order прототипа), внутри группы — порядок
    меню крафта (подгруппа, название), но нестандартные по размеру и «жидкостные
    остатки» — вниз группы. Жидкостные группы стоят после основных. Каждая группа
    занимает свой участок столбцов: между группами GROUP_GAP клеток, между
    столбцами одной группы GAP_X. Внутри столбца клетки стоят друг под другом с
    отступом GAP_Y (в этой полосе идут столбы).

    `plan` передаётся, когда чертёж собирается из ЧАСТИ списка (молл режется на
    части по длине строки): решение «какие автоматы в жидкостной группе и что
    уходит вниз» принимается по ВСЕМУ списку, иначе часть, разрезанная посреди
    жидкости, потеряла бы группу и поворот входа.

    Порядок чтения: сверху вниз по столбцу, потом следующий столбец той же
    группы, и только потом следующая группа.
    """
    if plan is None:
        plan = plan_groups(entries, dataset if dataset is not None else {}, geometry)
    wanted = {id(entry) for entry in entries}
    step = max(1, int(per_row))
    columns: list[dict] = []
    for group in list(plan["groups"]) + list(plan["fluidGroups"]):
        group_entries = [entry for entry in group["entries"] if id(entry) in wanted]
        if not group_entries:
            continue
        cells = [_cell_plan(entry, geometry, group["leftInput"]) for entry in group_entries]
        for start in range(0, len(cells), step):
            part = cells[start:start + step]
            columns.append({
                "group": group["group"],
                "groupTitle": group["title"],
                "fluid": group["fluid"],
                "fluidGroup": group["fluid"] is not None,
                "cells": part,
                "width": max(int(c["width"]) for c in part),
                "x": 0,
            })
    # столбец знает, какая клетка идёт в нём следующей: у неё сверху могут быть
    # порты, а через полосу столбов к ним идёт труба
    for plane in columns:
        for index, cell in enumerate(plane["cells"]):
            nxt = plane["cells"][index + 1] if index + 1 < len(plane["cells"]) else None
            forbidden = set(cell["bottomPorts"])
            if nxt is not None:
                forbidden |= set(nxt["topPorts"])
            cell["poleForbidden"] = forbidden
            cell["column"] = plane
    x = MARGIN
    previous = None
    for plane in columns:
        if previous is not None:
            # жидкостные группы — тоже отдельные участки: проход как между группами
            same = plane["group"] == previous and not plane["fluidGroup"]
            x += GAP_X if same else GROUP_GAP
        plane["x"] = x
        x += plane["width"]
        previous = plane["group"]
    return columns


def _build_chunk(entries: list[dict], geom: dict, per_row: int, multiplier: int,
                 pole: str | None, label: str, index: int, total: int,
                 offset: int, total_recipes: int, dataset: dict | None = None,
                 plan: dict | None = None) -> dict:
    """Один чертёж молла: столбцы автоматов с сундуками и питанием.

    Части нужны потому, что строка ВСЕГО молла (~130 КБ) в игру не вставляется:
    в окне импорта есть предел длины, и вместо чертежа игрок получает «ошибку
    импорта».
    """
    recipes = entries
    supply, wire = gen._supply_and_wire(pole, geom) if pole else (0.0, 0.0)

    entities: list = []
    number = 1

    def put(name: str, x: int, y: int, direction: int = 0) -> dict:
        nonlocal number
        entity = gen._entity(number, name, x, y, (1, 1), direction)
        entities.append(entity)
        number += 1
        return entity

    # --- раскладка: столбцы по группам меню крафта, жидкостные группы — правее
    columns = layout_columns(recipes, geom, per_row, dataset, plan)
    placements: list[dict] = []
    for plane in columns:
        y = MARGIN
        for cell in plane["cells"]:
            placements.append({**cell, "x": plane["x"], "top": y, "column": plane})
            y += int(cell["rows"]) + GAP_Y
    right = max((p["x"] + p["width"] for p in placements), default=MARGIN)
    bottom = max((p["top"] + p["rows"] for p in placements), default=MARGIN)

    # --- постройки по клеткам
    for cell in placements:
        x, top = cell["x"], cell["top"]
        width, height = int(cell["size"][0]), int(cell["size"][1])
        # Сундук запроса стоит ПОД заводом, манипулятор — между ними и берёт снизу.
        chest_in = put(REQUESTER, x + cell["inCol"], top + height + 1, 0)
        filters = request_filters_for(cell, multiplier)
        if filters:
            chest_in["request_filters"] = {"sections": [{"index": 1, "filters": filters}]}
        put(INSERTER, x + cell["inCol"], top + height, 8)
        machine = gen._entity(number, cell["machine"], x, top, cell["size"], cell["direction"])
        machine["recipe"] = cell["recipe"]
        machine["recipe_quality"] = "normal"
        entities.append(machine)
        number += 1
        if cell["dropCol"] is None:
            # Выгрузка: манипулятор берёт из завода (север) в сундук снабжения снизу.
            put(INSERTER, x + cell["outCol"], top + height, 0)
            chest_out = put(PROVIDER, x + cell["outCol"], top + height + 1, 0)
        else:
            # Завод сам кладёт продукт на тайл под собой: тайл свободен, а
            # манипулятор забирает продукт уже с него в сундук снабжения.
            put(INSERTER, x + cell["dropCol"], top + height + 1, 0)
            chest_out = put(PROVIDER, x + cell["dropCol"], top + height + 2, 0)
        # Лимит сундука снабжения: у заводов 20 ячеек, у всего остального лимита
        # нет — пусть сундук наполняется целиком.
        if cell.get("limit"):
            chest_out["bar"] = int(cell["limit"])

    # --- столбы: по одному в полосе под каждой клеткой, потом одна общая сеть
    notes: list[str] = []
    if pole:
        blocked = _occupied(entities, geom)
        # Порты жидкости — не для столба: трубу к ним игрок подводит сам.
        for cell in placements:
            for port in gen.machine_ports(cell["machine"], geom, cell["direction"]):
                blocked.add((cell["x"] + int(port["dx"]), cell["top"] + int(port["dy"])))
        poles: list[tuple[int, int]] = []
        for cell in placements:
            y_pole = cell["top"] + int(cell["rows"])
            for col in pole_columns(cell, supply):
                tile = (cell["x"] + col, y_pole)
                if tile not in blocked:
                    poles.append(tile)
                    blocked.add(tile)
        extra, wire_notes = gen.connect_pole_network(poles, blocked, wire=wire)
        poles.extend(extra)
        for (px, py) in poles:
            put(pole, px, py, 0)
        # Провода между столбами: игра строит ИМЕННО прописанные связи, и без
        # `neighbours` тысяча столбов молла встала бы без проводов
        # (см. bp.connect_power_wires).
        bp.connect_power_wires({"blueprint": {"entities": entities}}, geom)
        notes.extend(wire_notes)

    # --- описание и стат
    fluid_cells = [c for c in placements if c["fluids"]]
    dump_cells = [c for c in placements if c["dropCol"] is not None]
    per_machine: dict[str, int] = {}
    for cell in placements:
        per_machine[cell["machine"]] = per_machine.get(cell["machine"], 0) + 1
    duplicated = _duplicated_products(placements)
    first, last = offset + 1, offset + len(placements)
    per_group: dict[str, int] = {}
    for plane in columns:
        per_group[plane["group"]] = per_group.get(plane["group"], 0) + len(plane["cells"])
    fluid_names = [plane["fluid"] for plane in columns if plane["fluidGroup"]]
    seen_fluids: list[str] = []
    for name in fluid_names:
        if name not in seen_fluids:
            seen_fluids.append(name)
    lines = [
        f"Часть {index} из {total}: автоматы {first}–{last} из {total_recipes}. Строка всего "
        f"молла для вставки в игру слишком длинная, поэтому он порезан на части — "
        f"вставляй их по очереди, друг за другом.",
        f"Группы идут как вкладки крафта: у каждой свой участок, порядок автоматов внутри — "
        f"как в меню крафта (группа → подгруппа → название). В столбце до {per_row} автоматов "
        f"вниз, между столбцами одной группы {GAP_X} клетки, между группами {GROUP_GAP}.",
        f"Клетка: сверху автомат, ПОД ним два манипулятора, под ними два сундука — "
        f"слева сундук запроса, справа сундук снабжения. Загрузка берёт из сундука запроса, "
        f"выгрузка кладёт в сундук снабжения.",
        f"В сундуке ЗАПРОСА лежит то, что нужно автомату, ×{multiplier}; "
        f"из сундука СНАБЖЕНИЯ готовое забирает логистика. У заводов (сборщики, печи, "
        f"буры, котлы, генераторы, лаборатории) в сундуке снабжения стоит лимит "
        f"{PROVIDER_LIMIT} ячеек, у остального лимита нет — сундук наполняется целиком.",
        f"Часть начинается с «{placements[0]['title']}», кончается «{placements[-1]['title']}».",
        f"Столбцов: {len(columns)} — " + ", ".join(
            f"{name}: {count}" for name, count in
            sorted(per_group.items(), key=lambda kv: -kv[1])[:8])
        + ("…" if len(per_group) > 8 else "") + " автоматов.",
    ]
    bottom_cells = [c for c in placements if c.get("bottomOfGroup")]
    if bottom_cells:
        lines.append(
            f"Вниз своих групп убраны {len(bottom_cells)} {_automats_ru(len(bottom_cells))} — "
            f"нестандартные по размеру заводы и рецепты на 1–2 жидкости: так ровные столбцы "
            f"не рвутся.")
    if seen_fluids:
        lines.append(
            f"Отдельные группы по жидкости: {len(seen_fluids)} — вход жидкости у них "
            f"развёрнут НАЛЕВО, труба подходит с западной стороны:")
        for name in seen_fluids[:10]:
            cells = [c for c in placements if c["column"].get("fluid") == name]
            if not cells:
                continue
            title = cells[0]["column"]["groupTitle"]
            left = min(c["x"] for c in cells)
            rightmost = max(c["x"] + int(c["width"]) for c in cells) - 1
            lines.append(f"    {title} — {len(cells)} {_automats_ru(len(cells))}, "
                         f"x от {left} до {rightmost}")
        if len(seen_fluids) > 10:
            lines.append(f"    …и ещё {len(seen_fluids) - 10}")

    if dump_cells:
        lines.append(
            f"Автоматов, которые кладут продукт сами: {len(dump_cells)} — у них тайл под "
            f"заводом свободен, а манипулятор забирает продукт с него:")
        for cell in dump_cells[:10]:
            lines.append(f"    {cell['title']}: {cell['machine']} (поворот {cell['direction']}) "
                         f"на x={cell['x']}, y={cell['top']}")
        if len(dump_cells) > 10:
            lines.append(f"    …и ещё {len(dump_cells) - 10}")
    if duplicated:
        lines.append(
            f"В дампе на часть построек по два рецепта, поэтому {duplicated} "
            f"{_automats_ru(duplicated)} делают то же, что и соседний, — их можно снести.")
    if fluid_cells:
        lines.append(
            f"Рецептов с жидкостью: {len(fluid_cells)} — в сундук жидкость не положить, "
            f"поэтому тайлы портов у них свободны: подведи трубу к автомату.")
        for cell in fluid_cells[:10]:
            lines.append(f"    {cell['title']}: {' + '.join(f['name'] for f in cell['fluids'])} "
                         f"({cell['machine']} на x={cell['x']}, y={cell['top']})")
        if len(fluid_cells) > 10:
            lines.append(f"    …и ещё {len(fluid_cells) - 10}")
    fat = [c for c in placements if len(request_filters_for(c, multiplier)) > 12]
    if fat:
        lines.append(f"У {len(fat)} автоматов в запросе больше 12 позиций: "
                     f"проверь, что в сундуке хватает слотов под фильтры.")
    fueled = [c for c in placements if c.get("energy") and c["energy"] != "electric"]
    if fueled:
        lines.append(
            f"Автоматов не на электричестве: {len(fueled)} — под их категорию "
            f"электрического завода в дампе нет, топливо подведи сам:")
        for cell in fueled[:10]:
            lines.append(f"    {cell['title']}: {cell['machine']} ({cell['energy']}) "
                         f"на x={cell['x']}, y={cell['top']}")
        if len(fueled) > 10:
            lines.append(f"    …и ещё {len(fueled) - 10}")
    lines.append("Заводы: " + ", ".join(f"{name} ×{count}" for name, count in
                                        sorted(per_machine.items(), key=lambda kv: (-kv[1], kv[0]))))
    chunk_label = f"{label} {index}/{total} ({len(placements)} автоматов)"
    blueprint = {
        "item": "blueprint",
        "version": gen.BLUEPRINT_VERSION,
        "label": chunk_label[:200],
        "description": "\n".join(lines + notes),
        "entities": entities,
    }
    return {
        "index": index,
        "total": total,
        # Обёртка {"blueprint": {...}} обязательна: игра принимает только такой
        # формат (как и её собственный экспорт и чертежи этапов). Плоский объект
        # {"item": "blueprint", ...} игра при импорте отвергает — из-за этого
        # падал импорт ячейки diag-04.
        "blueprint": {"blueprint": blueprint},
        "label": chunk_label,
        "first": first,
        "last": last,
        "columns": len(columns),
        "recipes": len(placements),
        "perMachine": per_machine,
        "groups": per_group,
        "withFluids": [c["recipe"] for c in fluid_cells],
        "fueled": [{"recipe": c["recipe"], "machine": c["machine"], "energy": c["energy"],
                    "x": c["x"], "y": c["top"]} for c in fueled],
        "width": right - MARGIN + MARGIN,
        "height": bottom - MARGIN + MARGIN,
        "entities": len(entities),
    }


def build_mall(dataset_id: str | None = None, geometry: dict | None = None,
               per_row: int = PER_ROW, per_chunk: int | None = None,
               max_chars: int = MAX_CHARS,
               multiplier: int = REQUEST_MULTIPLIER,
               pole: str | None = None, label: str = "Сборщики всего") -> dict:
    """Чертежи всего молла, порезанные на части (см. _build_chunk).

    Части режутся ПО ДЛИНЕ строки (max_chars): игра не принимает длинные вставки в
    окно импорта, а сколько именно она тянет — зависит от её настроек. Если задан
    `per_chunk`, режем по числу автоматов (нужно для проверок); иначе — по длине.

    Возвращает {"chunks": [...], "recipes": N, "entities": N, ...}: каждая часть —
    отдельный чертёж, который игра принимает вставкой.
    """
    geom = geometry if geometry is not None else bp.load_geometry()
    if not geom:
        raise ValueError("нет файла геометрии — сделай дамп: сделать дамп геометрии.bat")
    dataset = _dataset(dataset_id)
    recipes = building_recipes(dataset, geom)
    if not recipes:
        raise ValueError("в датасете нет рецептов построек")
    # План раскладки считается по ВСЕМУ списку: от него зависят и порядок групп, и
    # то, какие автоматы уезжают в жидкостные группы и вниз своих групп. Части
    # режутся уже по этому порядку, иначе часть, разрезанная посреди жидкости,
    # потеряла бы свою группу.
    plan = plan_groups(recipes, dataset, geom)
    ordered = [entry for group in plan["groups"] + plan["fluidGroups"]
               for entry in group["entries"]]
    kwargs = {"per_row": per_row, "multiplier": multiplier, "pole": pole,
              "dataset": dataset, "plan": plan}

    def assemble(parts: list[list[dict]]) -> list[dict]:
        """Собирает пронумерованные части: номера знает только этот шаг."""
        out = []
        offset = 0
        for index, part in enumerate(parts):
            out.append(_build_chunk(part, geom, label=label, index=index + 1,
                                    total=len(parts), offset=offset,
                                    total_recipes=len(ordered), **kwargs))
            offset += len(part)
        return out

    if per_chunk:
        size = max(1, int(per_chunk))
        parts = [ordered[i:i + size] for i in range(0, len(ordered), size)]
        chunks = assemble(parts)
    elif not max_chars:
        # Предела нет — отдаём всё одним чертежом: такие строки в окно импорта не
        # вставить, зато файл можно перетащить в игру.
        parts = [ordered]
        chunks = assemble(parts)
    else:
        budget = max(1, int(max_chars))
        parts = _split_by_length(ordered, geom, budget, **kwargs)
        chunks = assemble(parts)
        # Примерочная проверка идёт по описанию «часть 1 из 1», а в настоящем
        # описании стоит номер части и список жидкостей именно этой части: строка
        # может вылезти за предел на пару сотен символов. Поэтому проверяем
        # НАСТОЯЩИЕ строки и делим те части, которые не влезли.
        for _ in range(8):
            over = {index for index, chunk in enumerate(chunks)
                    if len(bp.encode_string(chunk["blueprint"])) > budget}
            if not over:
                break
            grown: list[list[dict]] = []
            changed = False
            for index, part in enumerate(parts):
                if index in over and len(part) > 1:
                    half = max(1, len(part) // 2)
                    grown.extend([part[:half], part[half:]])
                    changed = True
                else:
                    grown.append(part)
            if not changed:
                break
            parts = grown
            chunks = assemble(parts)
    per_machine: dict[str, int] = {}
    for chunk in chunks:
        for name, count in chunk["perMachine"].items():
            per_machine[name] = per_machine.get(name, 0) + count
    return {
        "chunks": chunks,
        "recipes": len(recipes),
        "entities": sum(chunk["entities"] for chunk in chunks),
        "perMachine": per_machine,
        "withFluids": [recipe for chunk in chunks for recipe in chunk["withFluids"]],
        "fueled": [cell for chunk in chunks for cell in chunk["fueled"]],
    }


def _split_by_length(recipes: list[dict], geom: dict, max_chars: int,
                     **kwargs) -> list[list[dict]]:
    """Режет список автоматов на части так, чтобы строка каждой влезала в предел.

    Делим пополам, пока часть не влезет: длина строки растёт не ровно (у одного
    автомата в сундуке три позиции, у другого двадцать), поэтому считать по
    среднему нельзя — проверяем НАСТОЯЩУЮ строку.
    """
    parts: list[list[dict]] = []
    queue: list[list[dict]] = [recipes]
    # 300 символов запаса: в примерочной сборке описание короче (номер части и
    # списки жидкостей), поэтому проверяем с запасом, а точную проверку делает
    # build_mall на готовых частях.
    limit = max(1, max_chars - 300)
    while queue:
        part = queue.pop(0)
        if not part:
            continue
        built = _build_chunk(part, geom, label="", index=1, total=1, offset=0,
                             total_recipes=len(recipes), **kwargs)
        if len(part) == 1 or len(bp.encode_string(built["blueprint"])) <= limit:
            parts.append(part)
            continue
        half = max(1, len(part) // 2)
        queue.insert(0, part[half:])
        queue.insert(0, part[:half])
    return parts


def _occupied(entities: list, geometry: dict) -> set:
    """Занятые тайлы: полными габаритами построек."""
    blocked: set = set()
    for entity in entities:
        tile = bp.tiles_of(entity, geometry)
        if not tile:
            continue
        left, top, width, height = tile
        blocked.update((left + dx, top + dy) for dx in range(width) for dy in range(height))
    return blocked


def _automats_ru(n: int) -> str:
    """«1 автомат», «2 автомата», «5 автоматов» — описание читает игрок."""
    n10, n100 = n % 10, n % 100
    if n10 == 1 and n100 != 11:
        return "автомат"
    if 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        return "автомата"
    return "автоматов"


def _duplicated_products(placements: list[dict]) -> int:
    """Сколько автоматов делают то, что уже делает другой (дубли рецептов в дампе)."""
    seen: dict[str, int] = {}
    for cell in placements:
        for product in cell["products"]:
            seen[product["name"]] = seen.get(product["name"], 0) + 1
    return sum(count - 1 for count in seen.values() if count > 1)
