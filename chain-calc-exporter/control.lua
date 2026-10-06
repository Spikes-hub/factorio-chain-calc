-- Chain Calc Exporter  (dump_version = 2)
-- Console command: /dump-factorio-data
--
-- Writes script-output/chain-calc-dump.json with everything the calculator
-- needs, WITH real localised names in your game's language (resolved through
-- Factorio's translation API, same mechanism FNEI / Recipe Book use).
--
-- What's new in dump_version 2 (vs 1):
--   items    : prototype_type ("module"/"item"/...), module_category, tier,
--              module_effects, weight, place_result
--   entities : is_machine, module_slots, allowed_effects,
--              allowed_module_categories, base_effect (Electromagnetic plant's
--              built-in +50% productivity!), drain (idle power draw),
--              belt_speed (transport belts), beacon fields, pump speed
--   recipes  : maximum_productivity, allowed_module_categories,
--              emissions_multiplier, is_recycling, parameter,
--              products[].ignored_by_productivity (catalysts!),
--              products[].extra_count_fraction
--   top-level: dump_version, mods (name -> version)
--
-- v2 -> v3: в entities попадают погрузчики (loader-1x1/loader) — у них та же
--          скорость belt_speed (предметов/сек), что у лент.
-- v3 -> v4: у манипуляторов появляется inserter_hand_size — ПАЧКА (предметов за
--          один заход) с учётом врождённого бонуса прототипа И исследований этого
--          сохранения, плюс top-level inserter_bonus {stack, bulk} с самими
--          бонусами силы. До этого у всех стоял 0 (в 2.0 у прототипа нет поля
--          inserter_stack_size_bonus), и массовые манипуляторы считались как
--          обычные — без пачки.
-- v4 -> v5: у построек появляется tile_width/tile_height — ТОЧНЫЙ размер в
--          тайлах. Это рантайм-свойство: в выгрузке data.raw (factorio.exe
--          --dump-data) его нет, поэтому размер «нестандартных» построек
--          (например Py-генератор: collision_box даёт 3x3, а габарит 4x4)
--          приходилось выводить из collision_box и он мог отличаться на тайл.
--          Здесь же добавлены сами collision_box и selection_box в рантайме —
--          чтобы было с чем сверить.
--
-- Everything is wrapped in try() because the same file must survive on 1.1
-- (old game.*_prototypes API) and 2.0+ (prototypes.*), and reading a field
-- that doesn't exist on a userdata prototype throws instead of returning nil.

local DUMP_VERSION = 5

local function get_helpers()
  -- Factorio 2.0 moved table_to_json/write_file from `game` to `helpers`.
  return helpers or game
end

local function get_prototype_tables()
  if prototypes then
    return {
      items = prototypes.item,
      fluids = prototypes.fluid,
      recipes = prototypes.recipe,
      entities = prototypes.entity,
    }
  else
    return {
      items = game.item_prototypes,
      fluids = game.fluid_prototypes,
      recipes = game.recipe_prototypes,
      entities = game.entity_prototypes,
    }
  end
end

local function try(fn)
  local ok, value = pcall(fn)
  if ok then return value end
  return nil
end
-- A dict-like {speed = true, productivity = true} becomes a plain list, which

-- Simple in-game status GUI helpers: show a centered mini-window to players
local function show_status_to_player(player, text)
  if not (player and player.valid and player.gui and player.gui.screen) then return end
  if player.gui.screen.chain_calc_status then player.gui.screen.chain_calc_status.destroy() end
  local frame = player.gui.screen.add{type = "frame", name = "chain_calc_status", direction = "vertical"}
  frame.style.minimal_width = 360
  frame.add{type = "label", caption = text}
  local flow = frame.add{type = "flow", direction = "horizontal"}
  flow.add{type = "button", name = "chain_calc_status_close", caption = "Close"}
  if frame.force_auto_center then frame.force_auto_center() end
end

