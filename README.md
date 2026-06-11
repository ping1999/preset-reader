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

## Format Skill Agent

In the panel, choose one preset as the formatting source, then open `Agent API` and configure an OpenAI-compatible `/v1` base endpoint.
The preset list is grouped by `source / type`; groups are collapsed by default and can be expanded from their headers.
The `当前预设` box shows the selected preset at a glance; click it to preview it or remove it from the selection.
The API preset selector stores multiple endpoint/model/key profiles, and the model selector uses a scrollable in-extension dropdown instead of the browser datalist.
The model box automatically fetches available models from `/models`, and generation automatically appends `/chat/completions`.
Agent requests are always sent through SillyTavern's backend, so LAN HTTP APIs, HTTPS SillyTavern pages, and providers that do not allow browser CORS requests can still work.
When building the agent request, the extension recursively scans the selected preset object for prompt text fields such as `content`, `rules`, `format`, and `template`. For shujuku plot presets, a same-name `exportAllPlotPresets` record is used to enrich the displayed preset when it contains more complete content.

After that, click `生成格式 Skill`. The agent reads the selected preset's `content` text, extracts formatting rules such as paired tags, section order, wrapper names, and output-only constraints, then returns a reusable repair prompt/skill. Generated skills are saved in the extension automatically, named after the source preset by default; duplicate names receive a numeric suffix. Use `浏览 Skill` to rename, delete, import, or export saved skills.

Public API:

```js
const result = await window.PresetReaderAPI.generateFormatSkill(items, {
  endpoint: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
  apiKey: '...',
});

const models = await window.PresetReaderAPI.fetchAvailableModels({
  endpoint: 'https://api.openai.com/v1',
  apiKey: '...',
});

const savedSkills = window.PresetReaderAPI.getGeneratedSkills();
```

## Notes

shujuku exposes plot presets and API presets through `window.AutoCardUpdaterAPI`.
Template preset content is not exposed through a public shujuku API, so this extension also tries the known shujuku storage locations in `extension_settings`, Web Storage, and IndexedDB.
