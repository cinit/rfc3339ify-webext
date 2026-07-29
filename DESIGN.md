# RFC3339ify WebExtension: detailed design

Status: Core and global-control implementation complete; release validation gates remain

Date: 2026-07-29

Target: Manifest V3 WebExtension for Chrome desktop and Firefox desktop/Android

## 1. Executive summary

The extension rewrites a deliberately small set of English, human-readable date and 12-hour time forms contained within eligible individual DOM `Text` nodes. Examples include:

| Input | Output |
| --- | --- |
| `Jan 1` | `01-01` |
| `Jan 1, 1990` | `1990-01-01` |
| `12 Jan 23` | `??23-01-12` |
| `01:00 PM` | `13:00` |
| `01:02:03 AM` | `01:02:03` |
| `Tue, 28 Jul 2026 18:00:58 +0000` | `Tue, 2026-07-28 18:00:58 +0000` |

The recommended runtime is a small set of readable, dependency-free scripts. It:

1. runs in the browser's isolated extension world;
2. exits unless `document.contentType` is `text/html` or `application/xhtml+xml`;
3. reads one install-local Boolean to decide whether normalization is enabled;
4. walks eligible DOM `Text` nodes without reading or rewriting HTML while enabled;
5. applies a deterministic, locale-independent scanner;
6. changes only `Text.data` when the output differs; and
7. watches later DOM mutations in bounded, coalesced batches while enabled.

An action popup provides a persistent global on/off switch on Chrome and Firefox desktop and through Firefox Android's Add-ons menu. The switch uses `storage.local` and stores only one Boolean; it does not store page text, hostnames, match counts, or browsing history. There is no background/service-worker process, remote code, telemetry, network access, page-world injection, or production dependency. This keeps the extension small and makes its behavior on sensitive sites such as GitHub and the Cloudflare dashboard practical to audit.

One requested target is not currently feasible: official Google Chrome on Android does not run Chrome Web Store extensions. Google documents extensions as a desktop customization; its phone workflow only queues an extension for installation on a desktop computer. The same WebExtension can target Chrome desktop and Firefox desktop/Android, but it cannot target official Chrome Android until Google exposes an extension platform there. Extension-capable Chromium forks on Android are a possible unsupported test target, not a Chrome Android deliverable.

## 2. Goals

### 2.1 Functional goals

- Normalize the explicitly supported date and time forms contained within each eligible individual `Text` node of live HTML and XHTML documents.
- Preserve text outside the matched date/time span code-unit-for-code-unit.
- Preserve weekday text, punctuation outside a match, timezone names, and timezone offsets. Weekdays are not parsed at all, so both `Tue` and strings such as `星期二` remain unchanged.
- Process content inserted or changed after initial page load, including single-page application navigation, virtualized lists, and delayed API results.
- Process matching same-origin and cross-origin subframes when the extension has access to those frame URLs.
- Leave HTTP(S) resources served as `text/plain` untouched, even when the browser displays them in a generated `<pre>` element.
- Produce the same result on all supported browsers and independently of the browser, page, or operating-system locale.
- Be idempotent: applying the transformer twice must produce exactly the same result as applying it once.
- Let the user persistently enable or disable future normalization across all eligible pages in the current browser profile/extension installation, without normally requiring a tab reload.

### 2.2 Security and quality goals

- Minimize requested browser privileges and the amount of long-lived code executing on every page.
- Make the release artifact readable and small enough for direct source review.
- Never evaluate page text as HTML or JavaScript.
- Never transmit, persist, or log page content; persist only the global enabled Boolean.
- Avoid unbounded synchronous DOM walks and catastrophic regular-expression behavior.
- Fail closed on unsupported or ambiguous syntax: leaving text unchanged is preferable to a plausible but incorrect conversion.
- Avoid page layout reads in the normal path so that the extension does not cause repeated style/layout calculation.

## 3. Non-goals

- Converting arbitrary natural-language dates, relative dates (`yesterday`, `2 hours ago`), numeric regional dates (`1/2/26`), or non-English month names.
- Verifying that an input weekday agrees with its date. A mismatched `Tue` is still preserved.
- Converting timezone offsets, timezone abbreviations, or local time to UTC.
- Producing a complete RFC 3339 timestamp. The name “RFC3339ify” describes the preferred numeric style; outputs such as `01-01` omit a year and `??23-01-12` explicitly marks an unknown century, so neither is RFC 3339.
- Changing DOM attributes, form values, placeholders, accessibility labels, metadata, JSON, scripts, styles, network responses, clipboard contents, or downloaded files.
- Changing browser-owned page content or native UI beyond the standard extension action popup, including PDF viewer content, extension-store pages, browser-protected pages, or other locations where content scripts are prohibited.
- Reading text drawn into a `<canvas>`, CSS-generated `::before`/`::after` content, browser-native form-control UI, or inaccessible closed shadow roots.
- Parsing a date whose visible characters are split across multiple DOM `Text` nodes in version 1. This limitation is discussed in section 7.6.
- Supporting official Chrome on Android while Chrome itself lacks extension support.
- Providing per-site, per-tab, schedule-based, or synchronized cross-device enable rules in version 1.
- Reconstructing text that was already normalized before the extension was switched off.

## 4. Feasibility and browser support

| Platform | Proposed support | Notes |
| --- | --- | --- |
| Chrome desktop | Supported | Manifest V3 static content script; minimum Chrome 99 for `match_origin_as_fallback`. Chrome-protected URLs remain inaccessible. |
| Chromium desktop derivatives | Best effort | Expected to work where ordinary Chrome MV3 extensions work; only named browsers are release gates. |
| Firefox desktop | Supported | Manifest V3 WebExtension using the same content-script source; minimum Firefox 140 for the required data-collection declaration. |
| Firefox for Android | Supported | The same Firefox MV3 artifact, distributed through Mozilla Add-ons and tested on a physical device or emulator; minimum Firefox for Android 142. |
| Chrome for Android | Not feasible | Official Chrome Android cannot install/run this extension. “Add to Desktop” from a phone installs it later on desktop, not on the phone. |
| Android Chromium forks with extension support | Unsupported | May work, but their manifest/API/store compatibility and maintenance are outside the threat model and release matrix. |
| Safari/iOS | Out of scope | Would require a separate packaging, signing, and compatibility effort. |

The transformer and DOM controller use only mature DOM APIs (`MutationObserver`, DOM parent/sibling traversal, `WeakMap`, and ordinary string operations). Browser-specific extension-API code is confined to the small settings/bootstrap/popup boundary, generated manifests, packaging metadata, and development-only browser tests.

### 4.1 Firefox Android manifest decision

Mozilla's official Firefox Extension Workshop currently recommends Manifest V2 for extensions targeting Firefox for Android because Android does not have full desktop MV3 feature parity. The cited guidance was last updated on 2023-11-12 and identifies three concrete limitations: background service workers are unavailable, pending runtime host-permission requests lack a visible indication, and users cannot edit host-permission grants in Android's Add-ons Manager.

Version 1 nevertheless uses one Firefox MV3 artifact for desktop and Android:

- it has no background script or service worker;
- it uses a static content script and never makes a runtime permission request;
- its `action` popup and `storage.local` setting are supported without a background context; and
- one artifact avoids divergent manifests, signing channels, version histories, and Android-only parser builds.

The inability to edit host grants on Firefox Android still applies. Installation, acceptance and denial of the static all-sites grant, actual content-script injection, action-popup presentation, and the resulting permission UI are release gates on a real Android installation. The built-in global switch provides a routine whole-extension pause without depending on Android's host-grant UI. Browser-level disabling or uninstalling remains the emergency fallback.

Do not create an MV2 build preemptively. If real-device testing exposes a concrete MV3 blocker, produce a separate generated Firefox Android MV2 package from the identical runtime source and design its AMO identity, listing/update channel, signing, version ordering, and migration path before publishing it. A single manifest/package cannot support MV2 and MV3 simultaneously.

The selected minima are Firefox desktop 140 and Firefox Android 142. `match_origin_as_fallback` requires Firefox 128, while the current `data_collection_permissions` declaration requires Firefox 140 on desktop and Firefox 142 on Android; the latter requirement determines the release floor. Raising either minimum later requires a compatibility and store-metadata review.

## 5. Proposed product behavior

### 5.1 Document gate

Every content-script instance performs this check before creating observers or traversing the DOM:

```text
if document.contentType is neither
    "text/html" nor "application/xhtml+xml"
then return permanently for this document

if window.top is window and location.protocol is neither "http:" nor "https:"
then return permanently for this document
```

The URL suffix is deliberately irrelevant. A `.txt` URL served as HTML is eligible; an extensionless URL served as `text/plain` is not. The response `Content-Type`, exposed by `document.contentType`, is the authoritative boundary.

This handles the motivating raw-patch case. Browsers commonly construct an internal HTML-shaped DOM to display `text/plain`, but `document.contentType` remains `text/plain`, so a DOM-shape or `<pre>` test would be incorrect.

