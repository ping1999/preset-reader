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

In the panel, tick the presets that should be used as formatting sources, then open `Agent API` and configure an OpenAI-compatible chat-completions endpoint.
The model box automatically fetches available models from the matching `/models` endpoint derived from the completions URL, and still allows manual model names.
The default request mode is `酒馆后端转发`, which sends model and generation requests through SillyTavern's backend. Use it for LAN HTTP APIs, HTTPS SillyTavern pages, or providers that do not allow browser CORS requests.

After that, click `生成格式 Skill`. The agent reads the selected presets' `content` text, extracts formatting rules such as paired tags, section order, wrapper names, and output-only constraints, then returns a reusable repair prompt/skill. That skill is intended for rewriting already generated text back into the required format without changing its facts.

Public API:

```js
const result = await window.PresetReaderAPI.generateFormatSkill(items, {
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4.1-mini',
  apiKey: '...',
});

const models = await window.PresetReaderAPI.fetchAvailableModels({
  endpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: '...',
});
```

## Notes

shujuku exposes plot presets and API presets through `window.AutoCardUpdaterAPI`.
Template preset content is not exposed through a public shujuku API, so this extension also tries the known shujuku storage locations in `extension_settings`, Web Storage, and IndexedDB.
