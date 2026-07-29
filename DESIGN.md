# RFC3339ify WebExtension: detailed design draft

Status: Draft for review

Date: 2026-07-29

Target: Manifest V3 WebExtension for Chrome desktop and Firefox desktop/Android

## 1. Executive summary

The extension rewrites a deliberately small set of English, human-readable date and 12-hour time forms in page text. Examples include:

| Input | Output |
| --- | --- |
| `Jan 1` | `01-01` |
| `Jan 1, 1990` | `1990-01-01` |
| `12 Jan 23` | `??23-01-12` |
| `01:00 PM` | `13:00` |
| `01:02:03 AM` | `01:02:03` |
| `Tue, 28 Jul 2026 18:00:58 +0000` | `Tue, 2026-07-28 18:00:58 +0000` |

The recommended implementation is one small, readable content script. It:

1. runs in the browser's isolated extension world;
2. exits unless `document.contentType` is `text/html` or `application/xhtml+xml`;
3. walks eligible DOM `Text` nodes without reading or rewriting HTML;
4. applies a deterministic, locale-independent scanner;
5. changes only `Text.data` when the output differs; and
6. watches later DOM mutations in bounded, coalesced batches.

There is no background/service-worker process, remote code, telemetry, network access, page-world injection, or production dependency. This keeps the extension small and makes its behavior on sensitive sites such as GitHub and the Cloudflare dashboard practical to audit.

One requested target is not currently feasible: official Google Chrome on Android does not run Chrome Web Store extensions. Google documents extensions as a desktop customization; its phone workflow only queues an extension for installation on a desktop computer. The same WebExtension can target Chrome desktop and Firefox desktop/Android, but it cannot target official Chrome Android until Google exposes an extension platform there. Extension-capable Chromium forks on Android are a possible unsupported test target, not a Chrome Android deliverable.

## 2. Goals

### 2.1 Functional goals

- Normalize the explicitly supported date and time forms in human-facing text of live HTML and XHTML documents.
- Preserve text outside the matched date/time span code-unit-for-code-unit.
- Preserve weekday text, punctuation outside a match, timezone names, and timezone offsets. Weekdays are not parsed at all, so both `Tue` and strings such as `星期二` remain unchanged.
- Process content inserted or changed after initial page load, including single-page application navigation, virtualized lists, and delayed API results.
- Process matching same-origin and cross-origin subframes when the extension has access to those frame URLs.
- Leave HTTP(S) resources served as `text/plain` untouched, even when the browser displays them in a generated `<pre>` element.
- Produce the same result on all supported browsers and independently of the browser, page, or operating-system locale.
- Be idempotent: applying the transformer twice must produce exactly the same result as applying it once.

### 2.2 Security and quality goals

- Minimize requested browser privileges and the amount of long-lived code executing on every page.
- Make the release artifact readable and small enough for direct source review.
- Never evaluate page text as HTML or JavaScript.
- Never transmit, persist, or log page content.
- Avoid unbounded synchronous DOM walks and catastrophic regular-expression behavior.
- Fail closed on unsupported or ambiguous syntax: leaving text unchanged is preferable to a plausible but incorrect conversion.
- Avoid page layout reads in the normal path so that the extension does not cause repeated style/layout calculation.

## 3. Non-goals

- Converting arbitrary natural-language dates, relative dates (`yesterday`, `2 hours ago`), numeric regional dates (`1/2/26`), or non-English month names.
- Verifying that an input weekday agrees with its date. A mismatched `Tue` is still preserved.
- Converting timezone offsets, timezone abbreviations, or local time to UTC.
- Producing a complete RFC 3339 timestamp. The name “RFC3339ify” describes the preferred numeric style; outputs such as `01-01` omit a year and `??23-01-12` explicitly marks an unknown century, so neither is RFC 3339.
- Changing DOM attributes, form values, placeholders, accessibility labels, metadata, JSON, scripts, styles, network responses, clipboard contents, or downloaded files.
- Changing browser UI, PDF viewer content, extension-store pages, browser-protected pages, or other locations where content scripts are prohibited.
- Reading text drawn into a `<canvas>`, CSS-generated `::before`/`::after` content, browser-native form-control UI, or inaccessible closed shadow roots.
- Parsing a date whose visible characters are split across multiple DOM `Text` nodes in version 1. This limitation is discussed in section 7.6.
- Supporting official Chrome on Android while Chrome itself lacks extension support.

## 4. Feasibility and browser support

| Platform | Proposed support | Notes |
| --- | --- | --- |
| Chrome desktop | Supported | Manifest V3 static content script. Chrome-protected URLs remain inaccessible. |
| Chromium desktop derivatives | Best effort | Expected to work where ordinary Chrome MV3 extensions work; only named browsers are release gates. |
| Firefox desktop | Supported | Manifest V3 WebExtension using the same content-script source. |
| Firefox for Android | Supported | Distributed through Mozilla Add-ons and tested on an Android emulator/device. Firefox version minimum must be selected during implementation from the APIs actually used. |
| Chrome for Android | Not feasible | Official Chrome Android cannot install/run this extension. “Add to Desktop” from a phone installs it later on desktop, not on the phone. |
| Android Chromium forks with extension support | Unsupported | May work, but their manifest/API/store compatibility and maintenance are outside the threat model and release matrix. |
| Safari/iOS | Out of scope | Would require a separate packaging, signing, and compatibility effort. |

The core uses only mature DOM APIs (`TreeWalker`, `MutationObserver`, `WeakMap`, and ordinary string operations). Browser-specific code should be confined to generated manifests and packaging metadata.

## 5. Proposed product behavior

### 5.1 Document gate

Every content-script instance performs this check before creating observers or traversing the DOM:

```text
if document.contentType is neither
    "text/html" nor "application/xhtml+xml"
then return permanently for this document
```

The URL suffix is deliberately irrelevant. A `.txt` URL served as HTML is eligible; an extensionless URL served as `text/plain` is not. The response `Content-Type`, exposed by `document.contentType`, is the authoritative boundary.

