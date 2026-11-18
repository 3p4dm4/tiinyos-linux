# Music Lab — standalone

Run the Music Lab window as its own app, without opening TiinyOS. Same
source as the feature pack (`../src`), same config
(`~/.config/music-lab/config.json`), same output folder — takes generated
here show up in the in-app Takes list and vice versa.

```bash
./launch.sh          # reuses the Electron binary from the clone
```

Requirements: the Pocket reachable on the network (`api.tiiny` resolves —
same `/etc/hosts` line as the main app, see [`../docs/network.md`](../docs/network.md))
and the Electron binary from `build_clone.sh` (override with
`MUSIC_LAB_ELECTRON=/path/to/electron`).

The window is identical to the in-app one: workflow stepper, model chips,
waveforms. Nothing is duplicated — `main.js` registers its window on the
feature's IPC handlers (`attach()` in `../src/m3_music.js`).
