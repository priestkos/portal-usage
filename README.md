# Portal Usage (Hermes Desktop Plugin)

A unified plugin for Hermes Agent and Hermes Desktop that tracks usage limits and balances across three AI billing portals:

- **OpenCode Go** (Rolling, Weekly, and Monthly usage percent windows)
- **OpenRouter** (Account credit balance & spend metrics)
- **Nous Portal** (Subscription credits, top-up balance, rollover, renewal countdown)

Surfaces as a compact status-bar chip on `statusBar.right` with an interactive popover details panel.

## Features

- **Three View Modes:**
  - **A (Budget):** Native units as reported by each provider (percentages and dollar figures).
  - **B (≈Tokens):** Derived estimated token runway calculated from live catalogue pricing for reference models.
  - **C (Context):** Live token usage and percentage of the active chat's context window.
- **Unified Architecture:** Ships both the Python dashboard API route (`/api/plugins/portal-usage/usage`) and the frontend desktop plugin (`desktop/plugin.js`).
- **Zero Third-Party Dependencies:** Relies entirely on built-in Hermes runtime facilities and `@hermes/plugin-sdk`.

## Structure

```
├── dashboard/
│   ├── manifest.json
│   └── plugin_api.py
├── desktop/
│   └── plugin.js
├── plugin.yaml
└── README.md
```

## License

MIT