The MIME gate is repeated independently inside every frame. Consequently, an HTML page may be transformed while an embedded plain-text frame is left alone. The second gate enforces the declared top-level scheme boundary even if a browser's origin-fallback matching injects into a top-level `blob:`, `data:`, or `about:` document. Comparing the current window object with `window.top` does not read cross-origin parent state. Related non-HTTP(S) subframes remain eligible and still pass through their own MIME gate.

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
| Text inside `<select>`, `<datalist>`, or `<option>` | Leave untouched | Without an explicit `value` attribute, changing an option label can also change the value submitted by a form; stray form-control text is not ordinary page content. |
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

Conversion is eventually convergent, not atomic. `document_idle` and bounded traversal mean the original spelling, or a mixture of original and normalized text on a large page, may be visible briefly. Version 1 does not hide the document or inject render-blocking CSS because doing so would increase page impact and failure risk. Store/user documentation must not promise flash-free conversion, and browser tests must measure time to convergence as well as individual task duration.

### 5.5 Install-wide enable switch

The extension provides one persistent setting named `globalEnabled`. “Global” means every eligible page and frame reached by this extension installation in the current browser profile. It does not mean synchronization across browser profiles, browsers, devices, or separate installations, and it does not grant access to protected pages where content scripts cannot run.

Use `storage.local`, not `storage.sync`. Local state is predictable, works on Firefox Android, and avoids inconsistent cross-browser promises: in particular, Firefox Android's sync storage is available as an API but is not synchronized through the Mozilla account. A separate private/incognito preference is out of scope. Where the browser permits the extension in private browsing and exposes the same extension-local storage, the same switch applies; this behavior must be verified on each release target before user documentation calls it profile-wide.

The setting is decoded conservatively:

| Stored state | Effective state |
| --- | --- |
| Key absent, including a new installation | Enabled |
| Boolean `true` | Enabled |
| Boolean `false` | Disabled |
| Any other stored type/value | Disabled |
| Storage read/API failure in a particular extension context | Disabled in that context |

An absent key deliberately preserves the product's default-on behavior and avoids an installation-time writer. Clearing all extension data therefore restores the default enabled state. A malformed value or API failure instead fails closed so an uncertain state cannot cause writes on a privileged page.

Switching off has these exact semantics:

- after a content-script context observes the new setting, it disconnects mutation observers, cancels queued callbacks and timers, discards pending scans, and performs no later `Text.data` write from that controller;
- the small storage listener remains alive so the same loaded document can be switched on again;
- text already changed in the live DOM is not reconstructed; and
- propagation to all tab/frame extension contexts is eventually consistent, not an atomic browser-wide transaction, so a context may finish work before it receives the change event.

Switching on creates a fresh DOM controller in every live eligible context that receives the event. Its initial traversal covers changes accumulated while the extension was off. Idempotence makes rescanning already-normalized text safe.

Normally neither direction needs a reload. A reload or navigation can still be required when the page predates extension injection, the extension was disabled and re-enabled through browser-native controls, Firefox Android discarded the extension context while retaining the page, or the page is otherwise inaccessible. Reloading requests a fresh rendering from the page; it is not a guarantee that application-side or server-side reactions to earlier DOM mutations can be reversed.

## 6. Transformation specification

### 6.1 Lexical tokens

Version 1 uses a deterministic scanner with a fixed, explicit token set. Grammar notation in this section is descriptive: brackets mean an optional token, `|` means an alternative, `*` means zero or more repetitions, `+` means one or more repetitions, and lookahead/boundary predicates do not consume input.

```text
ASCII_DIGIT := "0".."9"
DIGIT_RUN   := one or more ASCII digits, consumed maximally (recognition/refusal only)
DAY_FIELD   := DIGIT_RUN used in a structural date core (recognition/refusal only)
DAY         := one or two ASCII digits whose numeric value is 1..31
YEAR2       := exactly two ASCII digits, 00..99
YEAR4       := exactly four ASCII digits, 0001..9999
HOUR12      := one or two ASCII digits, 1..12
MINUTE      := exactly two ASCII digits, 00..59
SECOND      := exactly two ASCII digits, 00..60
WSP         := ASCII space | tab | CR | LF | form feed | U+00A0
SP          := WSP repeated 1..8 times
OSP         := WSP repeated 0..8 times
MERIDIEM    := AM | PM | am | pm | a.m. | p.m.
MERIDIEM_LIKE := one character from A/a/P/p followed immediately by M/m
                 | one character from A/a/P/p, ".", M/m, "."
```

`MERIDIEM_LIKE` does not absorb sentence punctuation after an undotted token. Thus the period in `07:59 AM.` is outside the envelope: `AM` is accepted and the result is `07:59.`. Fully dotted mixed/uppercase variants such as `A.M.` and `p.M.` are recognized only so they can be refused consistently.

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

- month/day combinations must exist in the proleptic Gregorian calendar;
- a `YEAR4` date uses the normal proleptic Gregorian leap-year rule for years `0001` through `9999`;
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

Fractional seconds are out of scope. For refusal, the recognizer uses this broader structural envelope:

```text
TIME_FIELD    := DIGIT_RUN
REFUSAL_FIELD := zero or more ASCII digits
time-envelope := TIME_FIELD (":" REFUSAL_FIELD)+
                 ["." DIGIT_RUN]
                 WSP* MERIDIEM_LIKE
```

The starting and ending Unicode boundaries in section 6.4 apply to the structural envelope. A failed starting boundary produces `NO_MATCH`; after a valid start, a failed ending boundary refuses the recognized envelope. `time12` is the accepted subset. The wider refusal form deliberately recognizes empty or extra colon fields so malformed input such as `01::03:04 PM` or `01:02:03:04 PM` cannot expose a plausible inner time. A structural envelope that has the wrong number of fields, an empty field, an invalid field width/value, more than eight whitespace characters, a fractional suffix, a merely meridiem-like token not in `MERIDIEM`, or a failed ending boundary returns `REFUSE` through the end of `MERIDIEM_LIKE`. Thus `07:59:59.123 AM`, `13:00 PM`, `07:59 P.M.`, and `07:59         AM` are unchanged as wholes. `DIGIT_RUN`, repeated colon fields, and `WSP*` can be arbitrarily long, so their recognition must participate in the resumable scan described in section 11.2.

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

For date suffix recognition, define:

```text
suffix-separators := a nonempty maximal run containing only WSP and ASCII ","
year-like-suffix  := suffix-separators DIGIT_RUN
```

The `DIGIT_RUN` is not year-like when its immediately following character is `:`; that is the explicit time-field discriminator. An accepted year suffix is the narrower exact form `SP YEARn` or `"," SP YEARn`, where `YEARn` is `YEAR4` or `YEAR2`: there is exactly zero or one comma, a comma is adjacent to the date core, and the `SP` run contains one through eight characters. The broader `year-like-suffix` exists only to prevent malformed or invalid long input from falling back to the yearless core.

`suffix-separators`, git-style `WSP+`, and their following digit runs are unbounded recognition constructs even though accepted separators and fields are bounded. They must be consumed monotonically with resumable state, not by an uninterruptible helper or by repeatedly rescanning the same prefix.

Date recognition follows these rules in order:

1. Require a valid starting Unicode boundary, then recognize a structural month-first or day-first core using `DAY_FIELD`, without consuming any trailing boundary character. A failed starting boundary is `NO_MATCH`. Only a one- or two-digit value in the `DAY` range can later be accepted; another maximal day run makes the structural core a refusal candidate rather than permitting a shorter inner day.
2. Inspect the explicitly recognized git-style time/year envelope before accepting the no-year core.
3. Consume `suffix-separators` and the following maximal `DIGIT_RUN`, if any. If the run is immediately followed by `:`, disregard it as a year suffix and continue to the yearless decision.
4. If the suffix has exact accepted syntax and the maximal digit run has four digits, try `YEAR4` first. A valid field, calendar date, and ending boundary produces `REPLACE`; any failure produces `REFUSE` from the core start through the digit run.
5. Only when the maximal digit run has two digits, try `YEAR2`. A valid field, possible calendar date, and ending boundary produces `REPLACE`; any failure likewise refuses the complete core-plus-suffix envelope.
6. Any other year-like suffix, including bad comma placement, a comma without a following `SP`, multiple commas, a separator run outside the one-to-eight limit, or a digit count other than two or four, returns `REFUSE` through the maximal digit run.
7. Only when no git-style or year-like suffix is present, consider the yearless form. A valid core and ending boundary produces `REPLACE`; an invalid structurally recognizable core or failed ending boundary returns `REFUSE` through the structural core. Following spaces, punctuation, and non-numeric words are not consumed.

Git-style refusal uses a broader structural production so invalid fields cannot expose the yearless prefix:

```text
git-like-envelope := structural-date-core WSP+
                     TIME_FIELD ":" TIME_FIELD [":" TIME_FIELD]
                     WSP+ DIGIT_RUN
```

