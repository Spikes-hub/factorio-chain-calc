# Using the calculator

[Русский](usage.ru.md)

1. **Load a dump** (see [dumps](dumps.md)) and pick it in the list at the top.
2. **Choose the belt** you build with (strip at the top of the *Calculation* tab): it defines how many belts and
   machines the layout needs.
3. **Find a recipe**: the *Recipe search* tab finds recipes by name, product, ingredient or internal id. Click one to
   start a chain and jump to the calculation.
4. **Set the target rate** (per second or minute). The tree is solved for the whole chain, loops included.
5. **Tune each stage**: change the machine, modules, beacons, fuel for burner machines (the feed and the ash
   are added to the calculation). Switch a recipe where several make the same item.
6. **Inserters and loaders**: the *Inserters* tab lists them all. Tick the ones you actually have; only ticked
   ones are suggested. Enter speed and stack size if the dump doesn't know them. The calculator then tells how many
   of them each machine needs.
7. **Blueprints**: the layout of a block as a blueprint string you can paste in the game (needs geometry from a
   dump). With the *pipes* checkbox the generator also lays pipes (and underground pipes) from the machines to the
   fluid inputs and outputs of the block, and turns machines whose fuel is a fluid so that the fuel port faces a pipe.
   The layouts are learned from hand-built templates, so for a machine/recipe that has no template yet the
   generator does not guess: it says *"no pipe layout sample"* and asks to clear the *pipes* checkbox (the block is
   then built without pipes and the fluid hookups are left to you, with notes). The *Layout diagram* shows the
   result before you copy it. **Make a new dump** (`dump_full.bat`) once after updating: the fuel input of machines
   with fluid fuel is read from the geometry.
8. **Request chest for the chain**: the *Request chest: what the chain needs* button in the results collects the
   building materials of all stages (machines, belts, inserters, poles, modules, beacons) into one requester chest
   and copies its blueprint string to the clipboard; paste it in the game and build the chest.
9. **Request chest for any blueprint**: the *Chest from blueprint* tab takes a blueprint string pasted into it,
   counts everything it consists of and builds a requester chest for it. The same tab has the "Assemble everything"
   mall: an assembler for every building recipe with a request chest and a supply chest; the whole mall is also
   given in parts, because the game's import window does not accept very long strings.
10. **Save** the chain to continue later.

Tips: *Settings* has "only researched recipes" (save dumps only), the language switch is **EN | RU** in the
corner, the ☾/☀ button toggles the theme.