This handles the motivating raw-patch case. Browsers commonly construct an internal HTML-shaped DOM to display `text/plain`, but `document.contentType` remains `text/plain`, so a DOM-shape or `<pre>` test would be incorrect.

The gate is repeated independently inside every frame. Consequently, an HTML page may be transformed while an embedded plain-text frame is left alone.

### 5.2 Meaning of “visible rendered text”

The version-1 definition is **render-candidate text**, not “pixels currently visible in the viewport”:

- the text is a descendant of an HTML/XHTML document body or an eligible open shadow root;
- it is not inside a non-content container listed in section 7.3; and
- it is not an editable surface.

The node may be below the fold, clipped, transparent, or temporarily hidden by CSS. Processing such nodes avoids forced layout, also prepares disclosure widgets before they open, and does not miss a node revealed only by a media query, hover rule, animation, or external stylesheet load.

This is the resolved version-1 interpretation. A literal pixel-visibility rule cannot be both cheap and complete:

- `getComputedStyle()`, `checkVisibility()`, ranges, and layout rectangles can force style/layout work across large documents;
- visibility can change without a DOM mutation because of media queries, animations, hover/focus state, font loading, stylesheet loading, scrolling, clipping, or occlusion;
- viewport intersection is not the same as rendering, and observing every text parent is expensive; and
- whether opacity, clipping, off-screen positioning, collapsed details, or accessibility-only content count as “visible” is policy rather than a single DOM fact.

A strict computed-visibility mode is therefore rejected for version 1. If reconsidered later, it requires a separate design and benchmarks and would remain best-effort for CSS-only transitions.

### 5.3 Text surfaces

| Surface | Version-1 behavior | Reason |
| --- | --- | --- |
| Ordinary text nodes | Transform | Primary requirement. |
| Text inside links, buttons, and table cells | Transform | It is rendered label text; link targets and element attributes are untouched. |
| Text inside `<option>` | Leave untouched | Without an explicit `value` attribute, changing the label can also change the value submitted by a form. |
| Text inside `<pre>` or `<code>` in an HTML page | Transform | Approved for version 1; this can change copied code/log text. |
| Inline SVG `<text>` inside an eligible HTML/XHTML document | Transform | It consists of reachable DOM text nodes. |
| Open shadow DOM | Transform where discoverable | Requires a separate traversal/observer per shadow root. |
| Closed or user-agent shadow DOM | Leave untouched | It is not safely reachable from an isolated content script. |
| `<input>` value/placeholder and `<textarea>` value | Leave untouched | These are editable state/attributes, not ordinary rendered text nodes. |
| `contenteditable` and ARIA textbox/editor surfaces | Leave untouched | Avoid corrupting user input, selections, undo history, and editor models. |
| `title`, `alt`, `aria-label`, `data-*`, `datetime`, `value`, URLs | Leave untouched | Attribute mutation is outside scope and has larger application consequences. |
| CSS generated content and canvas text | Leave untouched | Not represented by mutable DOM text nodes. |
| Page title and metadata in `<head>` | Leave untouched | Not body-page content. |

### 5.4 Dynamic pages

“Final rendered” is not a one-time lifecycle point on modern sites. The extension therefore converges the current DOM continuously:

- scan the initial document at `document_idle`;
- observe later `childList` and `characterData` mutations;
- scan only added subtrees or directly changed text nodes;
- coalesce overlapping work and yield between bounded batches; and
- reapply after a framework overwrites normalized text.

No URL-change or history hook is required for single-page applications because the document observer remains active. A full navigation creates a new document and a new content-script instance.

## 6. Transformation specification

### 6.1 Lexical tokens

Version 1 uses a deterministic scanner with a fixed, explicit token set. Grammar notation in this section is descriptive: brackets mean an optional token, `|` means an alternative, and lookahead/boundary predicates do not consume input.

```text
ASCII_DIGIT := "0".."9"
DAY         := one or two ASCII digits whose numeric value is 1..31
YEAR2       := exactly two ASCII digits, 00..99
YEAR4       := exactly four ASCII digits, 0001..9999
HOUR12      := one or two ASCII digits, 1..12
HOUR24      := exactly two ASCII digits, 00..23 (recognition/refusal only)
MINUTE      := exactly two ASCII digits, 00..59
SECOND      := exactly two ASCII digits, 00..60
WSP         := ASCII space | tab | CR | LF | form feed | U+00A0
SP          := WSP repeated 1..8 times
OSP         := WSP repeated 0..8 times
MERIDIEM    := AM | PM | am | pm | a.m. | p.m.
```

`SECOND=60` is accepted syntactically so that a displayed leap-second value can be normalized. The extension does not have enough date/timezone context to prove that a particular occurrence is a real leap second; it preserves the value rather than inventing one.

Month matching is deliberately not arbitrary case-insensitive matching. Only all-lowercase, title-case, and all-uppercase spellings in this table are accepted:

| Month | Accepted base spellings; each accepts `aaa`, `Aaa`, and `AAA` casing |
| --- | --- |
| 01 | `jan`, `january` |
| 02 | `feb`, `february` |
| 03 | `mar`, `march` |
| 04 | `apr`, `april` |
| 05 | `may` |
| 06 | `jun`, `june` |
| 07 | `jul`, `july` |
| 08 | `aug`, `august` |
| 09 | `sep`, `sept`, `september` |
| 10 | `oct`, `october` |
| 11 | `nov`, `november` |
| 12 | `dec`, `december` |

Thus `Jan`, `jan`, `JAN`, `January`, `january`, and `JANUARY` are accepted, while `jAn` and `jAnUaRy` are not. `Sep`, `Sept`, and `September` each receive the same three casing variants.

The eight-code-unit whitespace limit is intentional. A run of nine or more accepted whitespace code units does not form `SP`/`OSP`, even if ordinary HTML layout would collapse it visually.

### 6.2 Date forms and output

The following complete forms are accepted. An optional comma, when present, is immediately after the day or month token and before the required `SP`.