After a valid starting boundary, every `git-like-envelope` is unsupported and returns `REFUSE` through its final maximal digit run, whether or not its fields would be valid. Thus `Mon Sep 17 00:00:00 2001` is unchanged rather than becoming `Mon 09-17 00:00:00 2001`, and malformed variants such as `Sep 17 99:00:00 2001` cannot expose `Sep 17`. When a time field follows a yearless date without a trailing git-style year, the date and 12-hour time are independent candidates.

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
| `Jan 1         1990` | unchanged | Nine separators make a recognized but invalid year envelope. |
| `Jan 1 1990x` | unchanged | The `YEAR4` ending boundary fails; no shorter fallback. |
| `Jan 1 123abc` | unchanged | The maximal three-digit year-like suffix is refused. |
| `Jan 1 , 1990` | unchanged | A comma separated from the core is invalid. |
| `Jan 1,, 1990` | unchanged | Multiple commas are invalid. |
| `Jan 1,1990` | unchanged | A comma without a following `SP` is invalid. |
| `Jan 1 0000` | unchanged | Year zero is outside `YEAR4`. |
| `Jan 1,01:00 PM` | `01-01,13:00` | The colon makes `01` a time field; date and time are independent candidates. |
| `Jan 1 123 Feb 2` | `Jan 1 123 02-02` | Refusal ends after `123`; the later date remains independently eligible. |
| `Jan 1st` | unchanged | Identifier/ordinal boundary fails. |
| `Feb 29, 2025` | unchanged | Invalid full date; no yearless fallback. |
| `Tue, 28 Jul 2026 18:00:58 +0000` | `Tue, 2026-07-28 18:00:58 +0000` | Weekday, 24-hour time, and offset are outside the match. |
| `星期二, 28 Jul 2026 01:00 PM +08:00` | `星期二, 2026-07-28 13:00 +08:00` | Arbitrary weekday text and offset remain untouched. |
| `07:59AM` | `07:59` | Time spacing is optional. |
| `07:59 AM.` | `07:59.` | Sentence punctuation is outside the plain meridiem token. |
| `07:59:59.123 AM` | unchanged | Fractional-second envelope is refused. |
| `07:59 P.M.` | unchanged | It is meridiem-like but not an accepted `MERIDIEM`. |
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
createTransform(input) -> TransformState
resumeTransform(state, maxScannerSteps) -> YIELD | DONE(string)
transformText(input) -> string  // test/convenience driver that resumes until DONE
```

`TransformState` includes the input, current offset, partially recognized candidate/envelope, and output pieces created only after the first replacement. One scanner step accounts for a bounded number of code-point inspections/state transitions; no token or refusal recognizer may hide an unbounded digit/whitespace loop inside one step. The DOM engine uses `createTransform`/`resumeTransform`; it must not call the synchronous convenience driver on an unbounded node. All three interfaces are pure with no DOM, locale, current date, timezone, browser, or extension-API dependency. This separation is the primary correctness and testability boundary.

## 7. DOM processing design

### 7.1 Data flow

```text
static content script in each permitted frame
        |
        v
document.contentType gate ---------------------> stop for non-HTML/XHTML
        |
        v
install storage listener, read globalEnabled
        |
        +---------------- disabled -------------> dormant bootstrap only
        |
        v enabled
start DOM controller and document MutationObserver
        |
        v
queue initial document + discover open shadow roots
        |
        v
bounded iterative DOM cursor yields Text nodes
        |
        v
pure resumable transform of Text.data
        |
        v
write Text.data only when changed
        ^
        |
MutationObserver coalesces added/changed nodes
```

The action popup is a separate extension page. It writes only `globalEnabled` to `storage.local`; it does not message tabs directly:

```text
desktop toolbar/extensions menu or Firefox Android Add-ons menu
        |
        v
action popup -> storage.local(globalEnabled)
                         |
                         v
               storage.onChanged in each
               live eligible frame bootstrap
                         |
                         v
                start/stop DOM controller
```

### 7.2 Injection and frames

Use a static Manifest V3 content script with:

- `matches`: HTTP and HTTPS pages only;
- `run_at`: `document_idle`;
- `all_frames`: `true`;
- `match_about_blank`: `true`; and
- `match_origin_as_fallback`: `true` (supported by Chrome 99+ and the selected Firefox minima).

The default isolated execution world must be retained. The extension does not need access to page JavaScript variables and must not select the main world.

Related `about:blank`, `about:srcdoc`, `data:`, and `blob:` frames may inherit eligibility from a permitted parent under the two frame-matching options. Their own `document.contentType` gate still applies. Direct top-level schemes other than HTTP(S) are out of scope.

### 7.3 Node eligibility

A `Text` node is eligible only when all of these are true at the moment it is processed:

1. its composed root is the current document, and it is connected;
2. it has a parent element;
3. it is under the document body (or equivalent body content in XHTML), not `<head>`;
4. no ancestor in its composed ancestor chain is a non-content container; and
5. it is not in an editable surface.

Ancestor evaluation starts at `parentElement`. On reaching a `ShadowRoot`, it continues at `ShadowRoot.host`, and repeats through any nested open-shadow host chain. This same composed walk is used for body containment, non-content checks, editable checks, editor-root checks, and document ownership. Merely being connected to some other document is insufficient.

For elements in the HTML namespace (`http://www.w3.org/1999/xhtml`), non-content containers are identified by exact lowercase `localName` (the HTML parser canonicalizes ordinary HTML names; XHTML names remain case-sensitive):

```text
script, style, noscript, template, textarea, select, option, datalist, title, head
```

For elements in the SVG namespace (`http://www.w3.org/2000/svg`), `script`, `style`, `title`, and `desc` are excluded; SVG `<text>` remains eligible. Elements from any other namespace are not excluded merely because their `localName` happens to equal an HTML/SVG container name. Namespace behavior must have XHTML, SVG, and mixed-namespace fixtures.

Editable surfaces include:

- an element for which `isContentEditable` is true;
- descendants of an effective `contenteditable` editing host; and
- a composed ancestor whose whitespace-tokenized `role` contains `textbox`, `searchbox`, or `combobox`.

Also exclude a subtree below an ancestor with one of these exact, case-sensitive class tokens:

```text
monaco-editor, CodeMirror, cm-editor, ace_editor
```

These small, auditable known-editor exclusions are defense in depth because rich editors often render model text as ordinary spans. They are not a general editor detector: a renderer can put its visible layer beside rather than below its textbox, use a different class, or assign its class after insertion. Rewriting such an unrecognized render layer can desynchronize the model, cursor, and screen. Version 1 accepts that residual risk, tests current Monaco, CodeMirror 5/6, and Ace fixtures, and must describe failures as compatibility bugs rather than claiming complete editor protection. The observer watches `contenteditable` and `role`, but deliberately does not watch the globally noisy `class` attribute; eligibility is nevertheless rechecked whenever any other event queues the node/subtree.

If `document.designMode` is `"on"`, all body text is treated as editable. A design-mode change has no dedicated DOM mutation signal, so it is noticed on the next queued text, child, `contenteditable`, or `role` event; prior replacements are not undone.

Do not use `innerHTML`, `outerHTML`, `innerText`, or `outerText` setters. Updating only `Text.data` preserves the element tree, attributes, event handlers, and unrelated text nodes, and cannot turn page text into executable markup.

### 7.4 Initial traversal

Immediately after the MIME gate, create and start the document `MutationObserver` before queuing or traversing initial content. JavaScript on the page cannot interleave inside that setup task, and every mutation after observer registration is therefore either visited by the initial walk or retained as mutation work. When an open shadow root is discovered, start its observer before queuing its traversal for the same reason.

Use an explicit iterative depth-first cursor. Each cursor owns a stack of frames containing only the next sibling at that depth. One work item either visits one element/text node or pops one exhausted frame. For an element, it checks exclusion and open-shadow discovery before adding a child frame; for a text node, it queues the node-local transform. No recursion is used.

This is intentionally more explicit than `TreeWalker.nextNode()`: a browser may internally advance across an arbitrary number of `FILTER_SKIP`/`FILTER_REJECT` nodes before returning, which would hide page-controlled work inside one scheduling step. The frame cursor makes the one-node/one-hop work accounting testable, including on a document with millions of elements but no text. Intrinsic non-content and known editor subtrees may be pruned. Editable ancestry is checked per text node because a nested `contenteditable="false"` can end inherited editability.

Traversal is incremental. A drain performs work until either a node-count limit or a short elapsed-time budget is reached, then yields via `requestIdleCallback` where available, with a bounded-time fallback based on `setTimeout`. It must not use an unbounded microtask loop because that can starve rendering and input.

Initial tuning constants, to be verified on Android hardware, are:

- at most 256 work items in one slice, where a DOM cursor node/frame step, mutation-record conversion, queued-node decision, composed-ancestor hop, or bounded lexer step group is a work item even when it produces no accepted text;
- at most 2 ms of extension work in one foreground slice on every platform, avoiding user-agent detection;
- an idle callback timeout so a continuously busy page still converges; and
- no whole-document rescan in response to an ordinary subtree mutation.

