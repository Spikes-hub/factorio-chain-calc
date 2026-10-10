"""Подземные трубы к портам заводов в блоке-«бутерброде» (первый шаг).

Что делаем. У завода с жидкостью на входе или выходе есть порт — тайл подхода у
стены завода. Если порт смотрит НАРУЖУ блока (в коридор с манипуляторами, за ним
ленты подачи), то трубу подводим так:

    [выход][ствол]   ...   [подземная труба у порта]  [завод]
      ^ подземный проход под лентами и манипуляторами ^

  * у самого порта — подземная труба, устьем к заводу, туннелем наружу;
  * за лентами, на краю группы, — вторая подземная труба, устьем наружу;
  * от неё — ствол: вертикальный ряд обычных труб, в который стекаются выходы
    всех заводов столбца. Игроку остаётся подвести жидкость к ОДНОМУ месту на
    группу и сторону.

Разные жидкости идут разными стволами (между ними пустой столбец с подземной
трубой), поэтому не смешиваются. Порт, который смотрит в соседний завод, в
середину блока (к ленте выгрузки) или упирается в занятый тайл, остаётся
свободным — о каждом таком случае пишем в замечания.

Порты, которые смотрят ВНУТРЬ блока (в коридор к ленте выгрузки), соединяем иначе:
туннель отсюда прошёл бы под соседним столбцом заводов и сошёлся бы с туннелем той
стороны. Поэтому в коридоре столбца ставится ЦЕПОЧКА:

    [труба у порта 1] [подземная ↓] .... [подземная ↑] [труба у порта 2] ...

  * у каждого порта — обычная труба (она же касается порта завода);
  * между соседними портами — пара подземных труб (или одна обычная, если между
    портами один тайл): туннель идёт под манипуляторами коридора;
  * вся цепочка столбца — одна сеть, у неё два свободных конца (над первым и под
    последним портом): жидкость подводят к любому.

Что не делаем: порты второго и следующих боксов жидкости, перекрёстки труб.
"""
from __future__ import annotations

import blueprint as bp

# Куда смотрит порт наружу: у левого столбца это запад, у правого — восток.
WEST, EAST = 12, 4

DEFAULT_UNDERGROUND = 10


def side_width(count: int) -> int:
    """Сколько столбцов тайлов нужно стволам с одной стороны группы.

    На каждую жидкость — два столбца (выход подземной трубы и сам ствол) плюс один
    пустой с края группы, чтобы ствол не прижимался к лентам подачи.
    """
    return 2 * count + 1 if count > 0 else 0


def outer_ports(ports: list[dict], wall: int) -> list[dict]:
    """Порты, которые смотрят на нужную внешнюю стену."""
    return [p for p in ports if p.get("direction") == wall]


def ordered_boxes(ports: list, role: str, wall: int | None, alternate: bool = False, count: int = 0) -> list:
    """Боксы одной роли в порядке выбора под жидкости рецепта.

    Игра кладёт жидкость рецепта в любой подходящий вход (у шаблонов пользователя жидкость идёт и в четвёртый
    вход литейной, и в нужный по стороне вход у газификатора), поэтому первыми берём боксы, у которых есть устье на
    нужную стену — туда подводится труба. Бокс жидкого топлива принимает только топливо и всегда стоит первым."""
    boxes = sorted({p["box"] for p in ports if p.get("production") == role})
    # сквозной вход топлива (вход-выход) к рецепту не относится: топливо идёт через заводы столбца, см. energy_passthrough
    through = [b for b in boxes if any(p["box"] == b and p.get("energy") and p.get("flow") == "input-output"
                                       for p in ports)]
    boxes = [b for b in boxes if b not in through]
    energy = [b for b in boxes if any(p["box"] == b and p.get("energy") for p in ports)]
    rest = [b for b in boxes if b not in energy]
    if wall is None:
        return energy + rest
    if alternate and count > 1:
        # Коридор занят лентой выгрузки, там помещается одна цепочка: жидкости раскладываем по стенам по очереди
        # (первая — на нужную стену, вторая — на противоположную), как в шаблоне с колонной сухой перегонки.
        opposite = (wall + 8) % 16
        remaining = list(rest)
        order: list = []
        for index in range(count):
            preferred = (wall, opposite) if index % 2 == 0 else (opposite, wall)
            pick = None
            for side in preferred:
                pick = next((b for b in remaining if any(p["box"] == b and p.get("direction") == side for p in ports)),
                            None)
                if pick is not None:
                    break
            if pick is None and remaining:
                pick = remaining[0]
            if pick is None:
                break
            order.append(pick)
            remaining.remove(pick)
        return energy + order + remaining
    facing = [b for b in rest if any(p["box"] == b and p.get("direction") == wall for p in ports)]
    # после боксов на нужную стену — боксы на противоположную (в коридор между столбцами: туда ведёт труба), и только
    # потом те, чьё устье смотрит вдоль стенки (к ним трубу не подвести)
    opposite = (wall + 8) % 16
    inner = [b for b in rest if b not in facing
             and any(p["box"] == b and p.get("direction") == opposite for p in ports)]
    return energy + facing + inner + [b for b in rest if b not in facing and b not in inner]


