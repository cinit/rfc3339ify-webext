# RFC3339ify

RFC3339ify is a small, no-telemetry browser extension that normalizes a narrow,
explicit set of English dates and 12-hour times in rendered page text. It does
not parse arbitrary natural-language dates.

Examples:

```text
Jan 1                 -> 01-01
Jan 1, 1990           -> 1990-01-01
2 Jan 99              -> ??99-01-02
01:00 PM              -> 13:00
01:02:03 AM           -> 01:02:03
Tue, 28 Jul 2026 18:00:58 +0000
                      -> Tue, 2026-07-28 18:00:58 +0000
```

The extension changes eligible DOM `Text` nodes locally. It has no background
worker, runtime dependency, telemetry, or network code. Its only persisted
setting is one local Boolean controlling whether normalization is enabled; it
does not store page text, URLs, hostnames, or match history. It skips editable
and known editor surfaces, form choices, metadata, scripts, and styles. A
response served as `text/plain`, including a raw patch displayed in a
browser-generated `<pre>`, is left untouched.

Supported release targets are Chrome 99+ on desktop, Firefox 140+ on desktop,
and Firefox 142+ on Android. Official Chrome on Android cannot install Chrome
Web Store extensions and is not supported.

## Global switch

Open RFC3339ify from the desktop toolbar/extensions menu, or from Firefox
Android's Add-ons menu, and use the native `Normalize dates and times`
checkbox. The setting applies to every eligible page in this browser profile
and is not synchronized to other browsers or devices.

Switching off stops future replacements in live tabs after the setting reaches
their extension contexts. It does not reconstruct text already changed in the
DOM. Reload an affected tab to request fresh page text. Tabs that predate
extension injection or whose Android extension context was discarded may also
need a reload before they follow a later change.

## Development

Node.js 22.22.2 or 24.15.0 or newer is required for the development test
harness. Runtime code itself uses only browser APIs.

```sh
npm install
npm test
npm run package
```

`npm run package` creates deterministic, uncompressed ZIP files and unpacked
directories under `dist/`. The ZIP allowlist is exactly the manifest; the four
content/bootstrap scripts; popup HTML, CSS, and JavaScript; and four reviewed
PNG icons. Run `npm run icons` only when intentionally regenerating those
deterministic icons.

For the real Chrome smoke test, use Chromium or the official Chrome for
Testing build; current branded Google Chrome releases ignore command-line
unpacked-extension loading:

```sh
CHROME_BINARY=/path/to/chrome-for-testing npm run test:chrome
```

On a restricted disposable CI/VM that disables user namespaces and has no SUID
Chrome sandbox helper, add `CHROME_NO_SANDBOX=1` for this local smoke test only.

Firefox desktop uses the same real-MIME fixture through a temporary `web-ext`
installation:

```sh
FIREFOX_BINARY=/path/to/firefox npm run test:firefox
```

The pinned Firefox manifest release check can be run without adding its large
dependency tree to the repository:

```sh
npm run package
npx --yes web-ext@10.5.0 lint --source-dir dist/firefox --warnings-as-errors
```

The complete grammar, DOM policy, risk analysis, and release gates are in
[DESIGN.md](DESIGN.md).

No source license has been selected yet. The package remains `UNLICENSED`
until the project owner makes that release decision.