The drain checks elapsed time between bounded work items; a document containing millions of elements but no text must still yield. Explicit loops over composed ancestors, removal cleanup, queued records, or other page-controlled collections are iterative, retain cursors, and count their hops as work items rather than using recursion. These are scheduling targets, not assumptions in correctness tests.

### 7.5 Mutation processing

The document and each enrolled open shadow root have a small `RootState` containing their observer, pending-record batches, pending-node set, active traversal cursor, and overload flags. Start each observer before the corresponding initial traversal, configured with:

```text
subtree: true
childList: true
characterData: true
attributes: true
attributeFilter: ["contenteditable", "role"]
```

The observer callback itself must be constant-time with respect to `records.length`: append the delivered record array as one batch, update a count by `records.length`, schedule the shared drain if necessary, and return. The drain consumes records incrementally under the same node/time slice budget before applying these rules:

- enqueue the target of a relevant `characterData` record;
- enqueue each added `Text` node directly;
- enqueue each added element/subtree for incremental traversal;
- enqueue removed subtrees for bounded shadow-observer cleanup, but never for text transformation;
- enqueue the target subtree of a `contenteditable` or `role` record so descendants are re-evaluated under the current attribute value; this eligibility-change traversal also queues every encountered already-enrolled shadow root, because an outer host/ancestor change affects its composed descendants;
- discard queued nodes that are disconnected when eventually processed; and
- collapse child work when an ancestor subtree is already queued.

An attribute transition to an editable/excluded state prevents future writes but does not reconstruct text already normalized. A transition to an eligible state queues the subtree and makes it converge. Visibility-related attributes and `class` remain unobserved because CSS visibility is outside the selected model and global class observation is excessively noisy.

Extension writes also create `characterData` records. Use these structures:

- `pendingWrites: WeakMap<Text, string>` holds the expected value only from an extension write until the next coalesced observer delivery for that node;
- `normalizedNodes: WeakSet<Text>` records that the node has previously received an extension write, without duplicating its text; and
- conflict timestamps exist only for nodes that actually enter the section-10.1 rate guard.

Coalesce all records for one text node before classification. If `pendingWrites.has(node)` and its current value equals `pendingWrites.get(node)`, delete the pending entry and skip the self-generated work. If a pending entry exists but the value differs, delete it and process the current value once as an external change. A later record without a pending entry is likewise external, but it counts toward the rate guard only when `normalizedNodes.has(node)` and transformation would require another write. This bounds duplicate string retention to the observer-delivery interval rather than the lifetime of every normalized node. Weak keys ensure removed nodes do not stay alive.

Idempotence is still mandatory and is the ultimate loop defense. Observer bookkeeping avoids redundant work; it is not allowed to change transformation semantics.

Coalescing and fixed limits provide deterministic backpressure:

```text
MAX_PENDING_ENTRIES_PER_ROOT = 1,024
MAX_PENDING_ENTRIES_PER_DOCUMENT = 8,192
MAX_PENDING_MUTATION_RECORDS = 8,192
MAX_OBSERVED_SHADOW_ROOTS = 4,096
```

- Ancestor/descendant coalescing occurs only within one document or shadow root.
- Pending mutation-record arrays and their node references are globally capped. If accepting a delivery would exceed the record cap, do not retain that batch: mark its root dirty and set a document-level `shadowCleanupSweep` bit. The dirty traversal recovers connected added/changed/attribute content, while an incremental sweep of the bounded active-host registry disconnects shadow observers whose hosts are no longer connected.
- When one root exceeds its entry limit, clear its individual entries and replace them with one dirty-root traversal marker.
- When the document-wide entry limit is reached, convert every root with individual pending entries to a dirty-root marker. At most one marker exists per root.
- An observer continues collecting mutations during a full-root traversal into a bounded post-pass set. If that set overflows, set one `rescanAgain` bit. On completion, process the post-pass entries, or run one more full pass when the bit is set. Mutations are never discarded merely because the walker already passed their position.
- Ordinary mutations scan only their added/changed subtrees; a whole-root scan is an explicit overload recovery path.

At most 4,096 connected open shadow roots are enrolled. If the cap is reached, additional open roots are left untouched, `shadowCoverageLimited` is set for the document, and no observer or strong reference is retained for them. This is a documented fail-closed availability limit, preferable to unbounded observers on an adversarial page. When an enrolled host is later disconnected, bounded cleanup traverses the removed light subtree and any enrolled open roots reachable from its hosts, disconnects their observers, and removes their `RootState` entries. If coverage was limited, freeing a slot schedules one incremental document discovery pass so previously skipped connected roots can compete for it. If a removed host is reconnected before cleanup reaches it, it remains enrolled. Queue and shadow-root limit behavior is normative and must be tested.

A malicious or defective page can still mutate faster than any extension can converge. Under continuous overload the extension guarantees bounded retained work and bounded synchronous slices, not a deadline for convergence.

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

During each traversal, discover `element.shadowRoot` when it is open, enroll it within the section-7.5 limit, attach its observer before scanning it, and then queue its traversal. Do the same for newly added elements and their descendants. The active-root registry retains a disconnected enrolled host only until bounded removal cleanup reaches it; cleanup disconnects and deletes shadow-root state, and reattachment permits fresh discovery. Eligibility-change and dirty-root recovery traversals queue every encountered already-enrolled root again rather than treating discovery as a no-op; this is required to recover an outer attribute change whose mutation-record batch was collapsed.

Two cases cannot be covered without invasive behavior:

- closed shadow roots are intentionally inaccessible; and
- an open shadow root attached later to an already-connected host does not necessarily create a light-DOM mutation that the document observer can use to discover it.

Patching `Element.prototype.attachShadow` in the page's main world would improve discovery but is rejected. It expands the security boundary, can conflict with the application, and requires page-world communication. Periodic full scans are also rejected for version 1. These rare shadow cases are documented limitations.

### 7.8 Bootstrap and controller lifecycle

Refactor `content.js` so loading it defines an explicit `startContent(window, transformApi)` function but does not automatically start the DOM engine in a browser. A final `bootstrap.js` content script owns the global setting and the current controller. The manifest loads scripts in this order:

```text
transform.js -> content.js -> settings.js -> bootstrap.js
```

`settings.js` is a small shared, dependency-free adapter used by the bootstrap and popup. It owns the single setting key, strict state decoding, and the minimal callback-versus-Promise compatibility needed for Chrome and Firefox. Loading it only defines functions; it does not read or write storage until explicitly called. It must not expose page data, use a third-party compatibility library, or introduce general-purpose messaging.

The bootstrap first performs the section-5.1 MIME and top-level-scheme gates, before touching storage or installing a listener. A rejected document returns permanently. An eligible bootstrap starts with no controller, then follows this order:

1. Register a `storage.onChanged` listener for the `local` area.
2. Capture a local revision number and asynchronously read `globalEnabled`.
3. Increment the revision whenever a relevant change event is received and reconcile that event immediately.
4. Apply the initial read or read-failure result only if the revision has not changed since the read began.
5. Keep the listener installed for the lifetime of the content-script context, including while globally disabled.

Registering the listener before the asynchronous read prevents a setting change from being lost during startup. The revision check prevents an older read result from overwriting a newer change event. Unrelated storage keys and non-`local` change events are ignored. Removal of the key means “absent” and therefore restores the default enabled state; a present non-Boolean value means disabled.

Reconciliation is idempotent and owns exactly `controller = null` or one live controller:

```text
requested enabled + no controller   -> call startContent(), retain result
requested disabled + controller     -> call controller.stop(), clear result
requested state already satisfied   -> no-op
```

The bootstrap does not optimistically start while storage is unresolved. If listener installation, reading, or controller startup fails, that context remains disabled. The popup confirms the stored desired state, not successful execution in every tab: protected pages, discarded Android contexts, and unexpected content-script failures cannot be acknowledged centrally without adding tab access and a background coordinator.

`stop()` is a hard lifecycle boundary for that controller. It must be idempotent; disconnect every document/shadow observer; cancel its idle callback, timeout fallback, and cooldown timeout; clear strong-reference maps, root registries, queues, and resumable scanner state; and make every task/final-write path check the stopped generation before writing. Re-enabling always constructs a new controller and full initial traversal rather than attempting to revive cleared internal state.

JavaScript tasks are not interrupted midway, and `storage.onChanged` delivery differs slightly by browser and process. Therefore “off” means no extension write after that context handles the disable event, not no write after the user's physical tap at an identical instant in every process. This limitation must be reflected in tests and user-facing wording.

## 8. Extension structure and manifests

### 8.1 Source layout

