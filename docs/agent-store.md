# Agent store on Linux

The official TiinyOS desktop app ships an **Agent store**: a catalog of apps
that pair with a Tiiny Pocket. The catalog is served by the device itself
(`GET http://p8800.api.tiiny/api/v1/apps`, Bearer auth), and every entry
declares the platform binaries it can install.

**On Linux, part of the catalog cannot be installed from the store: several
desktop agents publish only Windows and macOS binaries.** This page documents
what the store actually offers, measured from a live device (2026-11-17,
store API `0.1.30-debug`, 13 entries).

## The catalog, by install type

### Web apps — run on the device, OS-independent (8)

These install *on the Pocket* and open in a browser/webview. The client
operating system doesn't matter: they work from the Linux port exactly as
from macOS/Windows.

| App | License |
|---|---|
| n8n | n8n Enterprise License |
| Open WebUI | BSD-3-Clause |
| Odysseus | AGPL-3.0 |
| OpenHands | MIT |
| Tiiny Music | Proprietary |
| SillyTavern | AGPL-3.0 |
| AutoGPT | MIT |
| Dify | Apache-2.0 |

### KiloCode — VS Code extension (1)

Platform `extension` (`.vsix`), so it installs on any VS Code, Linux
included. The store auto-configures a Tiiny provider (`model = "default"` →
whatever text model is loaded on the Pocket).

### Desktop agents — Windows/macOS binaries only: **not deployable from the store on Linux** (4)

| App | Store platforms | License | Workaround on Linux |
|---|---|---|---|
| Tiiny Meeting | `windows-x86-64`, `windows-arm`, `darwin-arm64` | Proprietary | none (no public Linux build) |
| opencode | `darwin-arm64`, `windows-x86-64` | MIT | install upstream Linux build, point it at the device's [OpenAI-compatible API](network.md) |
| HermesAgent | `windows-x86-64`, `darwin-*` | MIT | install upstream Linux build (Nous Research), same API endpoint |
| OpenClaw | `darwin-*`, `windows-x86-64` | MIT | install upstream Linux build, same API endpoint |

The store has **no `linux` platform entry** for these four: the install
button has nothing to download. The three MIT-licensed ones are ordinary
open-source tools that talk to an OpenAI-compatible endpoint — the device
already exposes one (`openai.api.tiiny`), so the agent works on Linux when
installed outside the store. Tiiny Meeting is the only hard loss (proprietary,
no Linux build).

## Notes on the data

- Observed via the device API, read-only; the `platforms[]` entries include
  `blob_url` + `sha256sum` per platform (that's what the table above reflects).
- The store catalog changes over time — re-run the probe to refresh:
  `curl -H "Authorization: Bearer <authKey>" http://p8800.api.tiiny/api/v1/apps`
  (the authKey is in `~/.local/tiiny/config.json`, see
  [network.md](network.md)).
- Some entries carry `status: 0` instead of `2` (Open WebUI, Odysseus,
  OpenHands, OpenClaw, AutoGPT). Interpretation, **not verified**: `2` =
  installable now, `0` = listed but not yet released. Treat as unconfirmed.
