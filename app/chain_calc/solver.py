"""
Chain Calc solver.

Same idea as before (see README): a recipe run at `x` crafts/second delivers
    product_amount * (1 + productivity_bonus)   units/sec of each product
and consumes
    ingredient_amount                            units/sec of each ingredient
(productivity affects output only, never ingredient consumption - that's the
whole point of productivity modules in Factorio).

Two solving strategies:
  - solve_cascade: walk a recipe TREE top-down. Fast, exact, handles DAGs
    (shared child nodes) but not cycles.
  - solve_matrix: flatten a set of recipes into one linear system and solve
    it with linear programming (scipy.optimize.linprog / HiGHS). Handles
    cycles and "which of several recipes for this item is cheaper" cases
    that a pure cascade can't (e.g. oil-processing style loops, common in
    Pyanodon).
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional



class SolverError(Exception):
    pass


def _as_list(value) -> list:
    """Lua can't tell an empty array apart from an empty object, so the
    export-mod's JSON sometimes sends {} where we expect [] (a mining recipe
    with zero ingredients is the most common case). Normalize defensively."""
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return list(value.values())
    return []


def item_key(type_: str, name: str) -> str:
    return f"{type_}:{name}"


# ---------------------------------------------------------------------------
# Fluid temperatures
# ---------------------------------------------------------------------------
#
# A fluid isn't fully identified by its name. steam@165 and steam@500 are the
# same fluid but NOT interchangeable: a steam turbine wants steam >= 500, so
# feeding it 165-degree steam is simply wrong - the recipe won't run. Until now
# every fluid collapsed to `fluid:steam`, which quietly told the calculator that
# cold steam satisfies a turbine. It doesn't.
#
# So a fluid ingredient/product carries a temperature (or a min..max range), and
# the key encodes it:
#   fluid:steam@500       - exactly 500 (a product comes out at one temperature)
#   fluid:steam@500:2000  - the range 500..2000 (an ingredient accepts a band)
#   fluid:water           - no temperature constraint at all
#
# Matching a producer's output against a consumer's requirement is a range
# check (fluid_output_satisfies), NOT plain string equality.

def _num(value):
    return value if isinstance(value, (int, float)) else None


def _fmt_temp(t: float) -> str:
    return str(int(t)) if float(t).is_integer() else str(t)


# The exporter writes ±FLT_MAX (≈3.4028e38) where the GAME means "no limit":
# Pyanodon's fluids carry `maximum_temperature = FLT_MAX` when any temperature is
# accepted, and `minimum_temperature = -FLT_MAX` for "as cold as you like".
# Taken literally that produced keys like
#     fluid:hot-molten-salt@950:3.4028234663852894e+38
# and labels reading "Горячая расплавленная соль 950–3.4028234663852894e+38°".
# A limit that far out is not a limit, so it is normalised to an open end HERE,
# where the key is built. Two things fall out of that: the labels read "≥950°",
# and JS and Python now build the SAME string for the same fluid (they used to
# disagree - JS writes the short form "3.4028234663852894e+38", Python the long
# integer form - and only a numeric fallback in _match_child hid the divergence).
_UNBOUNDED = 1e38


def _sane_bound(value):
    """±FLT_MAX (and anything beyond) means 'open end', not a real temperature."""
    if value is None:
        return None
    if value >= _UNBOUNDED:
        return float("inf")
    if value <= -_UNBOUNDED:
        return float("-inf")
    return value


def fluid_temp_range(spec: dict):
    """(low, high) a fluid ingredient/product constrains itself to, or None.

    A product usually has a single `temperature`; an ingredient may have
    `minimum_temperature` / `maximum_temperature`. Missing end = open. The
    ±FLT_MAX "no limit" sentinel is normalised to an open end (see _sane_bound)."""
    exact = _sane_bound(_num(spec.get("temperature")))
    if exact is not None:
        return (exact, exact)
    low = _sane_bound(_num(spec.get("minimum_temperature")))
    high = _sane_bound(_num(spec.get("maximum_temperature")))
    if low is None and high is None:
        return None
    return (low if low is not None else float("-inf"), high if high is not None else float("inf"))


def fluid_key(name: str, spec: dict) -> str:
    """Temperature-aware key for a fluid ingredient/product."""
    rng = fluid_temp_range(spec)
    if rng is None:
        return f"fluid:{name}"
    low, high = rng
    if low == high:
        return f"fluid:{name}@{_fmt_temp(low)}"
    lo = "" if low == float("-inf") else _fmt_temp(low)
    hi = "" if high == float("inf") else _fmt_temp(high)
    return f"fluid:{name}@{lo}:{hi}"


def spec_key(spec: dict) -> str:
    """Key for any ingredient/product, temperature-aware for fluids."""
    type_ = spec.get("type", "item")
    if type_ == "fluid":
        return fluid_key(spec["name"], spec)
    return item_key(type_, spec["name"])


def parse_fluid_key(key: str):
    """('steam', low, high) for a fluid key, else None. Inverse of fluid_key."""
    if not key.startswith("fluid:"):
        return None
    body = key[len("fluid:"):]
    if "@" not in body:
        return (body, float("-inf"), float("inf"))
    name, temp = body.split("@", 1)
    if ":" in temp:
        lo, hi = temp.split(":", 1)
        return (name, float(lo) if lo else float("-inf"), float(hi) if hi else float("inf"))
    value = float(temp)
    return (name, value, value)


def fluid_output_satisfies(output_key: str, demand_key: str) -> bool:
    """Does a producer's output fluid meet a consumer's fluid requirement?

    True when it's the same fluid and the output temperature falls inside the
    demanded range. A production node emits at a single temperature, so its key
    is a point; the demand may be a band."""
    out = parse_fluid_key(output_key)
    dem = parse_fluid_key(demand_key)
    if not out or not dem:
        return output_key == demand_key
    if out[0] != dem[0]:
        return False
    return out[1] >= dem[1] and out[2] <= dem[2]


def effective_speed(machine: dict, effects: dict) -> float:
    speed_bonus = effects.get("speed", 0) or 0
    return (machine.get("crafting_speed") or 1) * max(0.2, 1 + speed_bonus)


def productivity_bonus(recipe: dict, effects: dict) -> float:
    """Productivity bonus actually in force for this recipe.

    Two guards the game itself applies and we used to skip:
      * a recipe that doesn't take productivity gets none (dump_version >= 2
        expresses this as maximum_productivity == 0 / missing);
      * a recipe with a maximum_productivity CAPS the bonus there (vanilla caps
        at +300%) - you can stuff a foundry full of prod-3s and beacons, and the
        game will still only give you the cap.
    """
    if not recipe.get("allow_productivity"):
        return 0.0
    bonus = max(0.0, effects.get("productivity", 0) or 0)
    cap = recipe.get("maximum_productivity")
    if isinstance(cap, (int, float)) and cap >= 0:
        bonus = min(bonus, float(cap))
    return bonus


def effective_consumption(effects: dict) -> float:
    """Energy-usage multiplier from modules/beacons. Factorio never lets a
    machine drop below 20% of its base draw, however many efficiency modules
    you cram into it - so neither do we (this also caps fuel burn and ash)."""
    return max(0.2, 1 + (effects.get("consumption", 0) or 0))


def machine_power(machine: dict, effects: dict, machines: float) -> float:
    """Active draw scaled by the consumption bonus, PLUS the machine's drain.

    Drain (the trickle an electric machine pulls even while idle) is not affected
    by efficiency modules and is easy to forget - but with thousands of machines
    in a Pyanodon build it's a serious chunk of the power bill.
    """
    active = (machine.get("energy_usage") or 0) * effective_consumption(effects)
    drain = machine.get("drain") or 0
    return (active + drain) * machines


def machine_base_effect(machine: dict) -> dict:
    """A machine can have bonuses with no modules in it at all - Space Age's
    Electromagnetic plant is +50% productivity out of the box. dump_version >= 2
    carries this as base_effect."""
    base = machine.get("base_effect")
    return base if isinstance(base, dict) else {}


def combined_effects(machine: dict, effects: dict) -> dict:
    """Node effects (modules + beacons, computed by the frontend) plus whatever
    the machine itself brings to the table."""
    base = machine_base_effect(machine)
    if not base:
        return effects or {}
    out = dict(effects or {})
    for key, value in base.items():
        if isinstance(value, (int, float)):
            out[key] = (out.get(key) or 0) + value
    return out


def crafts_per_second_per_machine(recipe: dict, machine: dict, effects: dict) -> float:
    energy = recipe.get("energy") or 0.5  # seconds/craft at speed 1
    speed = effective_speed(machine, effects)
    if energy <= 0:
        return 0.0
    return speed / energy


def per_craft_amounts(recipe: dict, effects: dict):
    """Returns (products, ingredients) dicts of {item_key: amount_per_craft}.

    Productivity multiplies the OUTPUT only, never the ingredient consumption -
    but not even all of the output: a product can carry `ignored_by_productivity`
    (the catalyst part). Kovarex hands back 41 U-235 for 40 in; productivity must
    only ever apply to the 1 that's actually new, otherwise a few prod modules
    "produce" uranium out of thin air. Same story for oil cracking and the many
    Pyanodon loops. dump_version >= 2 carries this per product.
    """
    bonus = productivity_bonus(recipe, effects)
    products: Dict[str, float] = {}
    ingredients: Dict[str, float] = {}
    for p in _as_list(recipe.get("products")):
        key = spec_key(p)  # fluid products carry their output temperature
        probability = p.get("probability", 1)
        if probability is None:
            probability = 1
        amount = p.get("amount")
        if amount is None:
            amount = ((p.get("amount_min") or 0) + (p.get("amount_max") or 0)) / 2
        # 2.0: a guaranteed fractional bonus on top of the integer amount
        amount = amount + (p.get("extra_count_fraction") or 0)
        amount = amount * probability

        catalyst = p.get("ignored_by_productivity")
        if catalyst is None:
            catalyst = p.get("catalyst_amount") or 0  # 1.1 dumps called it this
        catalyst = min(max(0.0, float(catalyst)), amount)

        productive_part = amount - catalyst
        products[key] = products.get(key, 0) + catalyst + productive_part * (1 + bonus)
    for i in _as_list(recipe.get("ingredients")):
        key = spec_key(i)  # fluid ingredients carry their accepted temperature band
        # Ingredients are read exactly like products: a ranged ingredient
        # (amount_min/amount_max - the exporter emits it, and omits `amount`
        # when the prototype is a range) used to raise KeyError here, which
        # surfaced as a bare HTTP 500. A probabilistic ingredient is consumed
        # only p of the time, so the expected consumption is amount * p.
        amount = i.get("amount")
        if amount is None:
            amount = ((i.get("amount_min") or 0) + (i.get("amount_max") or 0)) / 2
        probability = i.get("probability", 1)
        if probability is None:
            probability = 1
        ingredients[key] = ingredients.get(key, 0) + amount * probability
    return products, ingredients


def machines_needed(recipe: dict, machine: dict, effects: dict, crafts_per_second: float) -> float:
    per_machine = crafts_per_second_per_machine(recipe, machine, effects)
    if per_machine <= 0:
        return 0.0
    return crafts_per_second / per_machine


def _get_machine(dataset: dict, machine_name: Optional[str]) -> dict:
    entities = dataset.get("entities") or {}
    return entities.get(machine_name) or {"crafting_speed": 1, "name": machine_name}


def _get_recipe(dataset: dict, recipe_name: str) -> dict:
    recipe = (dataset.get("recipes") or {}).get(recipe_name)
    if recipe is None:
        raise SolverError(f"Неизвестный рецепт: {recipe_name}")
    return recipe


# ---------------------------------------------------------------------------
# CASCADE (tree) solver
# ---------------------------------------------------------------------------
#
# node = {
#   "id": str, "recipeName": str, "machineName": str,
#   "effects": {"speed": float, "productivity": float},
#   "primaryProduct": item_key,        # which output this node's rate is driven by
#   "children": {item_key: node}       # which recipe satisfies which ingredient
# }


def _self_loop_circulating(ingredient_rates: dict, product_rates: dict) -> dict:
    """How much of each thing a recipe both consumes and produces (the amount
    that loops in place). Formamide: methanol in 100, out 100 -> circulating 100.

    The RATES themselves stay gross (products/ingredients on the card still show
    the item on both sides - that is what the machine physically moves), but the
    EXTERNAL demand is netted: only what the loop does not cover lands in
    `rawInputs` (see the net_rate branch in _solve_cascade_node). Before that,
    Kovarex was reported as needing 0.976 U-235/sec piped in - a recipe that
    returns the very uranium it asks for.

    Keys carry fluid temperature, so steam@165 in / steam@500 out do NOT count:
    that's a heating step, not a loop.
    """
    circulating = {}
    for key in set(ingredient_rates) & set(product_rates):
        overlap = min(ingredient_rates[key], product_rates[key])
        if overlap > 1e-12:
            circulating[key] = overlap
    return circulating


def _solve_cascade_node(node: dict, dataset: dict, demand_rate: float, result: dict) -> dict:
    recipe = _get_recipe(dataset, node["recipeName"])
    machine = _get_machine(dataset, node.get("machineName"))
    # The node's effects are the modules + beacons the user set; the machine may
    # add a built-in bonus of its own (Electromagnetic plant, Foundry, ...).
    effects = combined_effects(machine, node.get("effects") or {})
    products, ingredients = per_craft_amounts(recipe, effects)

    # The frontend may hand us a primaryProduct without a temperature
    # (`fluid:steam`) while the recipe now keys it with one (`fluid:steam@500`).
    # Resolve it against the real product keys instead of demanding an exact
    # string match, so a temperature-agnostic request still finds its product.
    requested = node.get("primaryProduct")
    primary_key = _resolve_product_key(requested, products)
    product_amount = products.get(primary_key)
    if not product_amount or product_amount <= 0:
        raise SolverError(f"Рецепт {node['recipeName']} не производит {requested or primary_key}")

    crafts_per_second = demand_rate / product_amount
    machines = machines_needed(recipe, machine, effects, crafts_per_second)

    ingredient_rates = {k: v * crafts_per_second for k, v in ingredients.items()}
    product_rates = {k: v * crafts_per_second for k, v in products.items()}
    # A recipe can list the same thing as both an ingredient and a product -
    # Pyanodon's Formamide keeps 100 methanol on each side. It goes round in a
    # circle. The gross flows stay on the card (the user wants to see it as both
    # input and output, and wants it clickable), and we measure how much loops so
    # the card can add a "loop this much through a pipe" note. Only the external
    # demand is netted, further down.
    circulating = _self_loop_circulating(ingredient_rates, product_rates)

    node_result = {
        "id": node["id"],
        "recipeName": node["recipeName"],
        "machineName": node.get("machineName"),
        "craftsPerSecond": crafts_per_second,
        "machines": machines,
        "machinesCeil": math.ceil(machines - 1e-9),
        "products": product_rates,
        "ingredients": ingredient_rates,
        "circulating": circulating,  # {key: rate} that both enters and leaves - informational only
        "power": machine_power(machine, effects, machines),
        "appliedEffects": {
            "speed": effects.get("speed", 0) or 0,
            "productivity": productivity_bonus(recipe, effects),
            "consumption": effects.get("consumption", 0) or 0,
        },
    }
    result["nodes"][node["id"]] = node_result

    children = node.get("children") or {}
    for ing_key, ing_rate in node_result["ingredients"].items():
        child = _match_child(children, ing_key)
        if child:
            # The slot key is the PARENT's demand, so `_match_child` matches on
            # strings alone - verify against the child's own recipe that it can
            # actually deliver this ingredient (temperature included).
            check_child_supplies(dataset, child, ing_key)
            entry = result["demand"].setdefault(child["id"], {"node": child, "rate": 0.0})
            entry["rate"] += ing_rate
        else:
            # Only the NET amount has to come from outside: a recipe that also
            # PRODUCES what it consumes (Kovarex returns 40 of its 41 U-235,
            # coal liquefaction returns 25 of the heavy oil it burns) recycles
            # that part internally. Reporting the gross amount here told the user
            # to pipe in heavy oil to a recipe that is a net heavy-oil producer.
            # The gross flows stay on the card (products/ingredients) plus the
            # "circulating" note - it is only the EXTERNAL demand that is netted.
            #
            # Known remaining edge: a child node attached to a self-loop slot
            # still gets the GROSS rate, because a net of zero would zero out the
            # whole subtree under it. Left as-is on purpose; the circulating note
            # tells the user how much of that loop really turns around.
            net_rate = ing_rate - node_result["products"].get(ing_key, 0.0)
            if net_rate > 1e-12:
                result["rawInputs"][ing_key] = result["rawInputs"].get(ing_key, 0) + net_rate
    return node_result


def _resolve_product_key(requested, products: dict):
    """Find which product key the caller means. Exact match wins; otherwise, for
    a temperature-agnostic fluid request, accept the fluid of the same name."""
    if requested is None:
        return next(iter(products), None)
    if requested in products:
        return requested
    req = parse_fluid_key(requested)
    if req and req[1] == float("-inf") and req[2] == float("inf"):
        for key in products:
            parsed = parse_fluid_key(key)
            if parsed and parsed[0] == req[0]:
                return key
    return requested


def _match_child(children: dict, ing_key: str):
    """Pick the child node that supplies this ingredient.

    Exact key first (the common case). For fluids, also accept a child keyed by
    the same fluid whose output temperature satisfies the demanded band - the
    frontend may have attached the producer under `fluid:steam` or
    `fluid:steam@500` while the ingredient asks for `fluid:steam@500:2000`."""
    if ing_key in children:
        return children[ing_key]
    if ing_key.startswith("fluid:"):
        for child_key, child in children.items():
            if fluid_output_satisfies(child_key, ing_key):
                return child
            # child may be keyed by the ingredient side; compare its own product
            prod = child.get("primaryProduct")
            if prod and fluid_output_satisfies(prod, ing_key):
                return child
    return None


def _key_base(key: str):
    """("fluid"|"item", name) for any item/fluid key, temperature stripped."""
    parsed = parse_fluid_key(key)
    if parsed:
        return ("fluid", parsed[0])
    type_, _, name = key.partition(":")
    return (type_ or "item", name)


def _describe_temps(specs) -> str:
    """Human list of the temperatures a recipe emits a fluid at: "250°, ≥500°"."""
    labels = []
    for spec in specs:
        rng = fluid_temp_range(spec)
        if rng is None:
            labels.append("без указания температуры")
            continue
        labels.append(_temp_band_label(rng[0], rng[1]))
    return " / ".join(dict.fromkeys(labels))


def _display_name(dataset: dict, type_: str, name: str) -> str:
    """Display name from the dump when it has one, else the internal name.

    These messages end up in the UI verbatim, and "steam >= 500" reads a lot worse
    than "Пар ≥500°" when the dump has Russian names.
    """
    table = (dataset or {}).get("fluids" if type_ == "fluid" else "items") or {}
    entry = table.get(name) if isinstance(table, dict) else None
    if isinstance(entry, dict) and entry.get("display_name"):
        return str(entry["display_name"])
    return name


def _recipe_label(dataset: dict, name: str) -> str:
    """Localised recipe name when the dump has one, else the internal id."""
    entry = ((dataset or {}).get("recipes") or {}).get(name)
    if isinstance(entry, dict) and entry.get("display_name"):
        return f"«{entry['display_name']}» ({name})"
    return name


def _temp_band_label(low, high) -> str:
    low, high = _sane_bound(low), _sane_bound(high)
    if low == float("-inf") and high == float("inf"):
        return "любой температуры"
    if low == high:
        return f"{_fmt_temp(low)}°"
    if low == float("-inf"):
        return f"≤{_fmt_temp(high)}°"
    if high == float("inf"):
        return f"≥{_fmt_temp(low)}°"
    return f"{_fmt_temp(low)}–{_fmt_temp(high)}°"


def check_child_supplies(dataset: dict, child: dict, demand_key: str) -> None:
    """Refuse a child node that cannot actually feed this ingredient slot.

    The frontend keys a child slot by the PARENT's ingredient key, so the exact
    match in `_match_child` fires no matter what the child really outputs - a
    250-degree boiler would happily "satisfy" a recipe that needs steam >= 500,
    and the whole chain would be reported as a working plan. The temperature
    check therefore has to look at the child's own recipe, not at the slot key.

    Also guarded here: the child's rate is read as "units of its PRIMARY product
    per second", so a child whose primary product is some other item would be
    sized against the wrong number entirely.

    Raises SolverError with an actionable message instead of returning numbers.
    """
    child_recipe = _get_recipe(dataset, child["recipeName"])
    want_type, want_name = _key_base(demand_key)
    want_label = _display_name(dataset, want_type, want_name)

    matching = [
        p
        for p in _as_list(child_recipe.get("products"))
        if (p.get("type") or "item") == want_type and p.get("name") == want_name
    ]
    if not matching:
        raise SolverError(
            f"Рецепт {_recipe_label(dataset, child_recipe['name'])} не производит {want_label}, "
            f"а он поставлен в цепочке как её источник."
        )

    primary = child.get("primaryProduct")
    if primary:
        prim_type, prim_name = _key_base(primary)
        if prim_name != want_name or prim_type != want_type:
            raise SolverError(
                f"Узел {_recipe_label(dataset, child_recipe['name'])} считает расход по своему продукту "
                f"«{_display_name(dataset, prim_type, prim_name)}», а в цепочке он кормит слот "
                f"«{want_label}» — числа были бы посчитаны по чужому продукту. "
                f"Пересоберите этот участок цепочки."
            )

    demand = parse_fluid_key(demand_key)
    if not demand:
        return  # items have no temperature to disagree about

    # A product emits at ONE temperature; the demand may accept a band. Check the
    # child's own primary product if we can pin it down, otherwise accept any of
    # its products that satisfies the band.
    if primary:
        pinned = [p for p in matching if spec_key(p) == primary]
        pool = pinned or matching
    else:
        pool = matching
    if any(fluid_output_satisfies(spec_key(p), demand_key) for p in pool):
        return

    _, low, high = demand
    raise SolverError(
        f"Температура не сходится: рецепт {_recipe_label(dataset, child_recipe['name'])} выдаёт "
        f"{want_label} ({_describe_temps(matching)}), а этому слоту нужен {want_label} "
        f"{_temp_band_label(low, high)}. Такой рецепт в игре просто не запустится — "
        f"выберите другой источник {want_label} или другой маршрут."
    )


def check_unique_node_ids(root_node: dict) -> None:
    """Refuse a tree that uses the same node id twice.

    Everything the solver reports is keyed by node id (`result["nodes"][node["id"]]`),
    so a repeated id silently OVERWRITES one stage with another: the first node's
    numbers vanish, the second one's card is rendered with the first one's machine
    and modules (the UI looks the tree node up by id), and the raw inputs of the
    lost node are missing from the totals. A chain built by the UI always gets
    fresh ids, but a hand-authored or hand-edited one (POST /api/chains, or a
    DAG that reuses one producer node in two slots) can hit this - and a clear
    error beats a quiet lie.

    The same walk also protects against a node referring to itself, which would
    otherwise show up as a huge, meaningless "chain".
    """
    seen = set()
    stack = [root_node]
    while stack:
        node = stack.pop()
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        if node_id in seen:
            raise SolverError(
                f"В цепочке повторяется идентификатор узла «{node_id}» — карточки этапов "
                f"перезапишут друг друга. Пересоберите или пересохраните цепочку."
            )
        seen.add(node_id)
        for child in (node.get("children") or {}).values():
            stack.append(child)


def solve_cascade(root_node: dict, root_target_rate: float, dataset: dict) -> dict:
    check_unique_node_ids(root_node)
    result: Dict[str, Any] = {"nodes": {}, "rawInputs": {}, "demand": {}}
    result["demand"][root_node["id"]] = {"node": root_node, "rate": root_target_rate}

    solved = set()
    guard = 0
    while True:
        pending = [d for nid, d in result["demand"].items() if nid not in solved]
        if not pending:
            break
        guard += 1
        if guard > 10000:
            raise SolverError(
                "Цепочка слишком большая, либо в ней цикл — проверьте дерево (блочный решатель "
                "в интерфейсе сейчас недоступен)."
            )
        for d in pending:
            solved.add(d["node"]["id"])
        for d in pending:
            _solve_cascade_node(d["node"], dataset, d["rate"], result)
    del result["demand"]
    return result


# ---------------------------------------------------------------------------
# MATRIX (linear programming) solver
# ---------------------------------------------------------------------------
#
# rows: [{ "id": str, "recipeName": str, "machineName": str, "effects": {...} }]
# objectives: { item_key: desired_rate }


def solve_matrix(rows: List[dict], objectives: Dict[str, float], dataset: dict) -> dict:
    if not rows:
        raise SolverError("Блок пуст — добавьте хотя бы один рецепт.")

    # Same trap as the cascade: rows are reported by id, so a repeated id would
    # overwrite one row's card with another's.
    row_ids = [r.get("id") for r in rows]
    duplicated = {i for i in row_ids if row_ids.count(i) > 1}
    if duplicated:
        raise SolverError(f"В блоке повторяются идентификаторы строк: {', '.join(sorted(map(str, duplicated)))}.")

    # A negative objective means "I want −5/sec of this", which is not a thing -
    # and it used to corrupt the surplus accounting (the missing input was then
    # reported as a surplus). Refuse instead of guessing.
    negative = sorted(k for k, v in objectives.items() if v < 0)
    if negative:
        raise SolverError(f"Цель не может быть отрицательной: {', '.join(negative)}.")

    row_data = []
    for r in rows:
        recipe = _get_recipe(dataset, r["recipeName"])
        machine = _get_machine(dataset, r.get("machineName"))
        effects = combined_effects(machine, r.get("effects") or {})
        products, ingredients = per_craft_amounts(recipe, effects)
        net: Dict[str, float] = {}
        for k, v in products.items():
            net[k] = net.get(k, 0) + v
        for k, v in ingredients.items():
            net[k] = net.get(k, 0) - v
        row_data.append(
            {"row": r, "recipe": recipe, "machine": machine, "effects": effects,
             "products": products, "ingredients": ingredients, "net": net}
        )

    produced_keys = set()
    for rd in row_data:
        produced_keys.update(rd["products"].keys())

    all_keys = set()
    for rd in row_data:
        all_keys.update(rd["products"].keys())
        all_keys.update(rd["ingredients"].keys())
    all_keys.update(objectives.keys())

    n = len(row_data)

    # An objective for something no row makes is silently dropped by the loop below
    # (there is nothing to constrain), and the LP then answers "success" with every
    # craft at zero and no raw inputs - a confident empty result. Say so instead.
    unproducible = sorted(k for k, v in objectives.items() if v > 0 and k not in produced_keys)
    if unproducible:
        raise SolverError(
            "В блоке нет рецепта, который производит: "
            + ", ".join(unproducible)
            + ". Добавьте нужный рецепт в блок."
        )

    # A_ub @ x <= b_ub  encodes  net·x >= objective  as  -net·x <= -objective
    a_ub: List[List[float]] = []
    b_ub: List[float] = []
    constrained_keys: List[str] = []
    for key in sorted(all_keys):
        if key not in produced_keys:
            continue  # raw input from outside the block - unconstrained
        row_coeffs = [rd["net"].get(key, 0.0) for rd in row_data]
        rhs = objectives.get(key, 0.0)
        a_ub.append([-c for c in row_coeffs])
        b_ub.append(-rhs)
        constrained_keys.append(key)

    # Cost = how many items a craft consumes in total. Minimizing the number of
    # CRAFTS (the old choice) is not a proxy for "cheaper": between 10 A -> 1 X and
    # 200 A -> 10 X, asking for 10 X/s picks the second one and burns 200 A/s where
    # the first needs 100. Total consumed items is the honest "resource-hungrier"
    # measure for a block that has no notion of what is raw and what is cheap.
    cost = [sum(rd["ingredients"].values()) or 1.0 for rd in row_data]

    # scipy is imported here, not at the top: it takes ~0.8 s and only the matrix solver needs it,
    # so the server (and every other page) starts that much faster
    from scipy.optimize import linprog

    lp = linprog(cost, A_ub=a_ub or None, b_ub=b_ub or None, bounds=(0, None), method="highs")

    if not lp.success:
        if lp.status == 2:
            raise SolverError(
                "Не удалось удовлетворить цель — проверьте, что все нужные рецепты добавлены в блок."
            )
        raise SolverError(f"Решатель не справился: {lp.message}")

    x = lp.x
    result: Dict[str, Any] = {"nodes": {}, "rawInputs": {}}
    net_totals: Dict[str, float] = {}
    for idx, rd in enumerate(row_data):
        crafts_per_second = float(x[idx])
        machines = machines_needed(rd["recipe"], rd["machine"], rd["effects"], crafts_per_second)
        machines_ceil = math.ceil(machines - 1e-9)
        result["nodes"][rd["row"]["id"]] = {
            "id": rd["row"]["id"],
            "recipeName": rd["row"]["recipeName"],
            "machineName": rd["row"].get("machineName"),
            "craftsPerSecond": crafts_per_second,
            "machines": machines,
            "machinesCeil": machines_ceil,
            "products": {k: v * crafts_per_second for k, v in rd["products"].items()},
            "ingredients": {k: v * crafts_per_second for k, v in rd["ingredients"].items()},
            "power": machine_power(rd["machine"], rd["effects"], machines),
        }
        for k, v in rd["net"].items():
            net_totals[k] = net_totals.get(k, 0) + v * crafts_per_second

    for key in all_keys:
        if key not in produced_keys:
            total = 0.0
            for rd in row_data:
                if key in rd["ingredients"]:
                    total += rd["ingredients"][key] * result["nodes"][rd["row"]["id"]]["craftsPerSecond"]
            if total > 1e-9:
                result["rawInputs"][key] = total
        else:
            surplus = net_totals.get(key, 0) - objectives.get(key, 0)
            if surplus > 1e-6:
                result["rawInputs"][key] = -surplus  # negative marks "surplus"

    return result