```text
src/
  transform.js          pure parser/formatter
  content.js            explicit DOM-controller factory
  settings.js           one-key storage schema and browser API adapter
  bootstrap.js          document gate and controller lifecycle
  popup.html            action-popup document
  popup.css             responsive, accessible popup presentation
  popup.js              switch interaction and error state
icons/
  icon-16.png
  icon-32.png
  icon-48.png
  icon-128.png
manifests/
  chrome.json
  firefox.json
test/
  transform.test.js
  dom.test.js
  settings.test.js
  popup.test.js
  fixtures/
scripts/
  generate-icons.mjs    deterministic static icon generator
  package.mjs           deterministic packaging and artifact audit
  chrome-smoke.mjs      development-only real-browser smoke test
  firefox-smoke.mjs     development-only real-browser smoke test
```

Keep these source boundaries visible in the release artifact and do not minify them. A bundler is unnecessary: content scripts are listed in dependency order, and `popup.html` loads `settings.js` before `popup.js` with external script elements. The popup must not use inline JavaScript, remote assets, a framework, a third-party browser-API polyfill, or a custom checkbox/switch implementation. Its CSS is limited to responsive spacing, typography, touch-target sizing, focus visibility, and system-color adaptation.

### 8.2 Minimal manifest shape

The Chrome manifest is conceptually:

```json
{
  "manifest_version": 3,
  "name": "RFC3339ify",
  "version": "0.1.0",
  "minimum_chrome_version": "99",
  "permissions": ["storage"],
  "icons": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "action": {
    "default_title": "RFC3339ify controls",
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png"
    }
  },
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": ["transform.js", "content.js", "settings.js", "bootstrap.js"],
      "run_at": "document_idle",
      "all_frames": true,
      "match_about_blank": true,
      "match_origin_as_fallback": true
    }
  ]
}
```

The Firefox artifact uses the same `content_scripts` block, omits Chrome's `minimum_chrome_version`, and adds current Mozilla signing, disclosure, and Android-availability metadata:

```json
{
  "browser_specific_settings": {
    "gecko": {
      "id": "{5f52c973-693d-43f8-92f5-9644965786c6}",
      "strict_min_version": "140.0",
      "data_collection_permissions": {
        "required": ["none"]
      }
    },
    "gecko_android": {
      "strict_min_version": "142.0"
    }
  }
}
```

The Firefox artifact uses the same `permissions`, `icons`, `action`, and content-script source list. The implementation has selected the stable, non-personal UUID shown above. Do not change it after the first signed build. The explicit minimum versions implement the compatibility decision in section 4.1 and allow Mozilla's linter to evaluate desktop and Android separately. `required: ["none"]` declares that the design collects/transmits no user data; an install-local feature Boolean is configuration, not page-data collection. Adding another stored field or data category requires security and privacy review. The `gecko_android` entry both makes Android availability explicit and prevents installation below the tested Android floor.

Keep Firefox-specific keys out of the Chrome artifact if Chrome's validator warns about them. Manifest generation must be deterministic and tested against both store validators.

The Chrome artifact pins `minimum_chrome_version` because silently ignoring `match_origin_as_fallback` would violate the documented related-frame behavior. Re-check the minimum against current Chrome compatibility data before release.

Do not declare:

- a background/service-worker script;
- `tabs`, `activeTab`, `scripting`, `webRequest`, cookies, downloads, clipboard, history, identity, `unlimitedStorage`, or any permission beyond the reviewed `storage` permission and static content-script access;
- web-accessible resources;
- externally connectable endpoints;
- an extension page other than the reviewed action popup;
- explicit host permissions duplicated beyond what the static content-script match patterns require.

### 8.3 Site-access tradeoff

Automatic operation on every ordinary website inherently requests permission to read and change those pages. Restricting match patterns to `http://*/*` and `https://*/*` is narrower than `<all_urls>` because it excludes `file:`, FTP-like schemes, and direct local files, but it is still broad and will produce a prominent store permission warning.

Version 1 uses broad static access. This works at page load and in frames and lets users apply browser-provided site-access controls where available. Firefox Android currently does not provide equivalent per-host editing in Add-ons Manager; users there must not be promised a per-site restriction control. The built-in switch changes global runtime behavior but does not revoke the all-sites permission: while off, eligible pages still receive the small bootstrap so they can react to a later enable event, but no DOM controller is started and page text is not traversed.

A future user-selected-sites mode is a separate product feature. It would need a definition of site identity, precedence between global and per-site states, popup/current-tab handling, permission semantics, state migration, and substantially more tests. Optional host permissions plus registration/injection machinery could reduce default exposure but would add browser differences and a failure mode where dates appear unconverted until access is granted. The global switch must not be presented as a per-site access control.

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
- **Minimal configuration persistence, no telemetry:** `storage.local` contains only the Boolean `globalEnabled`. No page content, hostname, URL, tab identifier, match count, timestamp, or error is stored or sent. Diagnostic builds must not be published.
- **Isolated world:** no page-world globals, monkeypatches, injected `<script>`, or `postMessage` bridge.
- **Text-only writes:** setting `Text.data` cannot create markup, event handlers, navigation, or script execution.
- **Fixed linear parser:** no backtracking-heavy user-controlled regular expression and no generic date parser.
- **Bounded scheduling:** yields during large traversals and coalesces mutation work.
- **Fail-closed grammar:** invalid and unsupported forms remain unchanged.
- **Readable artifact:** do not minify or obfuscate release JavaScript. Include only the manifest, reviewed icons/license files, content/bootstrap/settings scripts, and popup HTML/CSS/JavaScript.
- **Deterministic release:** pin development tools, commit the lockfile if tools are introduced, generate both unsigned packages in CI, and publish their hashes. For a signed CRX/XPI, compare the payload against tagged source while explicitly excluding and auditing store-added signature metadata or store-controlled repackaging.
- **Browser-enforced site access where available:** document the actual controls separately for Chrome desktop, Firefox desktop, and Firefox Android. Do not imply Firefox Android has per-host editing. The built-in switch is the ordinary global pause; browser-level disabling or uninstalling remains the stronger fallback that unloads extension code.

`storage.local` is not an encrypted secret store and is available to this extension's content-script contexts. That is acceptable only because the value is a non-sensitive feature Boolean. Page scripts cannot directly call the isolated extension storage API, but they can still infer enabled behavior by observing DOM changes. The storage schema is an allowlist of exactly one key; adding hostnames, page-derived data, or diagnostic history is a security-design change.

No extension can prevent the host page from observing its DOM changes. A site can compare text content, detect normalization, or react through its own `MutationObserver`. The extension therefore does not promise invisibility to pages.

### 9.4 Auditing checks

CI should fail if release source contains or declares unexpected capabilities, including:

- networking APIs or remote URL literals;
- `eval`, `Function`, dynamic import, or remotely hosted code;
- `innerHTML`/`outerHTML` writes;
- page-world execution;
- manifest permissions other than `storage`, service workers, or web-accessible resources;
- storage keys or writes other than the exact `globalEnabled` Boolean; or
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

Most text nodes contain no candidate. For a node of at most 4,096 UTF-16 code units, check cheaply for one of the accepted month prefixes/casings or for a colon plus a possible `A`, `a`, `P`, or `p` meridiem sequence before invoking the full scanner. The prefilter must cover no-space and dotted meridiem forms and must have no false negatives for the accepted grammar. Do not lowercase every node or allocate a normalized copy.

Do not run repeated whole-string native searches as an allegedly cheap prefilter on a larger node, because their uninterrupted execution would bypass the slice budget. Nodes above 4,096 code units enter the resumable lexer directly; its ordinary no-match path doubles as a bounded prefilter. The 4,096-code-unit threshold is a scheduling constant, not a semantic size limit.

When there is no match:

- make no DOM write;
- create no output string/buffer where practical; and
- retain no reference to the node after queue processing.

### 11.2 Large nodes

A single huge HTML text node can defeat a per-node time budget. The lexer must therefore expose resumable state: current input offset, current recognizer/envelope state, and already-produced output pieces. It may yield between code points/tokens and resume without rescanning a growing prefix. This is preferable to fixed-overlap chunks because refusal-only digit and whitespace/separator runs can be arbitrarily long even though accepted tokens have fixed lengths.

Before every resume and again before writing the completed result, verify that the node still contains the captured input string. If the page changed it during a yielded scan, discard the stale state and queue the current value. The stale result must never overwrite newer page content. Equality with the captured immutable string is sufficient for output safety; a page that changes away and back to the identical value does not require a different result.

An arbitrary size cutoff is not recommended because it creates silent correctness gaps on large log/code views. A documented emergency cap may be added only after memory tests demonstrate a concrete need.

### 11.3 Provisional acceptance budgets

Benchmarks should include a desktop browser and a mid-range Android Firefox device/emulator. Proposed release gates are:

- no extension-caused task longer than 16 ms in the standard large-page fixture;
- traversal slices meet the universal 2 ms target at the 95th percentile;
- a 100,000-text-node, 5 MiB fixture converges without input becoming unresponsive;
- a single multi-megabyte candidate-free text node never enters an unbounded native prefilter and is scanned resumably;
- mutation cost scales with changed/added subtrees rather than total document size;
- steady state creates no timer loop and near-zero CPU use when the DOM is idle; and
- packaged code remains on the order of tens of KiB, excluding icons and test tooling.