```text
month-day-year4 := MON SP DAY [","] SP YEAR4  -> YYYY-MM-DD
day-month-year4 := DAY SP MON [","] SP YEAR4  -> YYYY-MM-DD

month-day-year2 := MON SP DAY [","] SP YEAR2  -> ??YY-MM-DD
day-month-year2 := DAY SP MON [","] SP YEAR2  -> ??YY-MM-DD

month-day       := MON SP DAY                  -> MM-DD
day-month       := DAY SP MON                  -> MM-DD
```

For both month-first and day-first candidates at the same input position, match precedence is strictly:

```text
1. YEAR4 form
2. YEAR2 form
3. yearless form
```

This ordering is semantic, not merely an implementation optimization. Once a recognizable `YEAR4` or `YEAR2` envelope is present, failed field/calendar validation returns `REFUSE`; the scanner must not fall through to a shorter year form or to the yearless form. For example, `Jan 1 1990` cannot be parsed as `Jan 1 19` plus `90`, and `Feb 29 2025` cannot fall back to `Feb 29`.

The two leading question marks in `??YY-MM-DD` are literal output characters. They explicitly preserve the fact that the century is unknown; this output is intentionally neither RFC 3339 nor ISO 8601. For example:

```text
Jan 2, 99   -> ??99-01-02
Jan 2 99    -> ??99-01-02
2 Jan, 99   -> ??99-01-02
2 Jan 99    -> ??99-01-02
```

The month token fixes the field roles in a day-first form: the leading number is the day and the trailing number is the year. Therefore `12 Jan 12` is structurally unambiguous and becomes `??12-01-12`. Only the century is unknown. A comma does not materially reduce semantic false positives, so it is optional in both orientations.

Dates are validated before replacement:

- month/day combinations must exist in the Gregorian calendar;
- a `YEAR4` date uses the normal Gregorian leap-year rule;
- a yearless `Feb 29` is accepted because it is possible in some years;
- a `YEAR2` `Feb 29` is accepted only when the unknown expanded year could be a leap year: `YY` is divisible by four, including `00`; and
- an invalid recognized date envelope is refused as a whole and cannot fall back to a shorter form.

Consequently, `Feb 29, 01` is unchanged, `Feb 29, 00` becomes `??00-02-29`, and `Feb 29, 2025` is unchanged.

### 6.3 Time form and output

```text
time12 := HOUR12 ":" MINUTE [":" SECOND] OSP MERIDIEM
```

`OSP` permits both `07:59AM` and `07:59 AM`. The meridiem token is removed and the hour becomes a zero-padded 24-hour value. Minutes and optional seconds are preserved:

```text
12:00 AM       -> 00:00
12:00 PM       -> 12:00
01:00 PM       -> 13:00
07:59a.m.      -> 07:59
07:59:60 p.m.  -> 19:59:60
```

Fractional seconds are out of scope. A recognized 12-hour time containing a fractional-second suffix is refused as a whole, so `07:59:59.123 AM` is unchanged rather than partially transformed. Invalid hours, minutes, seconds above 60, or malformed meridiem tokens are likewise left unchanged as complete recognizable envelopes.

### 6.4 Boundaries, envelopes, and refusal

The scanner distinguishes a token match from the larger **candidate envelope** around it. It determines the longest recognizable envelope first, validates it second, and only then decides whether to replace it. This prevents an invalid long date from degrading into a plausible short date.

A boundary is Unicode-aware. A candidate cannot start or end adjacent to a Unicode letter, mark, number, or connector punctuation, or to U+200C/U+200D. Month spellings and numeric fields remain ASCII-only. This prevents matches inside strings such as `fooJan 1`, `éJan 1`, `变量Jan 1`, `Jan 1st`, and `AM_variable`.

At any scanner position, a recognizer returns exactly one of:

```text
REPLACE(end, replacement)  copy replacement and advance to end
REFUSE(end)                copy the original envelope and advance to end
NO_MATCH                   copy one input code point and continue
```

`REFUSE` is as important as `REPLACE`: advancing past the whole envelope prevents the scanner from finding an unintended inner or prefix match.

Date recognition follows these rules in order:

1. Recognize a month-first or day-first core without consuming any trailing boundary character.
2. Before accepting a no-year core, inspect a possible comma/whitespace/numeric suffix and the explicitly recognized git-style time/year suffix. A digit run immediately followed by `:` is a time field, not a year suffix.
3. Try an accepted `YEAR4` production first; if present, validate and either replace or refuse the complete envelope.
4. Only when no `YEAR4` envelope is present, try an accepted `YEAR2` production and likewise replace or refuse it as a whole.
5. Only when neither year-bearing envelope is present, consider the yearless form.
6. If a suffix resembles a year but has a forbidden comma placement or a digit count other than two or four, refuse the complete envelope.
7. If no year-shaped suffix exists and the core has a valid Unicode boundary, replace only the core. Following spaces, punctuation, and words are not consumed.

The scanner also recognizes `(MON SP DAY | DAY SP MON) SP HOUR24:MINUTE[:SECOND] SP YEAR4` as an unsupported git-style envelope and refuses it. Thus `Mon Sep 17 00:00:00 2001` is unchanged rather than becoming `Mon 09-17 00:00:00 2001`. When a time field follows a yearless date without a trailing git-style year, the date and 12-hour time are independent candidates.

These examples are normative:

| Input | Output | Reason |
| --- | --- | --- |
| `Jan 1` | `01-01` | Month-first, no year. |
| `January 01` | `01-01` | Approved full month spelling. |
| `Jan 1 1990` | `1990-01-01` | Comma is optional for `YEAR4`. |
| `28 Jul` | `07-28` | Day-first, no year. |
| `28 Jul, 2001` | `2001-07-28` | Day-first `YEAR4` with comma. |
| `12 Jan 12` | `??12-01-12` | Field position is clear; only the century is unknown. |
| `12 Jan, 23` | `??23-01-12` | The comma is optional. |
| `Jan 1 at noon` | `01-01 at noon` | Boundary text is preserved. |
| `Jan 1, pending` | `01-01, pending` | Non-numeric suffix is not consumed. |
| `Jan 1 01:00 PM` | `01-01 13:00` | A colon disambiguates the following digits as a time, not `YEAR2`. |
| `Jan 1, 123` | unchanged | Recognizable invalid year envelope; no prefix fallback. |
| `Jan 1st` | unchanged | Identifier/ordinal boundary fails. |
| `Feb 29, 2025` | unchanged | Invalid full date; no yearless fallback. |
| `Tue, 28 Jul 2026 18:00:58 +0000` | `Tue, 2026-07-28 18:00:58 +0000` | Weekday, 24-hour time, and offset are outside the match. |
| `星期二, 28 Jul 2026 01:00 PM +08:00` | `星期二, 2026-07-28 13:00 +08:00` | Arbitrary weekday text and offset remain untouched. |
| `07:59AM` | `07:59` | Time spacing is optional. |
| `07:59:59.123 AM` | unchanged | Fractional-second envelope is refused. |
| `Already 2026-07-28 18:00:58Z` | unchanged | No supported input form. |
| `href="/archive/Jan 1"` | attribute unchanged | Attributes are never scanned. |

### 6.5 Scanner implementation

Use a small deterministic state machine rather than a general date library or `Date.parse()`:

- month names map through the fixed table above;
- numeric fields are parsed from ASCII digits only;
- token boundaries are evaluated by Unicode code point, not individual UTF-16 code units;
- leap-year and field validation use explicit integer arithmetic;
- candidate selection is longest-envelope-first;
- recognized invalid envelopes return `REFUSE`, not `NO_MATCH`;
- the scanner advances monotonically and has linear time complexity; and
- unchanged input follows a no-output-buffer path where practical.

`Date.parse()` is prohibited because informal parsing is implementation-dependent, locale-sensitive, and too permissive. `Intl` is unnecessary because no locale conversion occurs.

The conceptual interfaces are:

```text
scanAt(input, start) -> REPLACE | REFUSE | NO_MATCH
transformText(input) -> string
```

Both are pure functions with no DOM, locale, current date, timezone, browser, or extension-API dependency. This separation is the primary correctness and testability boundary.

## 7. DOM processing design

### 7.1 Data flow

```text
static content script in each permitted frame
        |
        v
document.contentType gate ---------------------> stop for non-HTML/XHTML
        |
        v
queue initial document + discover open shadow roots
        |
        v
TreeWalker yields eligible Text nodes
        |
        v
pure transformText(Text.data)
        |
        v
write Text.data only when changed
        ^
        |
MutationObserver coalesces added/changed nodes
```

### 7.2 Injection and frames

Use a static Manifest V3 content script with:

- `matches`: HTTP and HTTPS pages only;
- `run_at`: `document_idle`;
- `all_frames`: `true`;
- `match_about_blank`: `true`; and
- `match_origin_as_fallback`: `true` where supported by the selected minimum browser versions.

The default isolated execution world must be retained. The extension does not need access to page JavaScript variables and must not select the main world.

Related `about:blank`, `about:srcdoc`, `data:`, and `blob:` frames may inherit eligibility from a permitted parent under the two frame-matching options. Their own `document.contentType` gate still applies. Direct top-level schemes other than HTTP(S) are out of scope.

### 7.3 Node eligibility

A `Text` node is eligible only when all of these are true:

1. it is connected to the current document or an observed open shadow root;
2. it has a parent element;
3. it is under the document body (or equivalent body content in XHTML), not `<head>`;
4. its data passes a cheap prefilter for a supported month or meridiem token;
5. no ancestor within the current tree is a non-content container; and
6. it is not in an editable surface.

Non-content containers are identified by lowercased `localName`, with namespace-aware handling where needed:

```text
script, style, noscript, template, textarea, option, title, head
```

Editable surfaces include:

- an element for which `isContentEditable` is true;
- descendants of an effective `contenteditable` editing host; and
- conservative editor widgets such as an ancestor with `role="textbox"`.

The editor rule is intentionally broader than the text-node-only rule because rich editors such as Monaco, CodeMirror, and Ace often render model text as ordinary spans. Rewriting those spans can desynchronize the editor's model, cursor, and screen.

Do not use `innerHTML`, `outerHTML`, `innerText`, or `outerText` setters. Updating only `Text.data` preserves the element tree, attributes, event handlers, and unrelated text nodes, and cannot turn page text into executable markup.

### 7.4 Initial traversal

Create a `TreeWalker` with `NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT`. Its filter:

- returns `FILTER_REJECT` for excluded elements, pruning their descendants;
- inspects eligible elements for an open `shadowRoot`, queues a newly discovered root, and returns `FILTER_SKIP` so traversal continues into light-DOM children; and
- returns `FILTER_ACCEPT` for text nodes.

The drain consumes only accepted text nodes. Using `SHOW_TEXT` alone would be insufficient because the filter would never see an excluded element and therefore could not prune that subtree.

Traversal is incremental. A drain performs work until either a node-count limit or a short elapsed-time budget is reached, then yields via `requestIdleCallback` where available, with a bounded-time fallback based on `setTimeout`. It must not use an unbounded microtask loop because that can starve rendering and input.

Provisional tuning targets, to be calibrated on Android hardware, are:

- at most 4 ms of extension work in one foreground slice on desktop;
- at most 2 ms in one foreground slice on Android;
- an idle callback timeout so a continuously busy page still converges; and
- no whole-document rescan in response to an ordinary subtree mutation.

These are scheduling targets, not assumptions in correctness tests.

### 7.5 Mutation processing

Each observed root uses one `MutationObserver` configured with:

```text
subtree: true
childList: true
characterData: true
attributes: false
```

For each delivery:

- enqueue the target of a relevant `characterData` record;
- enqueue each added `Text` node directly;
- enqueue each added element/subtree for incremental traversal;
- ignore removed nodes;
- discard queued nodes that are disconnected when eventually processed; and
- collapse child work when an ancestor subtree is already queued.

The observer deliberately ignores attributes in the recommended render-candidate model. Attribute observation on dynamic applications is noisy and is needed only for a strict current-visibility policy.

Extension writes also create `characterData` records. Track the last extension-produced value per node in a `WeakMap<Text, string>`:

- if a later record still has that exact value, it is already normalized and can be skipped;
- if the page changed the value before delivery, the differing current value is processed; and
- weak keys ensure removed nodes do not stay alive.

Idempotence is still mandatory and is the ultimate loop defense. The weak map avoids redundant work; it is not allowed to change transformation semantics.

Coalescing and a fixed time budget provide backpressure during mutation storms. If the work queue exceeds a tested threshold, it should replace many descendant entries with the smallest safe common roots, not drop content silently. A malicious or defective page can always consume its own main thread, but the extension must not multiply the cost of each mutation.

### 7.6 Text split across DOM nodes

Version 1 transforms one `Text` node at a time. Therefore this transforms:

```html
<span>Jan 1, 1990</span>
```

but not this visually identical fragment:

```html
<span><b>Jan</b> 1, 1990</span>
```

Supporting cross-node matches is possible but not a small extension of the algorithm. The replacement has a different length and structure, so it is unclear which element should own each output character. For example, preserving character ownership could produce `<b>199</b>0-01-01`, while replacing the parent can destroy links, styling, listeners, selections, and framework-managed node identity. Translation extensions can accept that tradeoff because they replace entire phrases; this extension's narrow, in-place correctness goal argues against it.

Version 1 deliberately misses split dates rather than restructuring privileged pages. If cross-node support is required later, it needs a separate DOM-range design, explicit style/selection semantics, and application compatibility tests.

### 7.7 Shadow DOM

During each traversal, discover and queue `element.shadowRoot` when it is an open root, then attach an observer to that root. Do the same for newly added elements and their descendants.

Two cases cannot be covered without invasive behavior:

- closed shadow roots are intentionally inaccessible; and
- an open shadow root attached later to an already-connected host does not necessarily create a light-DOM mutation that the document observer can use to discover it.

Patching `Element.prototype.attachShadow` in the page's main world would improve discovery but is rejected. It expands the security boundary, can conflict with the application, and requires page-world communication. Periodic full scans are also rejected for version 1. These rare shadow cases are documented limitations.

## 8. Extension structure and manifests

### 8.1 Proposed source layout

```text
src/
  transform.js          pure parser/formatter
  content.js            DOM traversal, scheduling, observation
manifests/
  chrome.json
  firefox.json
test/
  transform.test.js
  dom.test.js
  fixtures/
scripts/
  package.mjs           deterministic packaging, if needed
```

The implementation may combine the two source files in a release without minification, but the source boundaries should remain visible. A bundler is unnecessary if files are listed in dependency order in `content_scripts.js` or a small checked-in build is generated deterministically.

### 8.2 Minimal manifest shape

The shared/Chrome manifest is conceptually:

```json
{
  "manifest_version": 3,
  "name": "RFC3339ify",
  "version": "0.1.0",
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": ["transform.js", "content.js"],
      "run_at": "document_idle",
      "all_frames": true,
      "match_about_blank": true,
      "match_origin_as_fallback": true
    }
  ]
}
```

The Firefox artifact adds current Mozilla signing, disclosure, and Android-availability metadata:

```json
{
  "browser_specific_settings": {
    "gecko": {
      "id": "rfc3339ify@example.invalid",
      "strict_min_version": "<minimum-supported-Firefox>",
      "data_collection_permissions": {
        "required": ["none"]
      }
    },
    "gecko_android": {}
  }
}
```

The identifier shown is a placeholder. Select a stable, non-personal identifier before the first signed build and never change it afterward. Select `strict_min_version` from the oldest Firefox desktop/Android version in the tested release matrix. `required: ["none"]` declares the design's no-data-collection behavior; adding another data category requires security and privacy review. `gecko_android: {}` makes Android availability explicit when no Android-specific version override is needed.

Keep Firefox-specific keys out of the Chrome artifact if Chrome's validator warns about them. Manifest generation must be deterministic and tested against both store validators.

Do not declare:

- a background/service-worker script;
- `tabs`, `scripting`, `storage`, `webRequest`, cookies, downloads, clipboard, history, or identity permissions;
- web-accessible resources;
- externally connectable endpoints;
- an extension page or action unless a later, reviewed configuration requirement justifies one; or
- explicit host permissions duplicated beyond what the static content-script match patterns require.

### 8.3 Site-access tradeoff

Automatic operation on every ordinary website inherently requests permission to read and change those pages. Restricting match patterns to `http://*/*` and `https://*/*` is narrower than `<all_urls>` because it excludes `file:`, FTP-like schemes, and direct local files, but it is still broad and will produce a prominent store permission warning.

Version 1 uses broad static access. This is the smallest implementation, works at page load and in frames, and lets users apply browser-provided site-access controls where available.

A future user-selected-sites mode would require optional host permissions plus registration/injection machinery and a UI. It could reduce default exposure but would add a service worker, state, extension APIs, more browser differences, and a failure mode where dates appear unconverted until access is granted.

The release description must be explicit that the extension code changes page text locally and never transmits it. Host-page code can still observe and react to the mutation as described in sections 9.3 and 15. Enterprise administrators can deploy an allowlist through browser policy if all-site access is unacceptable.

## 9. Security and privacy model

### 9.1 Protected assets

- Credentials, CSRF tokens, account data, repository data, and operational information present in privileged page DOMs.
- Integrity of page controls and application state.
- Browser performance and availability.
- Extension update and release integrity.

### 9.2 Threats

- A malicious page supplies pathological text or mutation patterns.
- A legitimate SPA reacts badly to third-party text mutations.
- A compromised dependency or update exfiltrates broad page access.
- Text is misparsed and changes the apparent meaning of an operational timestamp.
- Another extension rewrites the same node and creates a loop.
- A page detects the normalized text and fingerprints the installed extension.

### 9.3 Controls

