# Sticky Table Headers

Keeps table headers visible while you scroll through long tables in Obsidian. When a table's header row would scroll out of view, a copy of it stays pinned at the top of the viewport, so you always know what each column means.

Works in both Reading view and Live Preview, handles multiple tables on the same page, and follows horizontal scrolling on wide tables.

## Features

- **Sticky headers on scroll** — the header row stays visible as you scroll down a long table.
- **Multiple tables** — every table on the page is handled independently.
- **Horizontal scroll aware** — on wide tables, the pinned header scrolls sideways in sync with the table body, so columns stay aligned.
- **Theme-friendly** — the pinned header inherits your table's existing styling.
- **Zero configuration** — enable it and it just works.

## How it works

The plugin watches your tables and, when a header scrolls past the top of the scroll container, renders a lightweight pinned clone of just the header row. Column widths are measured from the real table so the clone stays perfectly aligned. Nothing is written to your notes — this is a display-only enhancement.

Updates are event-driven: scroll, resize, table edits, and visibility-boundary changes share one animation-frame queue. Column widths are cached until layout or table content changes. There is no periodic polling; ordinary text mutations outside tables do not trigger table scans or header measurements. A lightweight DOM observer discovers newly inserted tables and releases resources when tables are removed.

## Development checks

Run `npm ci`, then `npm run typecheck` and `npm test` with Node.js 20 or newer. The regression tests use a real Chromium DOM with controlled animation frames, resize notifications, and intersection notifications, plus a native observer check for position changes. Install Chromium or set `CHROMIUM_PATH` to a compatible browser executable.

The tests cover repeated typing mutations with and without tables, batched scrolling across multiple tables, cached widths, horizontal clipping, header edits, insertion/removal, and plugin unload. For an Obsidian performance comparison, repeat the same typing trace after replacing `main.js` and reloading the plugin; check callback frequency and total CPU time, then verify scrolling, pane resizing, and table edits in both Reading view and Live Preview.

## Installation

### From Community Plugins (once approved)

Settings → Community plugins → Browse → search **Sticky Table Headers** → Install → Enable.

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/JWCzju/sticky-table-headers/releases).
2. Copy them into `<your-vault>/.obsidian/plugins/sticky-table-headers/`.
3. Reload Obsidian and enable the plugin in Settings → Community plugins.

## Support

If this plugin is useful to you, you can support development via [GitHub Sponsors](https://github.com/sponsors/JWCzju). Completely optional.

## License

[MIT](LICENSE) © Yinno