Exact total convergence time is hardware-dependent and less important than responsiveness. Record benchmark hardware, browser version, fixture, median, and 95th-percentile results in a checked-in report before release.

### 11.4 Disabled-state budget

The global-off path must be materially cheaper than an active idle controller. Each eligible frame retains only the loaded bootstrap/settings code, one `storage.onChanged` listener, a small revision/state record, and the browser's extension context. It creates no `MutationObserver`, scans no DOM text, holds no DOM node, and schedules no periodic callback or timer. Static injection overhead remains because it is what permits a live page to turn back on without `tabs`/`scripting` permissions or a background worker.

Benchmark a large multi-frame fixture in both states. Switching off must return controller-owned observer/root/cooldown/queue counts to zero after the disable event is handled, and an unchanged page left off for five minutes must show no extension timer wakeup or DOM work. The popup is ephemeral and must consume no resources after it closes.

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
- midnight, noon, every approved meridiem spelling, plain-meridiem sentence punctuation, zero/eight-character time spacing, seconds `59`, and syntactically accepted seconds `60`;
- multiple independent matches in one string;
- weekday and timezone preservation; and
- every supported whitespace character plus runs of exactly one and eight code units.

Negative tests cover:

- `Jan 0`, `Jan 32`, `Apr 31`, `Feb 30`, impossible `YEAR2` leap dates, and invalid `YEAR4` leap dates;
- `00:00 AM`, `13:00 PM`, `01:60 PM`, seconds `61`, and malformed time fields;
- mixed-case months, ordinals, unsupported month/meridiem spellings, and fractional seconds;
- numeric year suffixes of one, three, or five-plus digits; zero year; failed year boundaries; one-to-eight versus nine-plus suffix spacing; and missing post-comma whitespace, misplaced commas, or multiple commas, using the exact normative cases in section 6.4;
- recognized invalid/unsupported larger dates, including `Feb 29, 2025`, `Jan 1, 123`, `Mon Sep 17 00:00:00 2001`, and malformed `Sep 17 99:00:00 2001`, which must not partially rewrite;
- identifier adjacency such as `fooJan 1`, `éJan 1`, `变量Jan 1`, `Jan 1st`, and `AM_variable`;
- runs of nine accepted whitespace code units, including both an otherwise valid date separator and a year-like suffix separator;
- already normalized ISO/RFC-like dates and 24-hour times; and
- random Unicode surrounding text.

Property/fuzz tests assert:

- `transformText(transformText(s)) === transformText(s)`;
- the function never throws for arbitrary JavaScript strings, including lone surrogates;
- output outside reported replacement spans is unchanged;
- `REFUSE` copies the entire recognized envelope unchanged and prevents inner/prefix matches;
- `REFUSE(end)` stops at the defined maximal digit run or `MERIDIEM_LIKE` end, so a later independently bounded date/time remains eligible;
- `YEAR4`, `YEAR2`, and yearless precedence is respected, including invalid-longer-form refusal;
- every emitted month/day/time field satisfies its range; and
- driving `resumeTransform` with any positive scanner-step budget produces the same result as `transformText`; and
- runtime and counted scanner steps grow approximately linearly with input size.

Stress properties separately generate very long `DIGIT_RUN`, `suffix-separators`, git-style `WSP+`, and time-envelope `WSP*` sequences. They assert bounded-slice resumability and prove that resumption does not rescan an ever-growing prefix.

### 12.2 DOM unit tests

Using real DOM fixtures, verify:

- only `Text.data` changes and element/attribute identity is stable;
- excluded containers and editable surfaces remain untouched;
- visible labels outside excluded form/editor surfaces, HTML `<pre>/<code>`, ARIA live regions, inline SVG, and open shadow roots are transformed;
- `<option>`, non-content containers, and editable/editor surfaces remain unchanged;
- split-node dates remain unchanged;
- initial and dynamically added content converge;
- the document observer is active before the first traversal yield, and a mutation between initial slices is not lost;
- direct `characterData` edits converge;
- `contenteditable` and `role` transitions re-evaluate light-DOM and already-enrolled shadow descendants without undoing prior output;
- extension-generated mutation records do not loop;
- composed-ancestor exclusions cross one and multiple open-shadow host boundaries;
- current Monaco, CodeMirror 5/6, and Ace fixtures are excluded, with a negative fixture documenting an unrecognized sibling render layer;
- removed/reattached shadow hosts disconnect or re-enroll observers without leaking or throwing;
- burst additions are coalesced, one oversized observer delivery does not create an unbounded callback, per-root/global record and node-queue overflow takes the specified dirty-root path, and post-pass mutations are not lost;
- the 4,096-shadow-root cap fails closed and a later freed slot triggers discovery retry;
- a deeply nested light/shadow DOM exercises iterative, resumable ancestor and cleanup walks without recursion or long tasks;
- a simulated framework overwrite is handled and rate-limited if adversarial; and
- cooldown expires through the shared one-shot scheduler and a reused text node becomes eligible again.

### 12.3 Global-control and popup tests

Settings/bootstrap tests must cover:

- absent, Boolean `true`, Boolean `false`, malformed, and removed `globalEnabled` states;
- storage API absence/read rejection and a controller-start exception, all of which leave that context disabled;
- listener registration before the initial read and a change arriving while that read is pending, proving the stale read cannot overwrite the newer event;
- unrelated storage areas/keys, repeated same-state events, and rapid off/on/off changes, proving reconciliation is idempotent;
- initial enabled startup, initial disabled dormancy, disable, re-enable, and a fresh full traversal of content changed while off;
- document, subframe, and enrolled open-shadow observers/queues/timers stopping without leaks;
- cancellation of cooldown retries and a yielded scanner result, proving neither can write after its controller handles disable;
- one context failing or being discarded without preventing independent contexts from converging; and
- an inspected `storage.local` area containing no extension-owned key other than one Boolean `globalEnabled`.

Popup tests must cover:

- accessible name/state for the native checkbox, a label that activates its full touch target, logical focus order, and a polite live status region;
- preservation of the browser-native checkbox appearance, including checked, unchecked, indeterminate, disabled, and focus-visible states;
- initial loading/indeterminate state, default enabled state, saved on/off confirmation, malformed-value repair, external `storage.onChanged` updates while open, and rapid interaction serialization;
- read failure and write failure: never show an unconfirmed state as saved, revert to the last confirmed state when possible, expose a visible error, and permit an explicit retry;
- responsive layout at desktop popup widths and Firefox Android's full-window overlay, at 200% text zoom and in browser/OS light and dark color schemes;
- automatic `Canvas`/`CanvasText` and native form-control adaptation with no hard-coded black/white palette, forced theme, or unreadable transition state;
- at least a 48 CSS-pixel tap target, no hover-only disclosure, and operation with touch and keyboard/switch-control input; and
- no auto-close after a change, network request, inline script, page/tab query, hostname display, badge update, or dynamic icon mutation.

### 12.4 Browser integration tests

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

Where the browser permits a test harness to reach them, top-level `blob:`, `data:`, and `about:` HTML documents must remain untouched even if origin-fallback matching injects the script; the explicit top-level scheme gate, not an assumption about manifest matching, enforces this result.

Also test CSP and Trusted Types pages, cross-origin frames under a second local origin, back/forward cache restoration, SPA updates, large virtualized lists, and sites with open shadow DOM.

Desktop tests must open the action from both a pinned toolbar button and the browser's extensions menu, save each state, and verify all already-loaded eligible tabs/frames eventually follow it without reload. Firefox Android tests must cover the AMO-installed or equivalently signed MV3 artifact, the all-sites permission prompt, accepted and denied access, actual top-level/subframe injection after acceptance, action discovery under the Add-ons menu, full-overlay popup layout, global off/on propagation, process-discard/reload recovery, the absence of per-host grant editing, and browser-level disable/uninstall recovery. These are release gates, not assumptions inferred from desktop Firefox.

The action popup must also remain usable while the active tab is a browser-protected, plain-text, or otherwise ineligible page. Changing the global setting there affects other eligible contexts even though the current page has no active bootstrap.

Test restart/update persistence, storage clearing restoring the default-on state, and—where the browser allows the extension in private/incognito windows—the documented sharing or separation of the setting. A tab that predates installation or browser-level re-enablement and a discarded Android content-script context must be shown to require reload/navigation rather than being falsely reported as live. Already-normalized text must remain after global off until the page itself rerenders or reloads.

Representative manual compatibility checks should include non-destructive views on GitHub and the Cloudflare dashboard. Tests must avoid changing real settings or submitting forms.

Chrome Android testing should instead verify/document the platform non-support; it is not meaningful to claim a passing extension test on official Chrome Android.

### 12.5 Security/release tests

