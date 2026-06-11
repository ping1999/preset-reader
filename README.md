# Preset Reader

Preset Reader is a SillyTavern third-party extension that reads preset-like data from:

- SillyTavern core preset stores, via `/api/settings/get`
- TavernHelper / JS-Slash-Runner runtime APIs, when `window.TavernHelper` is loaded
- shujuku / SP database APIs, when `window.AutoCardUpdaterAPI` is loaded

The extension is read-only. It does not switch, save, delete, or mutate presets.

## Install

Install this repository as a SillyTavern third-party extension, or copy the repository folder to:

```text
SillyTavern/public/scripts/extensions/third-party/preset-reader
```

Restart or reload SillyTavern, then open the extensions menu and choose `预设读取器`.

## Usage

Open the panel:

```text
/presetreader
```

Dump readable data from all sources:

```text
/presetdump
```

Return only shujuku data as a slash-command object payload:

```text
/presetdump source=shujuku return=object
```

Other extensions or helper scripts can call:

```js
const snapshot = await window.PresetReaderAPI.readAll();
```

## Notes

shujuku exposes plot presets and API presets through `window.AutoCardUpdaterAPI`.
Template preset content is not exposed through a public shujuku API, so this extension also tries the known shujuku storage locations in `extension_settings`, Web Storage, and IndexedDB.