local function show_status_all(text)
  for _, player in pairs(game.players) do
    if player and player.valid then show_status_to_player(player, text) end
  end
end

-- A dict-like {speed = true, productivity = true} becomes a plain list, which
-- is what the frontend expects (and Lua can't tell {} apart from [] in JSON,
-- so the frontend normalizes empties anyway).
local function keys_to_list(dict)
  if not dict then return nil end
  local out = {}
  for key, value in pairs(dict) do
    if value == true or value == nil then
      table.insert(out, key)
    elseif type(value) == "string" then
      table.insert(out, value)
    end
  end
  if #out == 0 then return nil end
  return out
end

-- ModuleEffects changed shape between versions: 1.1 gives {speed = {bonus = 0.2}},
-- 2.0 gives {speed = 0.2}. Normalize to plain numbers, and skip zeroes so the
-- JSON stays small.
local function normalize_effects(effects)
  if not effects then return nil end
  local out = {}
  local any = false
  for _, key in ipairs({"speed", "productivity", "consumption", "pollution", "quality"}) do
    local raw = effects[key]
    local value = nil
    if type(raw) == "number" then
      value = raw
    elseif type(raw) == "table" then
      value = raw.bonus
    end
    if type(value) == "number" and value ~= 0 then
      out[key] = value
      any = true
    end
  end
  if not any then return nil end
  return out
end

-- Watts. The runtime API reports power in Joules/TICK (60 ticks = 1 second),
-- while every formula downstream assumes Watts (Joules/second).
local function to_watts(joules_per_tick)
  if type(joules_per_tick) ~= "number" then return nil end
  return joules_per_tick * 60
end