def chain_feasible(pitch: int, reach: int) -> bool:
    """Цепочка вдоль стенки: между соседними портами (шаг заводов pitch) помещается пара подземных труб."""
    return pitch - 1 <= reach


def trunk_keys(keys: list, feasible: bool = True) -> list:
    """Какие из ключей стороны идут стволом: первая жидкость идёт цепочкой в коридоре манипуляторов у стенки
    завода (как в шаблонах: труба у порта и подземные перемычки под манипуляторами), ствол с краю группы нужен
    только остальным. Если порты слишком далеко друг от друга для подземной трубы, стволом идут все."""
    return list(keys[1:]) if feasible else list(keys)


def outer_keys(ports: list[dict], wall: int, inputs: list, outputs: list, inward_outputs: bool = True,
               split_outputs: bool = False) -> list:
    """Ключи (роль, жидкость) стволов с этой стороны — теми же правилами, что в group_pipes.

    Берём ПЕРВЫЙ бокс входа и ПЕРВЫЙ бокс выхода; если у бокса есть устье на нужную стену,
    у него будет ствол. Ширину под стволы считают по этому списку заранее, до раскладки, и
    потому она обязана совпадать с тем, что потом поставит group_pipes.
    """
    keys = []
    for role, fluids in (("input", inputs), ("output", outputs)):
        # выходы в обычной раскладке смотрят в коридор между столбцами (на противоположную стену)
        role_wall = (wall + 8) % 16 if (role == "output" and inward_outputs) else wall
        boxes = ordered_boxes(ports, role, role_wall, alternate=split_outputs and role == "output",
                              count=len(fluids))
        # i-я жидкость рецепта идёт в i-й бокс этого порядка (см. ordered_boxes)
        for index, fluid in enumerate(fluids):
            if index < len(boxes) and any(
                    p["box"] == boxes[index] and p.get("direction") == wall for p in ports):
                keys.append((role, fluid))
    return keys


def inner_keys(ports: list[dict], wall: int, inputs: list, outputs: list, inward_outputs: bool = True,
               split_outputs: bool = False) -> list:
    """Ключи (роль, жидкость), чей порт смотрит не наружу (wall), а в коридор между столбцами.

    Первая такая жидкость идёт цепочкой в полосе у завода, остальным нужны стволы в середине коридора
    (шаблон «Три и больше входных жидкости — битум»: полоса, выход, ствол, выход, полоса — пять тайлов)."""
    keys = []
    for role, fluids in (("input", inputs), ("output", outputs)):
        role_wall = (wall + 8) % 16 if (role == "output" and inward_outputs) else wall
        boxes = ordered_boxes(ports, role, role_wall, alternate=split_outputs and role == "output",
                              count=len(fluids))
        for index, fluid in enumerate(fluids):
            if index >= len(boxes):
                continue
            mouths = [p for p in ports if p["box"] == boxes[index]]
            if any(p.get("direction") == wall for p in mouths):
                continue
            if any(p.get("direction") == (wall + 8) % 16 for p in mouths):
                keys.append((role, fluid))
    return keys


def pipe_categories(geometry: dict | None, name: str) -> list:
    """Категории соединения трубы (у обычной их нет — это «default»)."""
    rec = bp.entity_record(name, geometry) or {}
    for box in rec.get("fluids") or []:
        for conn in box.get("pipes") or []:
            if conn.get("categories"):
                return list(conn["categories"])
    return ["default"]