- Lint both manifests and build/load them as unpacked extensions.
- Run Mozilla's official extension linter for the Firefox artifact.
- Verify the Firefox artifact declares its stable Gecko ID, `required: ["none"]`, and `gecko_android` metadata.
- Verify both manifests declare exactly `storage`, the reviewed `action` popup, static HTTP(S) content-script access, and no background, `tabs`, `activeTab`, or `scripting` capability.
- Verify Chrome minimum 99, Firefox desktop minimum 140, Firefox Android minimum 142, and `match_origin_as_fallback` compatibility against current browser data before every release; raise a minimum if any included manifest feature requires it.
- Inspect the final ZIP contents against a file allowlist.
- Compare two clean builds for reproducibility.
- Search release code for prohibited network, eval, HTML-sink, and page-world facilities.
- Confirm in browser developer tools that the active and globally disabled extension make no network requests and have no background process.
- Inspect extension storage after every test suite and assert that only a Boolean `globalEnabled` can persist.
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

### 13.3 Distribution

Distribution depends on Chrome Web Store and Mozilla Add-ons developer accounts, current store-policy acceptance, signing services, stable extension identifiers, and the stores' continued support for the selected manifests and platforms. Before the first release, the owner must choose the source license; then prepare its required notices along with icons/listing assets, a plain-language privacy disclosure, support contact, and reproducible-build instructions. The implementation repository remains marked `UNLICENSED` until that explicit legal choice is made.

The CI-produced unsigned ZIPs are the reproducibility baseline. Store-signed CRX/XPI files may contain signatures or store-generated metadata, so verification compares their executable/resource payload against the baseline and separately inventories every store-added entry. Android availability, version compatibility, and permission presentation must be checked on the published AMO listing, not only with a temporarily loaded extension.

## 14. Observability and user control

Production telemetry and page-content logging are prohibited. A simple content script also has no safe reason to print matches to the browser console, where sensitive page text or noisy logs could appear.

For support, diagnostics should be reproducible with public fixture pages and version/build identifiers. A temporary developer build may expose aggregate counters locally, but it must be clearly branded, never published to stores, and never log matched strings.

### 14.1 Selected control

Declare an MV3 `action` with `default_popup`. The popup contains one ordinary native `<input type="checkbox">` whose full `<label>` row is clickable/tappable. Do not replace it with a custom slider, switch drawing, image, or ARIA-reimplemented control. This is the canonical control for `globalEnabled`; no background script is required because the popup writes directly to `storage.local`, and content-script bootstraps subscribe directly to `storage.onChanged`.

The compact UI is:

```text
RFC3339ify

[checkbox] Normalize dates and times

On — applies to all eligible pages in this browser.
```

When off, replace the status text with:

```text
Off — future changes are stopped.
Reload affected tabs to restore text from the page.
```

“Eligible” links or expands only if this can be done without making the popup cluttered; the store/help page provides the complete HTML/XHTML, protected-page, frame, and plain-text qualifications. The popup wording must not claim that prior DOM/application/server effects were rolled back or that every process changed atomically.

### 14.2 Desktop interaction

On Chrome and Firefox desktop, users may pin the neutral RFC3339ify action icon for quick access or open it through the browser's extensions menu. Opening the popup and toggling one control is preferred over an options page because it remains discoverable in the current browsing context without requiring the extension to know the current tab or site.

After a tap/click, temporarily disable the checkbox, show `Saving…`, and perform one serialized Boolean write. On success, show the confirmed on/off text and leave the popup open so the user can read it. The confirmation means the desired setting was stored; it does not claim acknowledgements from every tab. If another extension context changes the value while the popup is open, its own `storage.onChanged` listener updates the checkbox and status.

Do not use the icon or a badge as the authoritative state. A neutral static icon cannot become stale after a browser restart or Android process discard and does not require background initialization. The popup's confirmed checkbox is the sole state indicator.

### 14.3 Firefox Android interaction

In Firefox Android MV3, the action is reached from Firefox's menu through Add-ons and RFC3339ify. Mozilla documents that the popup opens as an overlay covering the browser window. Use that same popup document rather than an Android-specific UI or manifest.

The layout must:

- be responsive rather than set a desktop-only fixed width;
- keep the labeled checkbox row at least 48 CSS pixels high and make the entire row the touch target;
- use system fonts, logical CSS properties, and browser/OS system colors;
- declare `color-scheme: light dark` so the background, text, native checkbox, buttons, and focus indicators automatically follow the active light/dark scheme;
- use `Canvas` and `CanvasText` for the popup surface/text where explicit colors are needed, without hard-coded `#000`, `#fff`, or a JavaScript theme detector;
- remain usable at large text sizes without clipping or horizontal scrolling;
- require neither hover nor a hardware keyboard; and
- retain native checkbox semantics, visible focus, and a polite live region for saving/success/error status.

The preferred CSS baseline is intentionally small:

```css
:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
}

body {
  color: CanvasText;
  background: Canvas;
}
```

Leave checkbox painting, checked color, disabled appearance, and platform-specific sizing to the browser. Minimal spacing and a 48 CSS-pixel label row may be styled, but do not set `appearance: none`, draw pseudo-element controls, animate the state, or maintain separate light/dark stylesheets. This keeps the control familiar on desktop and Android and lets high-contrast/forced-colors modes continue to work through native rendering.

Do not auto-close the overlay after changing the setting. A persistent result is more important on Android, where reopening the path takes several taps and silent write failure would otherwise be easy to miss.

Official Chrome on Android remains unsupported because it cannot install this extension. Extension-capable Chromium forks are not a reason to add browser-specific UI until one becomes a supported target.

### 14.4 Loading and failure states

On popup load, disable interaction, set the checkbox's programmatic `indeterminate` state, and show `Loading setting…` until a snapshot has been read. Decode it with the same rules as the bootstrap. For an absent or Boolean value, clear `indeterminate` and show the confirmed effective state. On read failure, keep the state unavailable/indeterminate, show a concise storage error, and expose a `Retry` button; do not guess that normalization is on or off.

A present non-Boolean value is effectively off but is not a confirmed saved state. Show the unchecked control with `Stored setting is invalid; normalization is treated as off` and an explicit `Reset to Off` action that writes Boolean `false`; toggling on instead writes Boolean `true`. Do not silently preserve or display a malformed value as a valid saved setting.

If a write fails, revert the checkbox to the last confirmed state when one exists, announce `Could not save the setting`, and leave an explicit retry path. Never show `On` or `Off` as saved merely because the user moved the control. Rapid interactions are serialized or disabled while a write is pending so an older Promise/callback cannot overwrite newer UI state. Error details belong in development tests, not in production console logs containing page context.

The popup cannot distinguish a protected page, a tab without an injected bootstrap, or an Android-discarded extension context because the design intentionally requests no tab access and has no background coordinator. User documentation therefore says that most already-loaded eligible pages react on the fly and that reload/navigation is the recovery step when one does not.

### 14.5 Browser-native fallback and alternatives

Chrome/Firefox's extension manager remains the emergency control for disabling or uninstalling the complete extension. That unloads more code than global off. Re-enabling through browser-native controls may not inject static content scripts into tabs that were already loaded, so affected tabs may require reload/navigation. Desktop site-access controls remain usable where offered; Firefox Android users must not be promised per-host management that its Add-ons Manager does not provide.

Rejected alternatives are:

- **Direct one-click action toggle:** with no popup, `action.onClicked` must be handled by a background context. Chrome MV3 would require a service worker, while Firefox Android does not support MV3 background service workers. Divergent background manifests are disproportionate for one Boolean.
- **Options page:** slower to reach, especially on Android, and adds no value for a single global setting.
- **Keyboard command:** not available on Firefox Android and cannot be the primary mobile control.
- **Injected page button or floating widget:** modifies privileged page UI, creates style/event conflicts, and exposes more extension behavior to the page.
- **Per-site toggle:** needs site-identity, precedence, permission, and current-tab semantics and is explicitly a later product decision.
- **Automatic rollback:** retaining every original string would create unbounded memory/privacy exposure and conflict with framework rerenders, node reuse, selection, and application state. Reloading is the only general DOM refresh path.
- **`localStorage`:** popup and content scripts do not share an ordinary page storage origin, and it lacks the extension-wide change event and durability semantics needed here.
- **`storage.sync`:** cross-device behavior differs across supported browsers and is specifically not Mozilla-account synchronization on Firefox Android.

### 14.6 Remaining platform verification

The architecture is settled, but these browser behaviors remain release-blocking empirical checks rather than assumptions:

- the exact signed Firefox Android 142+ Add-ons-menu placement and popup overlay behavior when the all-sites permission is accepted versus denied;
- whether a retained Android page automatically regains an extension context after process discard, or requires navigation/reload as expected;
- regular/private-incognito sharing of `storage.local` and `storage.onChanged` on each target/configuration where private access is allowed; and
- popup layout, system-back behavior, focus restoration, and error visibility on an actual touch device at large system text sizes.

If any result contradicts the design, narrow the user-facing promise or raise the minimum browser version before adding a background context or a separate Firefox Android artifact. Menu labels and placement can change across browser releases, so help text should be version-tolerant while release tests record the exact tested path.

