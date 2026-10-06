# Troubleshooting

[Русский](troubleshooting.ru.md)

**The page doesn't open / "unable to connect".** Keep the `start.bat` window open — closing it stops the server.
If the window shows an error, copy it into a bug report. If port 8010 is busy, set `CHAIN_CALC_PORT` (for example
`set CHAIN_CALC_PORT=8020`) before running `start.bat`.

**`start.bat` can't download Python or packages.** The first run needs internet. Check a proxy/antivirus, and delete
the `.venv` and `.python` folders to retry from scratch.

**A dump script can't find Factorio.** Enter the folder with `factorio.exe` when asked, or set `FACTORIO_DIR`.

**The game starts and closes at once, or the dump is empty.** Make sure Factorio is fully closed before the script
starts, and that Steam is running if your copy needs it. Then run the script again.

**Names are in English.** Names come from the language set in your game. Run `dump_full.bat` / `dump_from_save.bat`
again after changing the game language.

**No inserters are suggested / blueprints have no inserters.** After a *full* dump nothing is ticked in the
*Inserters* tab. Tick the ones you have and enter their speed and stack size; a save dump ticks the researched ones
for you.

**The dump is old after I changed mods.** Make a new dump; icons and geometry are rebuilt when the mod set changes.

Still stuck? Open a bug report in [Issues](../../../issues/new/choose) with your Windows version, the script you ran
and the text of the error.