def pipe_types(geometry: dict | None = None) -> list[dict]:
    """Все виды труб из геометрии: [{name, ground, categories}] — только те, у кого есть и
    обычная, и подземная труба (имя подземной — имя трубы + «-to-ground»)."""
    records = bp.entity_records(geometry)
    out = []
    for name, rec in records.items():
        if rec.get("type") != "pipe":
            continue
        ground = f"{name}-to-ground"
        if (records.get(ground) or {}).get("type") != "pipe-to-ground":
            continue
        out.append({"name": name, "ground": ground, "categories": pipe_categories(geometry, name)})
    out.sort(key=lambda item: (item["name"] != "pipe", item["name"]))
    return out


def _max_underground(geometry: dict | None, name: str) -> int:
    rec = bp.entity_record(name, geometry) or {}
    for box in rec.get("fluids") or []:
        for conn in box.get("pipes") or []:
            if conn.get("type") == "underground" and conn.get("max_underground"):
                return int(conn["max_underground"])
    return DEFAULT_UNDERGROUND


def _occupied(entities: list[dict], geometry: dict | None) -> set:
    tiles: set = set()
    for ent in entities:
        t = bp.tiles_of(ent, geometry)
        if not t:
            continue
        left, top, w, h = t
        for x in range(left, left + w):
            for y in range(top, top + h):
                tiles.add((x, y))
    return tiles


def occupied_by(entities: list[dict], name: str, geometry: dict | None) -> set:
    """Тайлы, занятые постройками с этим именем."""
    return _occupied([e for e in entities if e.get("name") == name], geometry)


def _entity(number: int, name: str, tile: tuple[int, int], direction: int = 0) -> dict:
    return {"entity_number": number, "name": name,
            "position": bp.position_for_tile(tile[0], tile[1], 1, 1),
            "direction": direction}


def _lay_run(column: int, y_top: int, y_bottom: int, occupied: set, taken: set, reach: int) -> list | None:
    """Линия труб между двумя портами одного столбца: обычные трубы по свободным тайлам и короткие подземные пары под
    занятыми. Возвращает [(y, "pipe" | "in" | "out")] или None, если не вышло (нет свободных клеток у краёв
    занятого участка или он длиннее подземной трубы)."""
    cells = list(range(y_top + 1, y_bottom))

    def free(y: int) -> bool:
        return (column, y) not in occupied and (column, y) not in taken

    plan: list = []
    i = 0
    while i < len(cells):
        if free(cells[i]):
            plan.append([cells[i], "pipe"])
            i += 1
            continue
        j = i
        while j < len(cells) and not free(cells[j]):
            j += 1
        if i == 0 or j >= len(cells) or plan[-1][1] != "pipe":
            return None                               # некуда поставить вход или выход подземной пары
        if j + 1 < len(cells) and not free(cells[j + 1]):
            return None                               # после выхода сразу занято: к нему нечем подключиться
        entrance = plan[-1][0]
        if cells[j] - entrance > reach - 1:
            return None
        plan[-1][1] = "in"
        plan.append([cells[j], "out"])
        i = j + 1
    return [(y, kind) for y, kind in plan]