- **No production dependencies:** removes the largest avoidable supply-chain surface.
- **No network primitives:** production source must not call `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, dynamic import, or DOM-based resource injection.
- **No persistence or telemetry:** no page content, hostname, match count, or error is stored or sent. Diagnostic builds must not be published.
- **Isolated world:** no page-world globals, monkeypatches, injected `<script>`, or `postMessage` bridge.
- **Text-only writes:** setting `Text.data` cannot create markup, event handlers, navigation, or script execution.
- **Fixed linear parser:** no backtracking-heavy user-controlled regular expression and no generic date parser.
- **Bounded scheduling:** yields during large traversals and coalesces mutation work.
- **Fail-closed grammar:** invalid and unsupported forms remain unchanged.
- **Readable artifact:** do not minify or obfuscate release JavaScript. Include only the manifest, icons/license if needed, and the two small scripts.
- **Deterministic release:** pin development tools, commit the lockfile if tools are introduced, generate both packages in CI, publish hashes, and verify that store artifacts match tagged source.
- **Browser-enforced site access:** document how users/administrators can restrict or disable the extension per site/browser.

No extension can prevent the host page from observing its DOM changes. A site can compare text content, detect normalization, or react through its own `MutationObserver`. The extension therefore does not promise invisibility to pages.

### 9.4 Auditing checks

CI should fail if release source contains or declares unexpected capabilities, including:

- networking APIs or remote URL literals;
- `eval`, `Function`, dynamic import, or remotely hosted code;
- `innerHTML`/`outerHTML` writes;
- page-world execution;
- added manifest permissions, service workers, or web-accessible resources; or
- files outside an explicit release allowlist.

These checks supplement review; simple string scans alone are not a security proof.

## 10. Correctness and compatibility risks

### 10.1 Application/framework conflicts

React, Vue, Angular, and similar systems may keep an expected text value in application state. Direct DOM changes do not update that state. A later render can restore the original string; the observer will normalize it again. Usually this converges after each application update, but page observers may notice both changes.

The extension must not pretend it can make DOM mutation consequence-free. Possible effects include:

- a page copying `textContent` for business logic receives the normalized value;
- test automation or selectors based on exact text stop matching;
- live-region text changes may be announced by assistive technology;
- selection offsets can shift when a replacement changes length; and
- a page and another extension can repeatedly overwrite one another.

A per-node rate guard prevents an extension/extension or extension/page ping-pong from consuming the main thread. It counts only **external overwrites**: after the extension has normalized a node, the page or another extension changes that same node to a value that would require another extension write. Initial normalization and observer records caused by the extension's own `Text.data` write do not count.

Use test-calibrated constants with these initial semantics:

- four external overwrites within a rolling two-second window are allowed;
- the next attempted rewrite enters a ten-second cooldown and leaves the current page value unchanged;
- one shared, one-shot scheduler retries the node after cooldown rather than running a periodic timer;
- retry resets the short-window count and processes the then-current value once;
- a new external overwrite after another conflict can start a new cooldown;
- disconnected nodes are discarded; and
- cooldown state is document-local, contains no text/history beyond timestamps and the node reference, and is cleared when the document is destroyed.

The shared scheduler uses a `Map` capped at 1,024 cooldown nodes so it can enumerate due retries without retaining an unbounded number of DOM nodes. If that cap is reached, additional conflicting nodes are left unchanged until a later external mutation requeues them; normal non-conflicting nodes continue to work. Tests must cover cooldown recovery, cap behavior, disconnected-node cleanup, and framework reuse of the same `Text` node for unrelated later content.

### 10.2 Semantic false positives

`May` is both a month and a common word; `Jan`, `Mar`, and other tokens can also be names or identifiers. Even a valid-looking `May 1` may be a release name rather than a calendar date. Code blocks and logs increase this risk.

The conservative grammar, boundary rules, validation, and node-local matching reduce false positives but cannot eliminate semantic ambiguity. There is no reliable context-free method to distinguish all prose dates from identifiers. Site allowlists, skipping code, or a user toggle are product controls if review finds the residual risk unacceptable.

### 10.3 Copying and accessibility

The normalized string becomes the actual DOM text. Copy, find-in-page, screen readers, and page scripts normally see the normalized form. This is necessary for an authentic rendered-text replacement but should be stated in store documentation.

An overlay or CSS-only visual substitution would preserve original DOM text but is not recommended: it is difficult to lay out, inaccessible, incompatible with selection/copy, and far heavier.

### 10.4 Other extensions and translation tools

Observer ordering is unspecified. A translation extension may translate month names before this extension sees them, causing a miss, or after this extension has produced a numeric date. Numeric output is intentionally outside this transformer's input grammar, which makes cooperation normally idempotent. An extension that converts numeric dates back to English can cause a loop; the rate guard limits damage.

### 10.5 Restricted pages and frames

Browsers prohibit content scripts on their own settings pages, extension stores, and some vendor-protected origins. Sandboxed or special-scheme frames can also be inaccessible. This is a platform restriction, not an extension bug. Tests and user documentation must not claim “all pages” without this qualification.

### 10.6 Plain-text detection risk

Only MIME type is authoritative. The test suite must use a real HTTP server returning `Content-Type: text/plain`, not merely place text in a `<pre>` inside HTML. XHTML must likewise be served as `application/xhtml+xml`; a file named `.xhtml` served as HTML exercises a different parser and content type.

## 11. Performance design and budgets

### 11.1 Fast path

Most text nodes contain no candidate. Before invoking the full scanner, check cheaply for one of the accepted month prefixes/casings or for a colon plus a possible `A`, `a`, `P`, or `p` meridiem sequence. The prefilter must cover no-space and dotted meridiem forms and must have no false negatives for the accepted grammar. Do not lowercase every node or allocate a normalized copy.

When there is no match:

- make no DOM write;
- create no output string/buffer where practical; and
- retain no reference to the node after queue processing.

### 11.2 Large nodes

A single huge HTML text node can defeat a per-node time budget. The lexer must therefore expose resumable state: current input offset, current recognizer/envelope state, and already-produced output pieces. It may yield between code points/tokens and resume without rescanning a growing prefix. This is preferable to fixed-overlap chunks because an invalid numeric suffix can contain an arbitrarily long digit run even though accepted tokens have fixed lengths.

Before writing the completed result, verify that the node still contains the original input/generation. If the page changed it during a yielded scan, discard the stale result and queue the current value. The stale result must never overwrite newer page content.

An arbitrary size cutoff is not recommended because it creates silent correctness gaps on large log/code views. A documented emergency cap may be added only after memory tests demonstrate a concrete need.

### 11.3 Provisional acceptance budgets

Benchmarks should include a desktop browser and a mid-range Android Firefox device/emulator. Proposed release gates are:

- no extension-caused task longer than 16 ms in the standard large-page fixture;
- traversal slices meet the 4 ms desktop / 2 ms Android targets at the 95th percentile;
- a 100,000-text-node, 5 MiB fixture converges without input becoming unresponsive;
- mutation cost scales with changed/added subtrees rather than total document size;
- steady state creates no timer loop and near-zero CPU use when the DOM is idle; and
- packaged code remains on the order of tens of KiB, excluding icons and test tooling.

Exact total convergence time is hardware-dependent and less important than responsiveness. Record benchmark hardware, browser version, fixture, median, and 95th-percentile results in a checked-in report before release.

## 12. Test strategy

### 12.1 Pure transformer tests

Table-driven positive tests cover:

- every accepted spelling/casing for all twelve months, including all nine `sep`/`sept`/`september` variants;
- one- and two-digit days/hours, including zero-padded inputs;
- month-first and day-first dates without years;
- month-first/day-first `YEAR4` with and without a comma;
- month-first and day-first `YEAR2`, each with and without a comma;
- literal unknown-century outputs such as `??99-12-31`;
- leap years (`2000`, `2024`), non-leap century/year cases (`1900`, `2025`), and possible/impossible `YEAR2` leap days;
- midnight, noon, every approved meridiem spelling, zero/eight-character time spacing, seconds `59`, and syntactically accepted seconds `60`;
- multiple independent matches in one string;
- weekday and timezone preservation; and
- every supported whitespace character plus runs of exactly one and eight code units.

Negative tests cover:

- `Jan 0`, `Jan 32`, `Apr 31`, `Feb 30`, impossible `YEAR2` leap dates, and invalid `YEAR4` leap dates;
- `00:00 AM`, `13:00 PM`, `01:60 PM`, seconds `61`, and malformed time fields;
- mixed-case months, ordinals, unsupported month/meridiem spellings, and fractional seconds;
- numeric year suffixes of one, three, or five-plus digits and malformed comma placement;
- recognized invalid/unsupported larger dates, including `Feb 29, 2025`, `Jan 1, 123`, and `Mon Sep 17 00:00:00 2001`, which must not partially rewrite;
- identifier adjacency such as `fooJan 1`, `éJan 1`, `变量Jan 1`, `Jan 1st`, and `AM_variable`;
- runs of nine accepted whitespace code units;
- already normalized ISO/RFC-like dates and 24-hour times; and
- random Unicode surrounding text.

Property/fuzz tests assert:

- `transformText(transformText(s)) === transformText(s)`;
- the function never throws for arbitrary JavaScript strings, including lone surrogates;
- output outside reported replacement spans is unchanged;
- `REFUSE` copies the entire recognized envelope unchanged and prevents inner/prefix matches;
- `YEAR4`, `YEAR2`, and yearless precedence is respected, including invalid-longer-form refusal;
- every emitted month/day/time field satisfies its range; and
- runtime grows approximately linearly with input size.

### 12.2 DOM unit tests

Using real DOM fixtures, verify:

- only `Text.data` changes and element/attribute identity is stable;
- excluded containers and editable surfaces remain untouched;
- visible labels, HTML `<pre>/<code>`, ARIA live regions, inline SVG, and open shadow roots are transformed;
- `<option>`, non-content containers, and editable/editor surfaces remain unchanged;
- split-node dates remain unchanged;
- initial and dynamically added content converge;
- direct `characterData` edits converge;
- extension-generated mutation records do not loop;
- removed/reattached nodes do not leak or throw;
- burst additions are coalesced;
- a simulated framework overwrite is handled and rate-limited if adversarial; and
- cooldown expires through the shared one-shot scheduler and a reused text node becomes eligible again.

### 12.3 Browser integration tests

Run the same fixtures in current supported versions of:

- Chrome desktop;
- Firefox desktop; and
- Firefox Android on an emulator or physical device.

A local HTTP server must serve separate routes with these MIME types:

- `text/html` — transformed;
- `application/xhtml+xml` — transformed;
- `text/plain` — untouched even if the browser creates an HTML-shaped viewer;
- an HTML parent with a plain-text iframe — parent transformed, frame untouched; and
- allowed and special related frames (`about:blank`, `srcdoc`, `blob:`) as browser support permits.

Also test CSP and Trusted Types pages, cross-origin frames under a second local origin, back/forward cache restoration, SPA updates, large virtualized lists, and sites with open shadow DOM.

Representative manual compatibility checks should include non-destructive views on GitHub and the Cloudflare dashboard. Tests must avoid changing real settings or submitting forms.

Chrome Android testing should instead verify/document the platform non-support; it is not meaningful to claim a passing extension test on official Chrome Android.

### 12.4 Security/release tests

- Lint both manifests and build/load them as unpacked extensions.
- Run Mozilla's official extension linter for the Firefox artifact.
- Verify the Firefox artifact declares its stable Gecko ID, `required: ["none"]`, and `gecko_android` metadata.
- Inspect the final ZIP contents against a file allowlist.
- Compare two clean builds for reproducibility.
- Search release code for prohibited network, eval, HTML-sink, and page-world facilities.
- Confirm in browser developer tools that the idle extension makes no network requests and has no background process.
- Review every permission diff as a release-blocking change.

## 13. Dependencies and tooling

### 13.1 Runtime

Runtime dependencies: **none**.

A date library would add size and permissive/locale-dependent behavior without helping the narrow grammar. A DOM framework, compatibility wrapper, or polyfill is also unnecessary for the selected APIs.

### 13.2 Development

Prefer Node's built-in test runner for the pure transformer and small build scripts. Browser automation may use a pinned, reputable tool such as Playwright, and Firefox packaging/linting may use Mozilla's `web-ext`; both remain development-only and are excluded from store artifacts.

If npm dependencies are introduced:

- pin versions through a committed lockfile;
- enable automated vulnerability/license review;
- avoid install scripts unless separately justified;
- build in a clean, locked CI environment; and
- prove the extension ZIP contains no `node_modules` or development code.

## 14. Observability and user control

Production telemetry and page-content logging are prohibited. A simple content script also has no safe reason to print matches to the browser console, where sensitive page text or noisy logs could appear.

For support, diagnostics should be reproducible with public fixture pages and version/build identifiers. A temporary developer build may expose aggregate counters locally, but it must be clearly branded, never published to stores, and never log matched strings.

Version 1 relies on browser extension controls to disable the extension or restrict site access. A built-in per-site toggle is not recommended initially because it requires UI, storage, current-tab access, and cross-browser state synchronization. It can be designed later if field testing shows that browser controls are insufficient.

## 15. Implementation and release plan

1. Freeze the resolved decisions in section 16 and the exact section-6 grammar as positive/negative test tables.
2. Implement the pure scanner and exhaustive unit/property tests.
3. Implement the MIME gate and node-local DOM engine without mutation observation; verify DOM integrity.
4. Add chunked scheduling, shadow-root discovery, mutation coalescing, and loop/rate guards.
5. Generate minimal Chrome and Firefox manifests and load both unpacked.
6. Add real-MIME browser fixtures, cross-frame tests, large-page benchmarks, and Android Firefox coverage.
7. Perform a manual security review of the complete release artifact and permission diff.
8. Run a limited canary on representative read-only GitHub/Cloudflare pages, recording false positives and framework conflicts without collecting page data.
9. Publish signed store artifacts from a tagged, reproducible build with hashes and a plain-language privacy statement.

To stop future rewriting, disable/uninstall the extension or revoke its site access, then reload every affected tab. Disabling alone does not undo `Text.data` changes already present in a live document; a page rerender may also restore them.

The extension itself performs no network or storage operation, but it cannot guarantee that changes remain client-only. Host-page code can observe the DOM mutation, react to it, copy normalized text into application state, or transmit/persist that state. Reloading is therefore a DOM rollback, not a guarantee that an application-side or server-side reaction can be reversed. Conservative parsing and canary testing remain necessary on privileged sites.

## 16. Resolved product decisions

The following decisions are authoritative for version 1 and are incorporated into the normative sections above:

1. **Rendered-text scope:** process render-candidate DOM text as defined in section 5.2. Exclude JavaScript, CSS, attributes, WebSocket data before it becomes DOM text, editable/editor surfaces, and the other non-content containers in section 7.3. CSS-hidden render-candidate text may still be processed.
2. **Code and logs:** transform text inside HTML `<pre>` and `<code>` elements. The MIME gate still leaves a `text/plain` raw patch untouched. A future release may add reviewed exclusion rules.
3. **DOM boundaries:** matching is node-local. Dates split across multiple `Text` nodes are intentionally missed.
4. **Month spellings:** accept only the explicit abbreviations/full names and the lowercase/title-case/uppercase variants in section 6.1. Arbitrary mixed case and non-English month names are out of scope.
5. **Years:** accept two- and four-digit years in both month-first and day-first forms with an optional comma. Render `YEAR2` with a literal unknown-century prefix as `??YY`.
6. **Yearless dates:** both `Jan 1` and `1 Jan` become `01-01`; the unknown year is not inferred.
7. **Times:** accept the exact meridiem forms in section 6.1 with zero through eight whitespace characters. Preserve syntactic second `60`; refuse fractional seconds.
8. **Whitespace:** one through eight accepted whitespace code units form a date separator. Nine or more do not match. Time/meridiem separation permits zero through eight.
9. **Site access:** enable automatic static content-script access on all HTTP and HTTPS sites, subject to browser-protected-origin restrictions and user/administrator site controls.
10. **Browser coverage:** release gates are Chrome desktop, Firefox desktop, and Firefox Android. Official Chrome Android is unsupported because it cannot run the extension.
11. **Accessibility:** transform ARIA live-region text, accepting that a mutation can trigger an announcement.
12. **Options:** exclude every `<option>` text subtree because label mutation can change the submitted value when no explicit `value` exists.


## 17. Acceptance criteria

The first release is acceptable when:

- all approved grammar examples and negative cases pass identically in the three supported browser targets;
- HTTP(S) `text/plain` fixtures, including a raw patch, are demonstrably untouched;
- HTML and XHTML fixtures transform only eligible text nodes and preserve all attributes/elements;
- dynamic mutations converge without self-triggered loops or long tasks;
- documented iframe and open-shadow cases work, and inaccessible cases are accurately described;
- the final manifests request no capability beyond static HTTP(S) content-script access;
- the Firefox manifest passes AMO validation with its stable ID, `required: ["none"]`, `gecko_android`, and tested minimum version;
- the artifact contains no production dependency, background worker, network code, telemetry, remote code, or page-world injection;
- performance budgets pass on recorded desktop and Android test hardware;
- security and permission review finds no unexplained artifact or capability; and
- store/user documentation clearly discloses broad page-text access, local DOM modification, plain-text exclusion, restricted-page limits, and the lack of Chrome Android support.

## 18. Reference material

- [Chrome Extensions: content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome manifest `content_scripts` reference](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)
- [Chrome Web Store Help: install and manage extensions](https://support.google.com/chrome_webstore/answer/2664769) — describes desktop installation and the phone “Add to Desktop” workflow.
- [MDN: `content_scripts`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts)
- [MDN: `browser_specific_settings`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)
- [MDN: `Document.contentType`](https://developer.mozilla.org/en-US/docs/Web/API/Document/contentType)
- [MDN: `MutationObserver.observe()`](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/observe)
- [MDN: `Document.createTreeWalker()`](https://developer.mozilla.org/en-US/docs/Web/API/Document/createTreeWalker)
- [Mozilla Support: find and install add-ons on Firefox for Android](https://support.mozilla.org/en-US/kb/find-and-install-add-ons-firefox-android)
