# ChatGPT / Claude Local Exporter

A small browser extension that downloads your ChatGPT or Claude conversations
as a local ZIP archive.

The extension runs entirely in the browser. It uses the logged-in session on
the current site, makes no requests to a developer-owned server, and includes
no analytics or telemetry.

## Features

- Export all conversations.
- Export only conversations changed since the previous successful export.
- Preserve ChatGPT Project paths and metadata.
- Export provider JSON together with readable Markdown.
- Stop immediately when the provider returns HTTP 429.
- Store incremental export state locally in the browser profile.

## Install in Chrome

1. Download or clone this repository.
2. Open `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository directory.
6. Open [ChatGPT](https://chatgpt.com/) or [Claude](https://claude.ai/).

An export panel appears in the bottom-right corner of the page.

## Use

- **Export updated** lists the account's conversations and downloads the ones
  whose list metadata changed since the previous successful export.
- **Export all** downloads every conversation returned by the site.
- **Reset state** clears saved incremental fingerprints and failure counters.
- **Stop** stops after the current request completes.

The downloaded ZIP contains:

```text
manifest.json
conversations/<path>/<conversation-id>.json
markdown/<path>/<conversation-title>-<short-id>.md
```

The archive may contain private conversations, metadata, file references, and
other information returned by the provider. Store and share it accordingly.

## Install as a userscript

The same source can also run in a userscript manager such as Tampermonkey:

```text
chatgpt-local-exporter.user.js
```

## Development

There is no build step and no runtime dependency. The submitted source is the
source that runs in the browser.

Basic syntax check:

```bash
node --check chatgpt-local-exporter.user.js
```

The extension depends on the websites' current internal response formats, so a
site update may require a corresponding exporter update.

## License

GPL-3.0
