# Device network

The TiinyOS client resolves a fixed set of hostnames to the Pocket's USB
network address. The vendor's official client does this internally; in the
Linux clone we point them at the device via `/etc/hosts`.

Find the device IP (interface created when you plug the Pocket in, usually
`usb0`/`usb1` — run `ip addr` right after connecting):

```
ip -brief addr show dev usb0
```

Then add to `/etc/hosts` (replace the IP with yours):

```
172.23.6.165 api.tiiny auth.api.tiiny wifi.api.tiiny kb.api.tiiny chat-history.api.tiiny tts.api.tiiny p8800.api.tiiny openai.api.tiiny connector.api.tiiny backup.managed.tiiny
172.23.6.165 agent-services.api.tiiny hardware-upgrade.api.tiiny anthropic.api.tiiny ollama.api.tiiny
```

Two lines only because some lines get long; one line is fine too.

Verify: `curl -s -m 3 http://api.tiiny/` should answer from the device.

Notes

- The IP is whatever the device hands out on the USB link; it can differ per
  machine/distro. It is local to your machine — nothing leaves it.
- Cloud features (model store downloads, account) still go through Tiiny's
  public cloud over the normal interface; only the device API hostnames above
  are pinned.
