# chain-calc-exporter

Factorio mod that exports recipes, items, fluids and machines of your game (with your mods) to
`script-output/chain-calc-dump.json`. You don't install it by hand: `dump_with_icons.bat` in the
parent folder copies it into your Factorio `mods` folder for the duration of the dump and removes it
afterwards. The mod dumps by itself: when a save is loaded with the mod freshly added, and when a player is created in a new
map (with names in the language of the game). The console command `/dump-factorio-data` remains as a fallback.

Written to work on Factorio 2.0+ and 1.1: fields that exist only in some versions are wrapped in
`pcall`, a missing field is simply left out of the dump.