def group_pipes(entities: list[dict], number: int, *, machine: str, recipe_inputs: list,
                recipe_outputs: list, x0: int, x_end: int, y0: int, y1: int,
                geometry: dict | None, pipe: str = "pipe",
                pipe_ground: str = "pipe-to-ground", west_only: bool = False,
                inward_outputs: bool = True, soft: str | None = None,
                center_trunks_ok: bool = False, split_outputs: bool = False, exclude_boxes: set | None = None,
                gap_keys: list | None = None, extra_ports: list | None = None,
                used_log: list | None = None) -> tuple[list[dict], int, list[str]]:
    """Трубы одной группы. Возвращает (новые сущности, следующий номер, замечания).

    x0 / x_end — левый и правый (не включая) край группы в тайлах, y0..y1 — её
    высота. Заводы группы берём из уже расставленных `entities`.
    """
    notes: list[str] = []
    records = bp.entity_records(geometry)
    if pipe not in records or pipe_ground not in records:
        return [], number, [f"трубы не ставились: в дампе геометрии нет {pipe} или {pipe_ground}"]
    reach = _max_underground(geometry, pipe_ground)
    my_categories = set(pipe_categories(geometry, pipe))
    # soft — имя построек (столбы), которые труба вытесняет: столб переставят после, труба важнее
    occupied = _occupied([e for e in entities if not (soft and e.get("name") == soft)], geometry)
    mid = (x0 + x_end) / 2

    # (роль, жидкость) -> порядковый номер ствола на этой стороне
    keys_by_side: dict = {WEST: [], EAST: []}
    stubs: list = []   # (side, key, approach tile)
    inward_pairs: set = set()   # (ключ, x коридора) портов, которые смотрят внутрь блока
    inner: dict = {}   # (ключ, x коридора) -> [тайлы подхода] для цепочек; оба столбца в один коридор сливаются
    for ent in entities:
        if ent.get("name") != machine:
            continue
        t = bp.tiles_of(ent, geometry)
        if not t or not (x0 <= t[0] < x_end and y0 <= t[1] < y1):
            continue
        side = WEST if (west_only or t[0] + t[2] / 2 < mid) else EAST
        conns = [c for c in bp.fluid_connections(ent, geometry)
                 if c["kind"] != "underground" and c["box"] not in (exclude_boxes or ())]
        for role, fluids in (("input", recipe_inputs), ("output", recipe_outputs)):
            boxes = ordered_boxes(conns, role, (side + 8) % 16 if (role == "output" and inward_outputs) else side,
                                  alternate=split_outputs and role == "output", count=len(fluids))
            for index, fluid in enumerate(fluids):
                if index >= len(boxes):
                    notes.append(f"{role}: у завода нет бокса под жидкость {fluid} — трубу проведи сам")
                    continue
                mine = [c for c in conns if c["box"] == boxes[index]]
                if used_log is not None:
                    used_log.append((t[0], t[1], boxes[index], (role, fluid)))
                compatible = [c for c in mine if my_categories & set(c.get("categories") or ["default"])]
                if mine and not compatible:
                    need = "/".join(sorted(set(mine[0].get("categories") or ["default"])))
                    notes.append(f"{role}: труба «{pipe}» не подходит к порту жидкости {fluid} "
                                 f"(нужна категория {need}) — выбери другую трубу в настройках")
                    continue
                mine = compatible
                wanted = [c for c in mine if c["direction"] == side]
                if not wanted:
                    inward = [c for c in mine if c["direction"] == (side + 8) % 16]
                    if not inward:
                        notes.append(f"{role}: порт жидкости {fluid} смотрит вдоль стенки — трубу проведи сам")
                        continue
                    tile = inward[0]["approach_tile"]
                    if tile in occupied:
                        notes.append(f"тайл подхода {tile} занят — трубу к {fluid} проведи сам")
                        continue
                    inner.setdefault(((role, fluid), tile[0]), []).append(tile)
                    inward_pairs.add(((role, fluid), tile[0]))
                    continue
                tile = wanted[0]["approach_tile"]
                if tile in occupied:
                    notes.append(f"тайл подхода {tile} занят — трубу к {fluid} проведи сам")
                    continue
                key = (role, fluid)
                if key not in keys_by_side[side]:
                    keys_by_side[side].append(key)
                stubs.append((side, key, tile))
    # порты жидкости из зазоров между заводами пары (раскладка парами): труба к ним уже проложена, нужна цепочка
    for side, key, tile in extra_ports or []:
        if key not in keys_by_side[side]:
            keys_by_side[side].append(key)
        stubs.append((side, key, tile))
    # порядок стволов — как жидкости записаны в рецепте (его же берёт расчёт ширины)
    order = {("input", f): i for i, f in enumerate(recipe_inputs)}
    order.update({("output", f): 100 + i for i, f in enumerate(recipe_outputs)})
    for side_keys in keys_by_side.values():
        side_keys.sort(key=lambda key: order.get(key, 999))
        present = [k for k in (gap_keys or []) if k in side_keys]
        if present:                                   # жидкость из зазора идёт цепочкой, остальные — стволами
            for k in present:
                side_keys.remove(k)
            side_keys[0:0] = present
    # Первая жидкость стороны — цепочка вдоль стенки (общий механизм с портами внутрь блока), остальные — стволы.
    chain_key = {}
    for side, keys in keys_by_side.items():
        if not keys:
            continue
        rows = sorted({t[1] for sd, ky, t in stubs if sd == side and ky == keys[0]})
        if all(b - a - 1 <= reach for a, b in zip(rows, rows[1:])):
            chain_key[side] = keys[0]
    chained = []
    for item in stubs:
        side, key, tile = item
        if chain_key.get(side) == key:
            inner.setdefault((key, tile[0]), []).append(tile)
        else:
            chained.append(item)
    stubs = chained
    # Порты внутрь коридора: первая жидкость колонки — цепочка (ниже), остальные — стволы в середине коридора. Ширина
    # коридора (две полосы и по три тайла на ствол) заложена раскладкой: правая полоса стоит на 1 + 3·k правее левой.
    center_plan: list = []
    by_column: dict = {}
    for (key, column) in inward_pairs:
        by_column.setdefault(column, []).append(key)
    lanes = sorted(by_column)
    if center_trunks_ok and len(lanes) >= 2:
        lane_left, lane_right = lanes[0], lanes[-1]
        extra = sorted({key for keys in by_column.values() for key in keys}, key=lambda key: order.get(key, 999))[1:]
        for j, key in enumerate(extra):
            trunk_x = lane_left + 2 + 3 * j
            for column in (lane_left, lane_right):
                for tile in inner.pop((key, column), []):
                    center_plan.append((key, column == lane_left, tile, trunk_x))

    new_entities: list[dict] = []
    taken: set = set()
    rows_by_side: dict = {WEST: {}, EAST: {}}   # строка -> ключ: туннели одной стороны не пересекаются
    exits: dict = {}                              # (side, key) -> [строки y]
    plan: list = []
    for side, key, tile in stubs:
        k = keys_by_side[side].index(key) - (1 if side in chain_key else 0)   # цепочка (первая жидкость) ствола не имеет
        if side == WEST:
            exit_x = x0 - 2 - 2 * k
            trunk_x = exit_x - 1
        else:
            exit_x = x_end + 1 + 2 * k
            trunk_x = exit_x + 1
        distance = abs(exit_x - tile[0])
        if distance > reach:
            notes.append(f"труба к {key[1]}: туннель длиннее допустимого ({distance} > {reach}) — проведи сам")
            continue
        row = tile[1]
        other = rows_by_side[side].get(row)
        if other is not None and other != key:
            notes.append(f"труба к {key[1]}: на строке y={row} уже идёт туннель другой жидкости — проведи сам")
            continue
        rows_by_side[side][row] = key
        plan.append((side, key, tile, exit_x, trunk_x))
        exits.setdefault((side, key), []).append((trunk_x, row))

    for side, key, tile, exit_x, trunk_x in plan:
        row = tile[1]
        outward = side
        inward = (outward + 8) % 16
        stub_tile = tile
        exit_tile = (exit_x, row)
        if stub_tile in taken or exit_tile in taken or exit_tile in occupied:
            notes.append(f"труба к {key[1]}: место под подземную трубу занято — проведи сам")
            continue
        taken.update((stub_tile, exit_tile))
        # у порта: устье к заводу, туннель наружу; на краю: устье наружу, туннель к заводу
        new_entities.append(_entity(number, pipe_ground, stub_tile, inward))
        number += 1
        new_entities.append(_entity(number, pipe_ground, exit_tile, outward))
        number += 1

    center_trunks: dict = {}                       # ключ -> (x ствола, [строки])
    for key, from_left, tile, trunk_x in center_plan:
        exit_x = trunk_x - 1 if from_left else trunk_x + 1
        if abs(exit_x - tile[0]) > reach:
            notes.append(f"труба к {key[1]}: туннель длиннее допустимого — проведи сам")
            continue
        exit_tile = (exit_x, tile[1])
        if tile in taken or exit_tile in taken or exit_tile in occupied:
            notes.append(f"труба к {key[1]}: место под подземную трубу занято — проведи сам")
            continue
        taken.update((tile, exit_tile))
        away = EAST if from_left else WEST            # куда смотрит порт завода
        new_entities.append(_entity(number, pipe_ground, tile, (away + 8) % 16))
        number += 1
        new_entities.append(_entity(number, pipe_ground, exit_tile, away))
        number += 1
        center_trunks.setdefault(key, (trunk_x, []))[1].append(tile[1])
    shared = {tile for tile in occupied_by(entities, pipe, geometry)}   # ствол соседней группы — общий
    for key, (trunk_x, rows) in center_trunks.items():
        for y in range(min(rows), max(rows) + 1):
            tile = (trunk_x, y)
            if tile in shared and tile not in taken:
                continue
            if tile in occupied or tile in taken:
                notes.append(f"ствол трубы к {key[1]}: тайл {tile} занят — проведи сам")
                continue
            taken.add(tile)
            new_entities.append(_entity(number, pipe, tile))
            number += 1
    for (side, key), cells in exits.items():
        trunk_x = cells[0][0]
        ys = [y for _, y in cells]
        for y in range(min(ys), max(ys) + 1):
            tile = (trunk_x, y)
            if tile in shared and tile not in taken:
                continue
            if tile in occupied or tile in taken:
                notes.append(f"ствол трубы к {key[1]}: тайл {tile} занят — проведи сам")
                continue
            taken.add(tile)
            new_entities.append(_entity(number, pipe, tile))
            number += 1

    # Цепочки в коридорах столбцов — для портов, смотрящих внутрь блока.
    spans: dict = {}   # x коридора -> занятые участки [(верх, низ)] других цепочек
    for (key, column), tiles in sorted(inner.items(), key=lambda item: min(t[1] for t in item[1])):
        tiles = sorted(set(tiles), key=lambda t: t[1])
        span = (tiles[0][1], tiles[-1][1])
        if any(not (span[1] < a or span[0] > b) for a, b in spans.get(column, [])):
            # туннели двух жидкостей в одной линии сошлись бы друг с другом, а не со своими
            notes.append(f"труба к {key[1]}: в этом коридоре уже идёт цепочка другой жидкости — проведи сам")
            continue
        spans.setdefault(column, []).append(span)
        if any(t in taken for t in tiles):
            notes.append(f"труба к {key[1]}: тайл у порта уже занят другой трубой — проведи сам")
            continue
        for tile in tiles:
            taken.add(tile)
            new_entities.append(_entity(number, pipe, tile))
            number += 1
        for upper, lower in zip(tiles, tiles[1:]):
            between = lower[1] - upper[1] - 1
            if between <= 0:
                continue                      # трубы касаются друг друга
            cells = [(column, y) for y in range(upper[1] + 1, lower[1])]
            if all(c not in occupied and c not in taken for c in cells):
                # коридор между портами свободен (как в шаблоне, где труба идёт сплошной линией): обычные трубы
                for cell in cells:
                    taken.add(cell)
                    new_entities.append(_entity(number, pipe, cell))
                    number += 1
                continue
            if between == 1:
                if cells[0] in occupied or cells[0] in taken:
                    notes.append(f"труба к {key[1]}: между портами занят тайл {cells[0]} — соедини сам")
                    continue
                taken.add(cells[0])
                new_entities.append(_entity(number, pipe, cells[0]))
                number += 1
                continue
            first_cell, last_cell = cells[0], cells[-1]
            if between > reach or any(c in occupied or c in taken for c in (first_cell, last_cell)):
                # одной пары не хватает (порты далеко или у порта занято): обычные трубы по свободным тайлам и
                # короткие подземные пары только под занятыми
                laid = _lay_run(column, upper[1], lower[1], occupied, taken, reach)
                if laid is None:
                    notes.append(f"труба к {key[1]}: между портами нет места под подземную трубу — соедини сам")
                    continue
                for y, kind in laid:
                    taken.add((column, y))
                    if kind == "pipe":
                        new_entities.append(_entity(number, pipe, (column, y)))
                    else:
                        new_entities.append(_entity(number, pipe_ground, (column, y), 0 if kind == "in" else 8))
                    number += 1
                continue
            taken.update((first_cell, last_cell))
            # у верхнего порта: устье вверх (к трубе), туннель вниз; у нижнего — наоборот
            new_entities.append(_entity(number, pipe_ground, first_cell, 0))
            number += 1
            new_entities.append(_entity(number, pipe_ground, last_cell, 8))
            number += 1
    return new_entities, number, notes
