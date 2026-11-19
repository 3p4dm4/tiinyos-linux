# Music Lab — standalone

Run the Music Lab window as its own app, without opening TiinyOS. Same
source as the feature pack (`../src`), same config
(`~/.config/music-lab/config.json`), same output folder — takes generated
here show up in the in-app Takes list and vice versa.

```bash
./launch.sh          # reuses the Electron binary from the clone
```

Launcher details:

* the cached symlink farm lives in `~/.cache/music-lab-standalone/electron`
  (or `$XDG_CACHE_HOME/music-lab-standalone/electron`); `resources/app` is
  re-pointed at the checkout it is launched from on every launch, and a
  one-line log on stderr says which checkout is running;
* `MUSIC_LAB_ELECTRON_DIR=/path/to/electron` overrides the clone's Electron
  location (default `~/.local/tiinyos-clone/electron`);
* `MUSIC_LAB_FLAGS` passes extra Chromium flags, e.g.
  `MUSIC_LAB_FLAGS=--disable-gpu` if your GPU crashes Electron at startup
  (off by default: software rendering paints the window black on this
  hardware);
* only one standalone window runs at a time: a second launch restores
  (if minimized) and focuses the existing one, then exits.

Requirements: the Pocket reachable on the network (`api.tiiny` resolves —
same `/etc/hosts` line as the main app, see [`../docs/network.md`](../docs/network.md))
and the Electron binary from `build_clone.sh`.

The window is identical to the in-app one:

* **model chain** — the writer and the composer each pick their model from
  a list with live state (loaded/loading on the chip, NPU memory bar);
  before Generate the window shows the swap plan the device reported
  (which loaded models the composer would evict); after the last take of a
  batch it optionally reloads the models that were in memory before;
* **takes** — saved in the output folder with a `.json` record (prompt,
  seed, models) and listed when the window opens;
* only one generation runs at a time, across the in-app window and the
  standalone app.

Nothing is duplicated — `main.js` registers its window on the feature's IPC
handlers (`attach()` in `../src/m3_music.js`).
