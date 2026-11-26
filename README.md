# Gradia Capture (jssd fork)

**English** | [简体中文](README.zh_CN.md)

> An independently maintained fork of
> [Alexander Vanhee's gradia-capture](https://github.com/AlexanderVanhee/gradia-capture),
> adding local/online OCR, translation and a complete Simplified Chinese UI on top of
> the upstream screenshot/annotation features. **Not an official upstream build, and not
> intended for upstream PRs.**

The goal of this repository is day-to-day use on Debian 13 + GNOME 48 (Wayland):
a single pipeline of **screenshot → annotate → recognize text → translate → copy/view**,
with a fully translated Simplified Chinese interface.

## Features

### Screenshots and annotations (from upstream)

- Takes over the built-in GNOME screenshot UI with freehand, rectangle, filled rectangle,
  highlighter, arrow, text and number-stamp annotations;
- Area / window / screen selection, window compositing, cursor visibility, save format,
  shutter sound and related options;
- Save, copy, open in the default app, and hand the screenshot over to the
  [Gradia app](https://flathub.org/apps/be.alexandervanhee.gradia).

### OCR (fork-only)

Three engines, selectable in preferences and switchable directly from the result panel:

| Engine | Description | Dependency |
|---|---|---|
| `gradia` | Forwards the screenshot to the Gradia flatpak (upstream behavior, default) | Gradia app installed |
| `rapidocr` | Fully local, works offline | One-time Python venv setup |
| `llm` | Any OpenAI-compatible vision model (e.g. DeepSeek) | Network + API configuration |

- Trigger with `Ctrl+E` in the screenshot UI, or the scanner button in the corner;
- A loading indicator appears while recognition runs;
- Failures produce actionable notifications (not configured, missing environment,
  timeout, HTTP errors, ...).

### Translation (fork-only)

- Google Translate without an API key (uses the system proxy);
- LLM translation which can **inherit the LLM OCR configuration**; when both OCR and
  translation use an LLM and inheritance is enabled, **a single request returns both the
  original text and the translation**;
- 12 target languages (Simplified/Traditional Chinese, English, Japanese, Korean, French,
  German, Spanish, Russian, Portuguese, Italian, Arabic);
- A failed translation never discards the OCR result: the original text stays available
  and the panel shows the concrete reason.

### Result panel (fork-only)

- Centered at the top of the screen, original text and translation **side by side**, with
  independent scrolling for long texts;
- OCR engine, translation engine and target language can be switched inside the panel;
  pressing "Recognize again" re-runs the pipeline immediately;
- "Copy Original" / "Copy Translation" writes to the clipboard and closes the panel;
- For read-only use the clipboard is still filled according to the configured copy mode.

### Other

- All user-visible strings go through gettext with a complete Simplified Chinese catalog;
- Three independent proxy configurations: OCR LLM, translation LLM and Google, each with
  `system` / `direct` / `custom` modes;
- Preferences show only the rows relevant to the current configuration.

## Requirements

| Item | Requirement |
|---|---|
| Desktop | GNOME Shell 48 (tested on Debian 13.7 / GNOME 48.7 / Wayland; `shell-version` also lists 49–51 for upstream compatibility, but only 48 is tested) |
| Network | libsoup 3 (`gi://Soup?version=3.0`) |
| Python | Only for the RapidOCR engine: Python 3.13 + `uv`, with the venv at `~/.local/share/gradia-capture/venv` |
| Other | Icons and translation catalogs are bundled with the extension |

## Installation

```bash
git clone https://github.com/jssda/gradia-capture.git
cd gradia-capture
./build.sh -i          # build and install into ~/.local/share/gnome-shell/extensions/
gnome-extensions info gradia-integration@alexandervanhee.github.io   # verify ACTIVE
```

On Wayland, **log out and back in** after installing: JS modules are only loaded on login.

### Optional: local RapidOCR environment

```bash
uv venv --python 3.13 ~/.local/share/gradia-capture/venv
uv pip install --python ~/.local/share/gradia-capture/venv/bin/python \
  -i https://pypi.tuna.tsinghua.edu.cn/simple rapidocr onnxruntime
```

Then select `RapidOCR (local)` as the OCR engine in preferences; it works offline.

## Configuration

Open the extension preferences and go to **"OCR & Translation"**
(`gnome-extensions prefs gradia-integration@alexandervanhee.github.io`).

| Group | Key settings |
|---|---|
| OCR | Enable OCR, OCR engine |
| RapidOCR | Python interpreter (empty = default venv), language, timeout |
| LLM OCR | Enable switch, base URL, model, API key or key file, proxy, timeout, prompt, extra request body |
| Translation | Enable, provider (none / Google / LLM), target language, inherit LLM OCR configuration, standalone LLM settings, Google proxy |
| Result | Clipboard content (original / translation / both) |

Defaults are intentionally left unconfigured: no base URL, model or API key is prefilled.

### LLM configuration example (never prefilled)

- Any endpoint implementing `POST /chat/completions` and accepting image input works;
- Example: base URL `https://api.deepseek.com`, model `deepseek-flash`;
- Thinking modes add latency and consume `max_tokens`; when the vendor supports it, pass
  `{"thinking": {"type": "disabled"}}` in the extra request body to disable it;
- Prefer a permission-600 key file (the "API key file" row) over a plain dconf value.

## Usage

1. Press `PrtSc` to open the screenshot UI, select an area/window/screen and annotate;
2. Press `Ctrl+E` (or click the scanner button) to recognize the text;
3. When the loading indicator disappears, use the result panel:
   - compare original and translation side by side, scroll for long content;
   - switch engines or target language and press "Recognize again";
   - "Copy Original" / "Copy Translation" fills the clipboard and closes the panel;
   - with translation disabled only the original column is shown.
4. The clipboard content follows the copy mode: `original`, `translation`, or
   `original + blank line + translation`.

## Project layout

```text
src/extension.js            extension entry point (small hooks only)
src/net.js                  network layer: proxy-aware sessions + async JSON requests
src/translate.js            translation: Google / OpenAI-compatible LLM
src/ocr/engine.js           orchestration: OCR -> translation -> clipboard -> result panel
src/ocr/llm.js              multimodal LLM OCR
src/ocr/rapidocr.js         local RapidOCR subprocess
src/ocr/toast.js            result panel and busy indicator
src/ocr/languages.js        translation target language list
src/prefs.js                preferences entry point
src/prefs/ocrPage.js        "OCR & Translation" settings page
python/ocr_helper.py        RapidOCR command line helper (packed with the extension)
scripts/ocr-selftest.sh     self-test comparing the three OCR backends
po/                         gettext template and Simplified Chinese catalog
docs/                       design/decision documents (Chinese)
```

## Development and debugging

```bash
# Syntax check (GNOME extensions are ESM; node needs the .mjs suffix)
for f in src/*.js src/ocr/*.js src/prefs/*.js; do cp "$f" /tmp/chk.mjs; node --check /tmp/chk.mjs || echo "FAIL $f"; done

# Compare the three OCR backends (gradia / rapidocr / llm)
./scripts/ocr-selftest.sh ~/.local/share/gradia-capture/p0-samples/03-mixed.png

# Package / install
./build.sh
./build.sh -i

# Logs
journalctl --user -b -o cat /usr/bin/gnome-shell | grep -i gradia
```

To test new code without logging out of the session, run an additional shell in a nested
session:

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

## Branches and upstream sync

| Branch | Purpose |
|---|---|
| `master` | Upstream mirror, fast-forward only |
| `local` | master + local maintenance commits (GNOME 48 support, gettext/Chinese, license, docs, OCR/translation) |
| `gnome-48-support` / `i18n-gettext-zh_CN` | The two upstream PR branches, kept clean |
| `feature/ocr-translate` | Development branch for the fork-only OCR/translation work |

Syncing with upstream:

```bash
git fetch upstream
git checkout master && git merge --ff-only upstream/master
git checkout local && git rebase master
./build.sh -i
```

Upstream keeps changing the screenshot UI; the main conflict hotspot is `src/extension.js`.
This project deliberately keeps changes limited to new files plus a few hook lines to make
rebases easy. After upgrading GNOME or rebasing, walk through the acceptance checklist in
[CHANGELOG.md](CHANGELOG.md) (Chinese).

## Known limitations

- **No screenshots while recording**: this is a GNOME Shell limitation (the screenshot UI
  `open()` returns immediately while its own screen recorder runs), not introduced by this
  extension. Third-party recorders (OBS, Kooha) are not expected to trigger it.
  Details: `docs/RESEARCH-recording-vs-screenshot.md` (Chinese).
- **Log out and back in after changing JS on Wayland**; `gnome-extensions disable/enable`
  does not reload ES modules.
- The result panel is read-only (inside the shell, `St.Entry` does not get fcitx5
  candidates; see upstream issue #19).
- Only GNOME 48 is tested; the 49–51 entries in `shell-version` come from upstream.
- API keys stored in dconf are plain text; prefer the key file option.

## License and credits

- Based on the upstream [gradia-capture](https://github.com/AlexanderVanhee/gradia-capture),
  licensed under **GPL-3.0-only** (see [LICENSE](LICENSE));
- Upstream author: Alexander Vanhee. This is an **unofficial fork**; the shared name only
  indicates the source;
- Donation links in the preferences and `metadata.json` still point to the original author;
  this fork does not collect donations;
- The [GNOME Code of Conduct](https://conduct.gnome.org) applies to this repository too.

## Changelog

Implementation phases, decisions and acceptance records are documented in
[CHANGELOG.md](CHANGELOG.md) and `docs/` (both in Chinese).