local function dump_ingredient_list(list)
  local out = {}
  if not list then return out end
  for _, ing in pairs(list) do
    table.insert(out, {
      name = ing.name,
      type = ing.type or "item",
      amount = ing.amount,
      amount_min = ing.amount_min,
      amount_max = ing.amount_max,
      probability = ing.probability,
      -- 2.0: the part of a product's amount that productivity must NOT multiply
      -- (catalysts: Kovarex' 40 U-235 in, 41 out; oil cracking; Py loops).
      -- Getting this wrong makes every productivity number on such a recipe a lie.
      ignored_by_productivity = try(function() return ing.ignored_by_productivity end),
      ignored_by_stats = try(function() return ing.ignored_by_stats end),
      extra_count_fraction = try(function() return ing.extra_count_fraction end),
      catalyst_amount = try(function() return ing.catalyst_amount end), -- 1.1 only
      temperature = ing.temperature,
      minimum_temperature = ing.minimum_temperature,
      maximum_temperature = ing.maximum_temperature,
    })
  end
  return out
end

-- Entity types that can actually run a recipe / produce something on a cycle.
local CRAFTER_TYPES = {
  ["assembling-machine"] = true,
  ["furnace"] = true,
  ["rocket-silo"] = true,
  ["mining-drill"] = true,
  ["lab"] = true,
  ["boiler"] = true,
  ["generator"] = true,
  ["reactor"] = true,
  ["burner-generator"] = true,
  ["fusion-reactor"] = true,
  ["fusion-generator"] = true,
  ["offshore-pump"] = true,
}

-- Types we don't craft with, but whose numbers the calculator wants anyway:
-- belts feed the belt-load planner, beacons feed module effects, pumps/inserters
-- are the "how do I actually move this" side of a build.
local SUPPORT_TYPES = {
  ["transport-belt"] = true,
  ["beacon"] = true,
  ["inserter"] = true,
  ["pump"] = true,
  -- Погрузчики (base "loader-1x1", старые моды зовут его "loader"): в
  -- калькуляторе это выбор «чем грузить станок» рядом с манипуляторами. Без них
  -- список строится по тирам лент (скорость погрузчика = скорость его ленты),
  -- а с ними скорость и иконка берутся прямо из прототипа.
  ["loader-1x1"] = true,
  ["loader"] = true,
}

local function machine_speed(prototype)
  local speed = try(function() return prototype.crafting_speed end)
  if speed then return speed end
  speed = try(function() return prototype.get_crafting_speed() end)
  if speed then return speed end
  speed = try(function() return prototype.mining_speed end)
  if speed then return speed end
  speed = try(function() return prototype.get_researching_speed() end)
  if speed then return speed end
  speed = try(function() return prototype.researching_speed end)
  if speed then return speed end
  return 1
end

local function energy_usage_watts(prototype)
  local usage = try(function() return prototype.energy_usage end)
  if usage == nil then usage = try(function() return prototype.get_max_energy_usage() end) end
  if usage == nil then usage = try(function() return prototype.max_energy_usage end) end
  return to_watts(usage) or 0
end

-- ---------------------------------------------------------------------------
-- Build the raw dump (internal names only) + collect what needs translating.
-- ---------------------------------------------------------------------------
local function build_raw_dump()
  local data = {
    dump_version = DUMP_VERSION,
    mods = try(function() return script.active_mods end),
    items = {}, fluids = {}, recipes = {}, entities = {},
  }
  local translation_requests = {}
  local proto = get_prototype_tables()

  -- Which recipes are researched in THIS save right now (nil if we can't tell -
  -- the frontend then just doesn't filter by it).
  local local_force = nil
  for _, player in pairs(game.players) do
    if player.valid and player.character then local_force = player.force break end
  end
  if not local_force then
    for _, player in pairs(game.players) do
      if player.valid then local_force = player.force break end
    end
  end

  -- Бонусы исследований, которые виляют на ПАЧКУ манипуляторов (сколько предметов
  -- за один заход). Они живут не в прототипе, а в силе (LuaForce), то есть зависят
  -- от этого сохранения: «Inserter capacity bonus» даёт inserter_stack_size_bonus
  -- обычным манипуляторам, а bulk_inserter_capacity_bonus — массовым. Калькулятор
  -- берёт отсюда пачку, поэтому её видно и в рекомендации, и в подсчёте.
  data.inserter_bonus = {
    stack = try(function() return local_force.inserter_stack_size_bonus end) or 0,
    bulk = try(function() return local_force.bulk_inserter_capacity_bonus end) or 0,
  }

  -- ---------------- items ----------------
  for name, prototype in pairs(proto.items) do
    local prototype_type = try(function() return prototype.type end)
    local entry = {
      name = name,
      type = "item", -- keep: this is the item:/fluid: KEY namespace, not the prototype type
      prototype_type = prototype_type, -- "module", "item", "ammo", "capsule", ...
      group = try(function() return prototype.group and prototype.group.name end),
      subgroup = try(function() return prototype.subgroup and prototype.subgroup.name end),
      stack_size = try(function() return prototype.stack_size end),
      weight = try(function() return prototype.weight end),
      -- what this item builds, if anything ("iron-chest" -> container entity).
      -- Lets the calculator tell a machine/belt/inserter item from a consumable.
      place_result = try(function() return prototype.place_result and prototype.place_result.name end),
      place_result_type = try(function() return prototype.place_result and prototype.place_result.type end),
      fuel_value = try(function() return prototype.fuel_value end),
      fuel_category = try(function() return prototype.fuel_category end),
      burnt_result = try(function() return prototype.burnt_result and prototype.burnt_result.name end),
    }

    -- Modules: the whole point of dumping the prototype type. `category` here is
    -- the module category ("speed"/"productivity"/"efficiency"/"quality" or a
    -- modded one), which is what the calculator groups its module picker by.
    if prototype_type == "module" then
      entry.module_category = try(function() return prototype.category end)
      entry.tier = try(function() return prototype.tier end)
      entry.module_effects = normalize_effects(try(function() return prototype.module_effects end))
    end

    data.items[name] = entry
    table.insert(translation_requests, { key = "item:" .. name, localised_name = prototype.localised_name, target = entry })
  end

  -- ---------------- fluids ----------------
  for name, prototype in pairs(proto.fluids) do
    local entry = {
      name = name, type = "fluid",
      default_temperature = try(function() return prototype.default_temperature end),
      max_temperature = try(function() return prototype.max_temperature end),
      heat_capacity = try(function() return prototype.heat_capacity end),
      -- Fluids can be FUEL too (Joules per unit): Pyanodon's drills and many of
      -- its machines burn gas instead of coal. Without this the calculator can't
      -- see that a machine eats fuel at all.
      fuel_value = try(function() return prototype.fuel_value end),
      emissions_multiplier = try(function() return prototype.emissions_multiplier end),
      gas_temperature = try(function() return prototype.gas_temperature end),
      group = try(function() return prototype.group and prototype.group.name end),
      subgroup = try(function() return prototype.subgroup and prototype.subgroup.name end),
    }
    data.fluids[name] = entry
    table.insert(translation_requests, { key = "fluid:" .. name, localised_name = prototype.localised_name, target = entry })
  end

  -- ---------------- recipes ----------------
  for name, prototype in pairs(proto.recipes) do
    -- 2.0 removed LuaRecipePrototype::allow_productivity: whether productivity
    -- applies is now expressed as maximum_productivity (nil/0 = not allowed).
    local max_prod = try(function() return prototype.maximum_productivity end)
    local allow_productivity = try(function() return prototype.allow_productivity end)
    if allow_productivity == nil then
      allow_productivity = max_prod ~= nil and max_prod > 0
    end

    local category = try(function() return prototype.category end)
    if category == nil then
      local categories = try(function() return prototype.categories end)
      if categories then
        for cat, _ in pairs(categories) do category = cat break end
      end
    end

    local entry = {
      name = name,
      category = category or "crafting",
      subgroup = try(function() return prototype.subgroup and prototype.subgroup.name end),
      energy = try(function() return prototype.energy end) or 0.5,
      hidden = try(function() return prototype.hidden end),
      enabled = try(function() return prototype.enabled end),
      -- 2.0 parameter prototypes are UI placeholders, not real recipes - they
      -- must never show up in a chain.
      parameter = try(function() return prototype.parameter end),
      -- Space Age auto-generates a recycling recipe for nearly every item. They
      -- flood pathfinding with useless "just recycle it" routes, so flag them.
      is_recycling = (category == "recycling") or nil,
      allow_productivity = allow_productivity,
      maximum_productivity = max_prod,
      -- 2.0: some recipes only accept certain module categories.
      allowed_module_categories = keys_to_list(try(function() return prototype.allowed_module_categories end)),
      emissions_multiplier = try(function() return prototype.emissions_multiplier end),
      surface_conditions = try(function() return prototype.surface_conditions end),
      ingredients = dump_ingredient_list(prototype.ingredients),
      products = dump_ingredient_list(prototype.products),
      unlocked_now = try(function()
        return local_force and local_force.recipes[name] and local_force.recipes[name].enabled
      end),
    }
    data.recipes[name] = entry
    table.insert(translation_requests, { key = "recipe:" .. name, localised_name = { "recipe-name." .. name }, target = entry })
  end

  -- ---------------- entities ----------------
  for name, prototype in pairs(proto.entities) do
    local ptype = prototype.type
    local is_machine = CRAFTER_TYPES[ptype] or false
    if is_machine or SUPPORT_TYPES[ptype] then
      local entry = { name = name, type = ptype, is_machine = is_machine or nil }

      -- v5: точные габариты в тайлах. tile_width/tile_height есть только в
      -- рантайме — именно по ним игра решает, какие тайлы занимает постройка,
      -- поэтому для генератора блюпринтов это главное число.
      entry.tile_width = try(function() return prototype.tile_width end)
      entry.tile_height = try(function() return prototype.tile_height end)
      local collision = try(function() return prototype.collision_box end)
      if collision then
        entry.collision_box = {
          { collision.left_top.x, collision.left_top.y },
          { collision.right_bottom.x, collision.right_bottom.y },
        }
      end
      local selection = try(function() return prototype.selection_box end)
      if selection then
        entry.selection_box = {
          { selection.left_top.x, selection.left_top.y },
          { selection.right_bottom.x, selection.right_bottom.y },
        }
      end

      if is_machine then
        local categories = {}
        local crafting_categories = try(function() return prototype.crafting_categories end)
        if crafting_categories then
          for cat, _ in pairs(crafting_categories) do table.insert(categories, cat) end
        end
        local resource_categories = try(function() return prototype.resource_categories end)
        if resource_categories then
          for cat, _ in pairs(resource_categories) do table.insert(categories, cat) end
        end
        entry.crafting_categories = categories
        entry.crafting_speed = machine_speed(prototype)
      end

      -- Burner machines need fuel delivered by belt on top of the recipe's own
      -- ingredients. We look straight at fuel_categories rather than trusting an
      -- "is it electric" guess, which is unreliable for modded machines.
      local fuel_categories = {}
      local burner = try(function() return prototype.burner_prototype end)
      local fc = burner and try(function() return burner.fuel_categories end)
      if not fc then fc = try(function() return prototype.fuel_categories end) end
      if fc then
        for cat, _ in pairs(fc) do table.insert(fuel_categories, cat) end
      end
      entry.fuel_categories = fuel_categories

      local electric = try(function() return prototype.electric_energy_source_prototype end)
      local energy_source_type = "other"
      if electric then
        energy_source_type = "electric"
      elseif burner ~= nil or #fuel_categories > 0 then
        energy_source_type = "burner"
      elseif try(function() return prototype.fluid_energy_source_prototype end) then
        energy_source_type = "fluid_fuel"
      elseif try(function() return prototype.heat_energy_source_prototype end) then
        energy_source_type = "heat"
      end
      entry.energy_source_type = energy_source_type
      entry.energy_usage = energy_usage_watts(prototype)

      -- Fluid-burning machines (Py drills run on gas). We need: which fluid is
      -- allowed (a filtered fluidbox pins it to exactly one), how efficiently the
      -- machine converts it, and whether it burns the fluid for its fuel_value or
      -- just uses it as a heat carrier (steam-engine style).
      local fluid_source = try(function() return prototype.fluid_energy_source_prototype end)
      if fluid_source then
        entry.fluid_fuel = {
          burns_fluid = try(function() return fluid_source.burns_fluid end),
          effectivity = try(function() return fluid_source.effectivity end) or 1,
          fluid_usage_per_tick = try(function() return fluid_source.fluid_usage_per_tick end),
          scale_fluid_usage = try(function() return fluid_source.scale_fluid_usage end),
          maximum_temperature = try(function() return fluid_source.maximum_temperature end),
          -- a filtered input fluidbox means "this machine takes THIS fluid only"
          filter = try(function()
            for _, box in ipairs(prototype.fluidbox_prototypes) do
              if box.filter and box.production_type ~= "output" then
                return box.filter.name
              end
            end
            return nil
          end),
        }
      end
      -- Idle draw: a machine burns this even while doing nothing. Leaving it out
      -- silently under-reports every power figure in the calculator.
      entry.drain = to_watts(electric and try(function() return electric.drain end)) or nil

      -- Modules the machine can take, and which effects it refuses (many modded
      -- machines forbid productivity; beacons forbid it too).
      entry.module_slots = try(function() return prototype.module_inventory_size end)
        or try(function() return prototype.module_slots end)
      entry.allowed_effects = keys_to_list(try(function() return prototype.allowed_effects end))
      entry.allowed_module_categories = keys_to_list(try(function() return prototype.allowed_module_categories end))
      -- Built-in bonus the machine has with NO modules at all: Space Age's
      -- Electromagnetic plant is +50% productivity out of the box, the Foundry
      -- and Biochamber likewise. Ignoring this makes every SA number wrong.
      entry.base_effect = normalize_effects(try(function()
        return prototype.effect_receiver and prototype.effect_receiver.base_effect
      end))

      -- pollution per second at full load
      local emissions_per_joule = try(function()
        local source = electric or burner
          or try(function() return prototype.heat_energy_source_prototype end)
          or try(function() return prototype.fluid_energy_source_prototype end)
        return source and source.emissions_per_joule and source.emissions_per_joule["pollution"]
      end)
      if emissions_per_joule then
        entry.pollution = emissions_per_joule * entry.energy_usage
      else
        entry.pollution = try(function()
          return prototype.emissions_per_second and prototype.emissions_per_second["pollution"]
        end)
      end

      if ptype == "transport-belt" then
        -- belt_speed is tiles/tick; 8 items per tile per lane, 2 lanes, 60 ticks.
        local belt_speed = try(function() return prototype.belt_speed end)
        entry.belt_speed = belt_speed and (belt_speed * 8 * 60) or nil -- items/sec, both lanes
      elseif ptype == "loader-1x1" or ptype == "loader" then
        -- Погрузчик меряет скорость так же, как лента (тайл/тик), и его скорость
        -- всегда равна скорости ленты его тира, поэтому переводим тем же
        -- множителем: 8 предметов × 2 стороны × 60 тиков.
        local loader_speed = try(function() return prototype.speed end)
        entry.belt_speed = loader_speed and (loader_speed * 8 * 60) or nil -- items/sec
        entry.loader = true
      elseif ptype == "beacon" then
        entry.distribution_effectivity = try(function() return prototype.distribution_effectivity end)
        entry.supply_area_distance = try(function() return prototype.get_supply_area_distance() end)
          or try(function() return prototype.supply_area_distance end)
        -- 2.0 beacon "profile": the per-beacon effect depends on HOW MANY beacons
        -- reach the machine (index = beacon count).
        entry.profile = try(function()
          local p = prototype.profile
          return p and next(p) and p or nil
        end)
      elseif ptype == "inserter" then
        entry.inserter_rotation_speed = try(function() return prototype.get_inserter_rotation_speed() end)
          or try(function() return prototype.inserter_rotation_speed end)
        -- ПАЧКА (сколько предметов манипулятор берёт за один заход) = 1 + бонус
        -- прототипа + бонус ИССЛЕДОВАНИЙ этого сохранения:
        --   * stack_size_bonus — врождённый бонус прототипа (в 1.1 то же поле
        --     звалось inserter_stack_size_bonus). Раньше читалось только старое
        --     имя, которого в 2.0 нет, поэтому в дампе у ВСЕХ манипуляторов
        --     стоял 0 и массовые считались ровно как обычные;
        --   * у массовых (bulk) манипуляторов работает своя технология —
        --     LuaForce::bulk_inserter_capacity_bonus, у остальных
        --     LuaForce::inserter_stack_size_bonus (в игре это «Inserter capacity
        --     bonus»). Без них пачка всегда 1, а с ними массовый несёт до 12.
        local stack_bonus = try(function() return prototype.stack_size_bonus end)
        if stack_bonus == nil then stack_bonus = try(function() return prototype.inserter_stack_size_bonus end) end
        stack_bonus = stack_bonus or 0
        local bulk = try(function() return prototype.bulk end) or false
        local uses_research = try(function() return prototype.uses_inserter_stack_size_bonus end)
        if uses_research == nil then uses_research = true end
        local research_bonus = 0
        if uses_research and local_force then
          research_bonus = try(function()
            return bulk and local_force.bulk_inserter_capacity_bonus or local_force.inserter_stack_size_bonus
          end) or 0
        end
        entry.inserter_stack_size_bonus = stack_bonus
        entry.inserter_research_bonus = research_bonus
        entry.inserter_hand_size = 1 + stack_bonus + research_bonus -- предметов за один заход
        entry.uses_stack_bonus_research = uses_research
        entry.bulk = bulk
      elseif ptype == "pump" then
        local pumping = try(function() return prototype.get_pumping_speed() end)
          or try(function() return prototype.pumping_speed end)
        entry.pumping_speed = pumping and (pumping * 60) or nil -- units/sec
      end

      data.entities[name] = entry
      table.insert(translation_requests, { key = "entity:" .. name, localised_name = prototype.localised_name, target = entry })
    end
  end

  return data, translation_requests
end

-- ---------------------------------------------------------------------------
-- Translation bookkeeping (module-level state, survives across ticks)
-- ---------------------------------------------------------------------------
local translation_state = nil

-- A recipe without a name of its own is called after what it makes in the game: the item/fluid of the
-- same id, else its first product.
local function fill_recipe_names(d)
  local function named(tbl, id)
    local e = tbl and tbl[id]
    local n = e and e.display_name
    if n and n ~= id then return n end
    return nil
  end
  for name, recipe in pairs(d.recipes) do
    if not recipe.display_name or recipe.display_name == name then
      local own = named(d.items, name) or named(d.fluids, name)
      if not own then
        local first = recipe.products and recipe.products[1]
        if first then own = named(first.type == "fluid" and d.fluids or d.items, first.name) end
      end
      if own then recipe.display_name = own end
    end
  end
end

local function finalize_dump()
  fill_recipe_names(translation_state.dump)
  local h = get_helpers()
  local json = h.table_to_json(translation_state.dump)
  h.write_file("chain-calc-dump.json", json, false)
  -- Sentinel file tools/auto_dump.ps1 polls for, so it knows when it's safe to
  -- close the game automatically.
  h.write_file("chain-calc-dump.done", tostring(game.tick), false)
  local d = translation_state.dump
  game.print(string.format(
    "[chain-calc] Dump v%d written to script-output/chain-calc-dump.json (%d recipes, %d items, %d fluids, %d entities) - names resolved: %d/%d",
    DUMP_VERSION,
    table_size(d.recipes), table_size(d.items), table_size(d.fluids), table_size(d.entities),
    translation_state.done, translation_state.total
  ))
  show_status_all(string.format("[chain-calc] Dump written (%d recipes, %d items).", table_size(d.recipes), table_size(d.items)))
  translation_state = nil
end

local function do_dump(player_index)
  if not player_index then
    for idx, player in pairs(game.players) do
      if player.valid then player_index = idx break end
    end
  end
  local data, requests = build_raw_dump()
  local player = player_index and game.get_player(player_index)
  if not player then
    -- No player available (headless or no character). Fall back to writing dump without translations.
    local h = get_helpers()
    local json = h.table_to_json(data)
    h.write_file("chain-calc-dump.json", json, false)
    h.write_file("chain-calc-dump.done", tostring(game.tick), false)
    game.print(string.format("[chain-calc] Dump v%d written (no translations available) to script-output/chain-calc-dump.json — %d recipes, %d items, %d fluids, %d entities",
      DUMP_VERSION, table_size(data.recipes), table_size(data.items), table_size(data.fluids), table_size(data.entities)))
    show_status_all("[chain-calc] Dump written (no translations) — done.")
    return
  end

  translation_state = {
    player_index = player_index,
    dump = data,
    waiting = {},
    total = #requests,
    done = 0,
    started_tick = game.tick,
    last_progress_tick = game.tick,
  }

  local h = get_helpers()
  for _, req in pairs(requests) do
    local ok, ls_json = pcall(function() return h.table_to_json(req.localised_name) end)
    if not ok then ls_json = tostring(req.key) end
    translation_state.waiting[ls_json] = translation_state.waiting[ls_json] or {}
    table.insert(translation_state.waiting[ls_json], req)
    player.request_translation(req.localised_name)
  end

  game.print(string.format(
    "[chain-calc] Requested %d translations, waiting for the game to resolve them (this can take a few seconds)...",
    translation_state.total))

  -- show in-game status to players
  show_status_all(string.format("[chain-calc] Requested %d translations — preparing dump...", translation_state.total))

  if translation_state.total == 0 then
    finalize_dump()
  end
end

commands.add_command("dump-factorio-data",
  "Dump items/fluids/recipes/entities (with localised names in your game's language) to script-output/chain-calc-dump.json",
  function(cmd)
    if translation_state ~= nil then
      game.print("[chain-calc] A dump is already in progress, please wait.")
      return
    end
    local ok, err = pcall(do_dump, cmd.player_index)
    if not ok then
      game.print("[chain-calc] Dump failed: " .. tostring(err))
      translation_state = nil
    end
  end)

script.on_event(defines.events.on_string_translated, function(event)
  if translation_state == nil then return end
  local h = get_helpers()
  local ok, ls_json = pcall(function() return h.table_to_json(event.localised_string) end)
  if not ok then return end
  local targets = translation_state.waiting[ls_json]
  if not targets then return end
  translation_state.waiting[ls_json] = nil
  translation_state.last_progress_tick = event.tick
  for _, req in pairs(targets) do
    -- a missing key comes back as the text 'Unknown key: "recipe-name.x"': that is not a name
    local good = event.translated and event.result and event.result ~= ""
      and not string.find(event.result, "Unknown key", 1, true)
    req.target.display_name = good and event.result or req.target.name
    translation_state.done = translation_state.done + 1
  end
  if translation_state.done >= translation_state.total then
    finalize_dump()
  end
end)

-- Авто-запуск экспорта при инициализации карты и при создании игрока.
-- Это позволяет автоматически сгенерировать дамп на первом запуске карты
-- или сразу после появления игрока (чтобы получить локализованные имена).
script.on_init(function()
  if translation_state == nil then
    local ok, err = pcall(do_dump)
    if not ok then
      -- Печать в лог/чат; в некоторых режимах on_init может работать без игроков.
      game.print("[chain-calc] Auto-dump on_init failed: " .. tostring(err))
    end
  end
end)

script.on_event(defines.events.on_player_created, function(event)
  if translation_state == nil then
    local ok, err = pcall(do_dump, event.player_index)
    if not ok then
      local player = game.get_player(event.player_index)
      if player and player.valid then
        player.print("[chain-calc] Auto-dump on_player_created failed: " .. tostring(err))
      end
    end
  end
end)

script.on_event(defines.events.on_tick, function(event)
  -- Translation timeout handling only. Manual `/dump-factorio-data` triggers
  -- the process; automatic auto-dump attempts were removed to avoid being
  -- blocked by Factorio/Steam restrictions.
  if translation_state == nil then return end
  -- give up when nothing has been translated for 10 s of game time (600 ticks), or after 10 minutes in total
  if event.tick - (translation_state.last_progress_tick or translation_state.started_tick) > 600
      or event.tick - translation_state.started_tick > 36000 then
    game.print("[chain-calc] Timed out waiting for some translations, writing dump with what we have.")
    for _, targets in pairs(translation_state.waiting) do
      for _, req in pairs(targets) do
        req.target.display_name = req.target.name
      end
    end
    finalize_dump()
  end
end)

-- Click handler for the status GUI close button
script.on_event(defines.events.on_gui_click, function(event)
  if not event.element or not event.element.valid then return end
  if event.element.name == "chain_calc_status_close" then
    local player = game.get_player(event.player_index)
    if player and player.valid and player.gui and player.gui.screen.chain_calc_status then
      player.gui.screen.chain_calc_status.destroy()
    end
  end
end)
