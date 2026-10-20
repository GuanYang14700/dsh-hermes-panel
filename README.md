# dsh-hermes-panel

[中文](README.zh.md) | English

A [Hermes](https://github.com/NousResearch/hermes-agent) panel for
[DSH](https://github.com/deepseek-ai/deepseek-harness), in the right sidebar: start and stop the
gateway and dashboard, watch the dashboard beside the chat, and bridge DSH to Hermes.

For the native Hermes agent (`hermes-agent`). Not for `hermes-web-ui` / Ekko Studio.

## Panel

Open it from the ⊕ list in the right sidebar → **Open Hermes**. The strip on top switches between
three views and carries start/stop, restart and open-in-new-tab:

- **Dashboard** — the Hermes dashboard in an iframe, conversation on the left.
- **Record** — the Hermes ↔ DSH exchange, read from DSH's own session logs.
- **Setup** — health check, update, the DSH bridge, and the shared workspace.

Health and update run the `official-web` distribution's own PowerShell scripts. An upstream pip
install has neither, so those two buttons are disabled there and the panel says why. Everything
else works on any install.

## Install

```sh
dsh plugin --profile web add @yang3333/dsh-hermes-panel
```

Then restart `dsh`: the host half is a Node module, and a page refresh does not reload it.

Needs DSH `>= 0.2.0-rc.2` and an existing Hermes install — the plugin does not install Hermes, it
finds it or is told where it is. Windows only.

## Settings

Two directories, both optional. Empty means a default under the DSH home.

- **Runtime** — the Python environment Hermes runs in. Default `<dsh home>/hermes-panel/runtime`.
- **Data directory** — `HERMES_HOME`: profiles, sessions, `config.yaml`. Default
  `<dsh home>/hermes-panel/home`.

The rest: `dashboardPort` (0 = read from `.env`, else 9150), `sharedWorkspace`, `manageGateway`,
`autostart`.

Change them in the **Plugins** panel → **Official** → **Hermes Panel settings**.

## Bridge

With the bridge open, the panel writes the Hermes side (`mcp_servers.dsh`) into `config.yaml` and
checks that each profile's `@deepseek-ai/dsh-mcp-client` matches the running DSH. When one does not,
it prints the command that fixes it.

## Security

The HTTP routes are loopback-only and check `Origin` and `Sec-Fetch-Site`. `.env` parsing keeps only
`HERMES_HOME`, `VENV`, `HERMES_EXE` and `DASHBOARD_PORT`; no other value is stored. Do not bind DSH
to `0.0.0.0` while the plugin is enabled.

## Development

```sh
npm test          # hermetic; safe to run while Hermes is running
npm run test:e2e  # drives the real scripts and a real dashboard
```

The suite lives in `verify/`, one file per area, each with a comment saying what regression it
guards. `verify/smoke.mjs` loads the host half with an empty config, asserts it registers 17 routes
and that activation spawns nothing, then calls the status route with no Hermes installed.
`verify/config.mjs` checks that the config loads with all 6 fields volatile, that a value saved after
activation is what the panel reads, and that `.env` parsing keeps only the four whitelisted keys.

## License

MIT