## 15. Implementation and release plan

1. Freeze the resolved decisions in section 16 and the exact section-6 grammar as positive/negative test tables.
2. Implement the pure scanner and exhaustive unit/property tests.
3. Implement the MIME gate and node-local DOM engine without mutation observation; verify DOM integrity.
4. Add chunked scheduling, shadow-root discovery, mutation coalescing, and loop/rate guards.
5. Generate minimal Chrome and Firefox manifests, freeze the stable Gecko ID and minimum versions, and load both unpacked.
6. Refactor browser auto-start into `startContent()`, then add the shared settings adapter, race-safe bootstrap, action popup, accessible static icons, and strict one-Boolean storage tests.
7. Add real-MIME browser fixtures, cross-frame tests, editor/shadow/overload tests, global off/on lifecycle tests, popup tests, large-page benchmarks, and signed Android Firefox permission/action coverage.
8. Perform a manual security review of the complete release artifact, storage schema, and permission diff.
9. Run a limited canary on representative read-only GitHub/Cloudflare pages, recording false positives and framework conflicts without collecting page data.
10. Publish signed store artifacts from a tagged, reproducible unsigned baseline with hashes, an audited signature-metadata diff, and a plain-language privacy statement.

To stop future rewriting in ordinary use, switch `Normalize dates and times` off in the action popup. Browser-level disabling/uninstalling or site-access revocation remains a stronger fallback. None of these actions undo `Text.data` changes already present in a live document; reload affected tabs to request fresh page text, and note that a page rerender may independently restore it.

The extension performs no network operation and stores only the local `globalEnabled` Boolean, but it cannot guarantee that page-text changes remain client-only. Host-page code can observe the DOM mutation, react to it, copy normalized text into application state, or transmit/persist that state. Reloading is therefore a DOM refresh, not a guarantee that an application-side or server-side reaction can be reversed. Conservative parsing and canary testing remain necessary on privileged sites.

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
9. **Site access:** enable automatic static content-script access on all HTTP and HTTPS sites, subject to browser-protected-origin restrictions and whatever user/administrator controls the specific browser supplies. Firefox Android does not currently provide per-host grant editing; the built-in install-wide switch is the normal pause, while browser-level disable/uninstall remains the fallback.
10. **Browser coverage:** release gates are Chrome desktop, Firefox desktop, and Firefox Android. Official Chrome Android is unsupported because it cannot run the extension.
11. **Accessibility:** transform ARIA live-region text, accepting that a mutation can trigger an announcement.
12. **Form choices:** exclude every `<select>`, `<datalist>`, and `<option>` text subtree because label mutation can change the submitted value when no explicit `value` exists, while other text in those controls is not ordinary page content.
13. **Firefox packaging:** ship one Firefox MV3 artifact for desktop 140+ and Android 142+. Add a separate MV2 Android artifact only after a demonstrated MV3 blocker and a separate distribution/migration design.
14. **Overload behavior:** bound pending work and observed open shadow roots by the section-7.5 constants. Queue overflow triggers lossless dirty-root recovery; exceeding the shadow-root cap deliberately leaves additional roots untouched.
15. **Initial rendering:** conversion is incremental and eventually convergent, not atomic or guaranteed to be flash-free.
16. **Global control:** use one default-on `globalEnabled` Boolean in `storage.local`, an action popup, and per-frame race-safe bootstraps. Global off stops future controller writes after event delivery but does not reconstruct already-normalized text. Do not add a background context, per-site state, synchronized state, badges, or tab permissions for this feature.


## 17. Acceptance criteria

The first release is acceptable when:

- all approved grammar examples and negative cases pass identically in the three supported browser targets;
- HTTP(S) `text/plain` fixtures, including a raw patch, are demonstrably untouched;
- HTML and XHTML fixtures transform only eligible text nodes and preserve all attributes/elements;
- dynamic mutations converge without self-triggered loops or long tasks;
- mutation work registered after observer startup is never lost across initial, ordinary, dirty-root, or post-pass traversal;
- documented iframe and open-shadow cases work, and inaccessible cases are accurately described;
- the final manifests request no capability beyond static HTTP(S) content-script access and the `storage` permission needed for the one-Boolean global switch;
- the Chrome manifest passes validation with minimum version 99;
- the Firefox MV3 manifest passes AMO validation with its stable ID, `required: ["none"]`, desktop minimum 140, Android minimum 142, and explicit `gecko_android` metadata;
- desktop and Firefox Android action popups are discoverable, accessible, and correctly persist/propagate global off/on without a background context;
- all bootstrap state/race/failure cases pass, disable prevents stale queued writes, and extension storage contains only a Boolean `globalEnabled`;
- signed Firefox Android installation, permission acceptance/denial, injection, action overlay, and disable/uninstall tests pass, and documentation does not claim unavailable per-site host controls;
- the artifact contains no production dependency, background worker, network code, telemetry, remote code, or page-world injection;
- performance budgets pass on recorded desktop and Android test hardware;
- security and permission review finds no unexplained artifact, storage field, or capability; and
- store/user documentation clearly discloses broad page-text access, local DOM modification, global-switch/no-rollback semantics, plain-text exclusion, restricted-page limits, and the lack of Chrome Android support.

## 18. Reference material

- [Chrome Extensions: content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome manifest `content_scripts` reference](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)
- [Chrome Extensions: `chrome.action`](https://developer.chrome.com/docs/extensions/reference/api/action)
- [Chrome Extensions: `chrome.storage`](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome Web Store Help: install and manage extensions](https://support.google.com/chrome_webstore/answer/2664769) — describes desktop installation and the phone “Add to Desktop” workflow.
- [MDN: `content_scripts`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts)
- [MDN: manifest `action`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/action)
- [MDN: WebExtensions `storage`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage)
- [MDN: `browser_specific_settings`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)
- [MDN: `host_permissions`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions)
- [MDN: `Document.contentType`](https://developer.mozilla.org/en-US/docs/Web/API/Document/contentType)
- [MDN: `MutationObserver.observe()`](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/observe)
- [Mozilla Support: find and install add-ons on Firefox for Android](https://support.mozilla.org/en-US/kb/find-and-install-add-ons-firefox-android)
- [Firefox Extension Workshop: differences between desktop and Android extensions](https://extensionworkshop.com/documentation/develop/differences-between-desktop-and-android-extensions/) — official action-popup, storage, and unsupported-commands behavior; page last updated 2024-01-17 when reviewed.
- [Firefox Extension Workshop: developing extensions for Firefox for Android](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/) — official MV3 compatibility warning and Android development guidance; page source date 2023-11-12.
- [Firefox Extension Workshop: distribute Manifest V2 and V3 extensions](https://extensionworkshop.com/documentation/publish/distribute-manifest-versions/) — confirms that one extension package cannot be both MV2 and MV3; its distribution examples are dated 2023-03-03 and must not be treated as current AMO channel policy without re-verification.
- [Mozilla Bug 1812125](https://bugzilla.mozilla.org/show_bug.cgi?id=1812125) — Firefox Android host-permission editing limitation.

## 19. Initial implementation status

As of 2026-07-29, the repository contains the pure resumable transformer, bounded DOM engine, race-safe global-setting bootstrap, adaptive action popup, Chrome/Firefox manifests, deterministic dependency-free release packager/icon generator, DOM/grammar/settings/popup tests, and development-only Chrome/Firefox smoke-test drivers. The packaged runtime contains the manifest; `transform.js`, `content.js`, `settings.js`, and `bootstrap.js`; popup HTML/CSS/JavaScript; and four static PNG icons. It has no runtime dependency or background context.

The current checkpoint has passed:

- 33 Node tests covering the normative grammar, representative exhaustive calendars, every accepted hour/minute/meridiem combination, Unicode boundaries, idempotence fuzzing, long-run resumability, DOM eligibility, dynamic mutation, backpressure recovery, cooldown behavior, XHTML/SVG, the 4,096-shadow-root cap, storage decoding/API variants, bootstrap races and teardown, popup state/error recovery, and adaptive native-control styling;
- packaged real-MIME smoke tests in Chrome for Testing 150.0.7871.186 and Firefox desktop 153.0.1, including HTML, XHTML, dynamic mutation, related HTML frames, and an untouched `text/plain` frame/resource; the Chrome run additionally covers popup storage writes, live global disable, and live re-enable/rescan;
- Mozilla `web-ext` 10.5.0 lint with zero errors, notices, or warnings;
- ZIP integrity and deterministic in-process byte-for-byte build checks; and
- a zero-finding npm vulnerability audit for the pinned development dependency set.

This checkpoint is not a release sign-off. Remaining work includes a signed Firefox Android 142+ installation/permission/injection/action test on a real device or emulator, recorded desktop/Android performance budgets, manual non-destructive GitHub and Cloudflare canaries, current store-policy/minimum-version revalidation, store listing assets and disclosures, and an explicit owner decision on the source license. Official Chrome Android remains unsupported for the platform reason in section 4.
