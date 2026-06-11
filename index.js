import { getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { slashCommandReturnHelper } from '../../../slash-commands/SlashCommandReturnHelper.js';
import { download, escapeHtml } from '../../../utils.js';

const EXTENSION_ID = 'preset-reader';
const API_NAME = 'PresetReaderAPI';
const SHUJUKU_ID = 'shujuku_v120';
const SHUJUKU_TEMPLATE_PRESETS_KEY = `${SHUJUKU_ID}_templatePresets_v1`;
const SHUJUKU_CONFIG_DB = `${SHUJUKU_ID}_config_v1`;
const SHUJUKU_CONFIG_STORE = 'kv';
const AGENT_PRESET_ITEM_LIMIT = 64000;
const AGENT_PRESET_TOTAL_LIMIT = 128000;
const AGENT_SYSTEM_PROMPT = `你是“预设格式修复 Skill 生成 Agent”。
你的任务是阅读用户选中的 SillyTavern 预设 content，提取其中所有对输出格式、XML/HTML 标签、包裹符、章节顺序、字段名、禁止重复、语言风格、思考/正文分离的要求。
你要输出一份可直接交给另一个 AI 使用的“格式修复 skill/提示词”。这份 skill 用来处理已经生成但没有遵守格式的文本：在不改写事实、不扩写剧情、不新增设定的前提下，重新补齐格式、标签、顺序和分段。
输出必须是中文，必须只交付最终 skill/提示词正文，不要解释你如何分析，不要输出对用户预设内容的总结。
如果预设要求使用成对标签，例如 <dm_set>...</dm_set>，必须在 skill 中明确要求保留并补齐这类标签。`;

const DEFAULT_AGENT_SETTINGS = Object.freeze({
    endpoint: 'https://api.openai.com/v1',
    model: '',
    apiKey: '',
    temperature: 0.2,
    maxTokens: 1800,
    activeApiPresetId: 'default',
    apiPresets: [],
    selectedPresetKeys: [],
    generatedSkills: [],
});

let lastSnapshot = null;
let lastFormatSkill = null;
let menuInitialized = false;
let commandsInitialized = false;

function clone(value) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // fall through
        }
    }

    return JSON.parse(JSON.stringify(value));
}

function tryParseJson(value) {
    if (typeof value !== 'string') {
        return { ok: true, value };
    }

    try {
        return { ok: true, value: JSON.parse(value) };
    } catch (error) {
        return { ok: false, value, error: error?.message || String(error) };
    }
}

function safeStringify(value) {
    const seen = new WeakSet();
    return JSON.stringify(value, (key, val) => {
        if (typeof val === 'object' && val !== null) {
            if (seen.has(val)) return '[Circular]';
            seen.add(val);
        }
        return val;
    }, 2);
}

function sanitizeFileName(value) {
    return String(value || 'presets')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 120);
}

function normalizeFilterValue(value) {
    const text = String(value ?? '').trim();
    return text || 'all';
}

function getSettingsRoot() {
    extension_settings[EXTENSION_ID] = extension_settings[EXTENSION_ID] || {};
    extension_settings[EXTENSION_ID].agent = {
        ...DEFAULT_AGENT_SETTINGS,
        ...(extension_settings[EXTENSION_ID].agent || {}),
    };
    normalizeAgentApiPresets(extension_settings[EXTENSION_ID].agent);

    if (!Array.isArray(extension_settings[EXTENSION_ID].agent.selectedPresetKeys)) {
        extension_settings[EXTENSION_ID].agent.selectedPresetKeys = [];
    }
    extension_settings[EXTENSION_ID].agent.selectedPresetKeys = extension_settings[EXTENSION_ID].agent.selectedPresetKeys.slice(0, 1);
    normalizeGeneratedSkills(extension_settings[EXTENSION_ID].agent);

    return extension_settings[EXTENSION_ID];
}

function getAgentSettings() {
    const settings = getSettingsRoot().agent;
    return {
        ...DEFAULT_AGENT_SETTINGS,
        ...settings,
        apiPresets: settings.apiPresets.map(preset => ({ ...preset })),
        selectedPresetKeys: [...(settings.selectedPresetKeys || [])],
        generatedSkills: settings.generatedSkills.map(skill => ({
            ...skill,
            selectedPresets: skill.selectedPresets.map(preset => ({ ...preset })),
        })),
    };
}

function saveAgentSettings(nextSettings) {
    const root = getSettingsRoot();
    root.agent = {
        ...root.agent,
        ...nextSettings,
        endpoint: normalizeAgentBaseEndpoint(nextSettings.endpoint ?? root.agent.endpoint),
        selectedPresetKeys: Array.isArray(nextSettings.selectedPresetKeys)
            ? [...nextSettings.selectedPresetKeys].slice(0, 1)
            : root.agent.selectedPresetKeys,
        generatedSkills: Array.isArray(nextSettings.generatedSkills)
            ? nextSettings.generatedSkills
            : root.agent.generatedSkills,
    };
    normalizeAgentApiPresets(root.agent);
    normalizeGeneratedSkills(root.agent);
    saveSettingsDebounced();
}

function makeSkillId() {
    return `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeGeneratedSkill(skill) {
    const safeSkill = skill && typeof skill === 'object' ? skill : {};
    const selectedPresets = Array.isArray(safeSkill.selectedPresets) ? safeSkill.selectedPresets : [];
    return {
        id: String(safeSkill.id || makeSkillId()),
        name: String(safeSkill.name || '格式修复 Skill'),
        generatedAt: String(safeSkill.generatedAt || new Date().toISOString()),
        model: String(safeSkill.model || ''),
        endpoint: String(safeSkill.endpoint || ''),
        selectedPresets: selectedPresets.map(preset => ({
            source: String(preset.source || ''),
            sourceLabel: String(preset.sourceLabel || ''),
            kind: String(preset.kind || ''),
            kindLabel: String(preset.kindLabel || ''),
            name: String(preset.name || ''),
        })),
        skill: String(safeSkill.skill || ''),
    };
}

function normalizeGeneratedSkills(agentSettings) {
    if (!Array.isArray(agentSettings.generatedSkills)) {
        agentSettings.generatedSkills = [];
    }

    agentSettings.generatedSkills = agentSettings.generatedSkills
        .map(normalizeGeneratedSkill)
        .filter(skill => skill.skill.trim());
}

function createUniqueSkillName(baseName, skills, ignoreId = '') {
    const cleanBaseName = String(baseName || '格式修复 Skill').trim() || '格式修复 Skill';
    const existingNames = new Set(
        skills
            .filter(skill => skill.id !== ignoreId)
            .map(skill => String(skill.name || '').trim()),
    );

    if (!existingNames.has(cleanBaseName)) {
        return cleanBaseName;
    }

    let index = 2;
    while (existingNames.has(`${cleanBaseName} ${index}`)) {
        index += 1;
    }
    return `${cleanBaseName} ${index}`;
}

function makeApiPresetId() {
    return `api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeApiPresetFromSettings(settings, id = makeApiPresetId(), name = '默认') {
    return {
        id,
        name,
        endpoint: normalizeAgentBaseEndpoint(settings.endpoint || DEFAULT_AGENT_SETTINGS.endpoint),
        model: String(settings.model || ''),
        apiKey: String(settings.apiKey || ''),
        temperature: Number(settings.temperature ?? DEFAULT_AGENT_SETTINGS.temperature),
        maxTokens: Number(settings.maxTokens ?? DEFAULT_AGENT_SETTINGS.maxTokens),
    };
}

function normalizeApiPreset(preset, fallback = DEFAULT_AGENT_SETTINGS, index = 0) {
    const safePreset = preset && typeof preset === 'object' ? preset : {};
    return {
        id: String(safePreset.id || (index === 0 ? 'default' : makeApiPresetId())),
        name: String(safePreset.name || (index === 0 ? '默认' : `API 预设 ${index + 1}`)),
        endpoint: normalizeAgentBaseEndpoint(safePreset.endpoint || fallback.endpoint || DEFAULT_AGENT_SETTINGS.endpoint),
        model: String(safePreset.model ?? fallback.model ?? ''),
        apiKey: String(safePreset.apiKey ?? fallback.apiKey ?? ''),
        temperature: Number(safePreset.temperature ?? fallback.temperature ?? DEFAULT_AGENT_SETTINGS.temperature),
        maxTokens: Number(safePreset.maxTokens ?? fallback.maxTokens ?? DEFAULT_AGENT_SETTINGS.maxTokens),
    };
}

function normalizeAgentApiPresets(agentSettings) {
    if (!Array.isArray(agentSettings.apiPresets)) {
        agentSettings.apiPresets = [];
    }

    agentSettings.apiPresets = agentSettings.apiPresets.map((preset, index) => normalizeApiPreset(preset, agentSettings, index));
    if (!agentSettings.apiPresets.length) {
        agentSettings.apiPresets.push(makeApiPresetFromSettings(agentSettings, 'default', '默认'));
    }

    const activeId = String(agentSettings.activeApiPresetId || agentSettings.apiPresets[0].id);
    const activePreset = agentSettings.apiPresets.find(preset => preset.id === activeId) || agentSettings.apiPresets[0];
    agentSettings.activeApiPresetId = activePreset.id;
    Object.assign(agentSettings, {
        endpoint: activePreset.endpoint,
        model: activePreset.model,
        apiKey: activePreset.apiKey,
        temperature: activePreset.temperature,
        maxTokens: activePreset.maxTokens,
    });
}

function makeSelectionKey(item, fallbackIndex = '') {
    return [
        item.source,
        item.kind,
        item.meta?.index ?? fallbackIndex,
        item.name,
    ].map(part => encodeURIComponent(String(part ?? ''))).join('|');
}

function getNameFromContent(content, fallback) {
    if (content && typeof content === 'object') {
        for (const key of ['name', 'display_name', 'title', 'presetName', 'id']) {
            if (typeof content[key] === 'string' && content[key].trim()) {
                return content[key].trim();
            }
        }
    }

    return fallback;
}

function makeItem(source, sourceLabel, kind, kindLabel, name, content, meta = {}) {
    return {
        id: `${source}:${kind}:${meta.index ?? ''}:${name}:${Math.random().toString(36).slice(2)}`,
        source,
        sourceLabel,
        kind,
        kindLabel,
        name: String(name || '未命名'),
        content,
        meta,
        status: meta.status || 'ok',
        warning: meta.warning || '',
    };
}

function makeUnavailableItem(source, sourceLabel, kind, kindLabel, name, reason, meta = {}) {
    return makeItem(source, sourceLabel, kind, kindLabel, name, {
        unavailable: true,
        reason,
    }, { ...meta, status: 'warning', warning: reason });
}

function addJsonStringPresets(items, payload, {
    namesKey,
    valuesKey,
    kind,
    kindLabel,
}) {
    const names = Array.isArray(payload?.[namesKey]) ? payload[namesKey] : [];
    const values = Array.isArray(payload?.[valuesKey]) ? payload[valuesKey] : [];
    const length = Math.max(names.length, values.length);

    for (let index = 0; index < length; index++) {
        const parsed = tryParseJson(values[index] ?? {});
        const content = parsed.value;
        const fallbackName = names[index] || `${kindLabel} ${index + 1}`;
        const name = getNameFromContent(content, fallbackName);
        items.push(makeItem('sillytavern', '酒馆本体', kind, kindLabel, name, content, {
            index,
            fileName: names[index] ? `${names[index]}.json` : '',
            parseError: parsed.ok ? '' : parsed.error,
            raw: values[index] ?? '',
            status: parsed.ok ? 'ok' : 'warning',
            warning: parsed.ok ? '' : `JSON 解析失败：${parsed.error}`,
        }));
    }
}

function addObjectPresets(items, payload, {
    valuesKey,
    kind,
    kindLabel,
}) {
    const values = Array.isArray(payload?.[valuesKey]) ? payload[valuesKey] : [];

    values.forEach((content, index) => {
        const name = getNameFromContent(content, `${kindLabel} ${index + 1}`);
        items.push(makeItem('sillytavern', '酒馆本体', kind, kindLabel, name, content, { index }));
    });
}

async function readSillyTavernPresets(issues) {
    const response = await fetch('/api/settings/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });

    if (!response.ok) {
        throw new Error(`读取 /api/settings/get 失败：HTTP ${response.status}`);
    }

    const payload = await response.json();
    const items = [];

    addJsonStringPresets(items, payload, {
        namesKey: 'openai_setting_names',
        valuesKey: 'openai_settings',
        kind: 'chat-completion',
        kindLabel: '聊天补全预设',
    });

    addJsonStringPresets(items, payload, {
        namesKey: 'textgenerationwebui_preset_names',
        valuesKey: 'textgenerationwebui_presets',
        kind: 'textgen',
        kindLabel: 'TextGen 预设',
    });

    addJsonStringPresets(items, payload, {
        namesKey: 'koboldai_setting_names',
        valuesKey: 'koboldai_settings',
        kind: 'kobold',
        kindLabel: 'KoboldAI 预设',
    });

    addJsonStringPresets(items, payload, {
        namesKey: 'novelai_setting_names',
        valuesKey: 'novelai_settings',
        kind: 'novelai',
        kindLabel: 'NovelAI 预设',
    });

    addObjectPresets(items, payload, {
        valuesKey: 'instruct',
        kind: 'instruct',
        kindLabel: 'Instruct 模板',
    });

    addObjectPresets(items, payload, {
        valuesKey: 'context',
        kind: 'context',
        kindLabel: 'Context 模板',
    });

    addObjectPresets(items, payload, {
        valuesKey: 'sysprompt',
        kind: 'sysprompt',
        kindLabel: '系统提示词',
    });

    addObjectPresets(items, payload, {
        valuesKey: 'reasoning',
        kind: 'reasoning',
        kindLabel: 'Reasoning 模板',
    });

    addObjectPresets(items, payload, {
        valuesKey: 'quickReplyPresets',
        kind: 'quick-reply',
        kindLabel: 'Quick Reply 预设',
    });

    if (!items.length) {
        issues.push('酒馆本体没有返回可识别的预设。');
    }

    return items;
}

function getTavernHelper() {
    return globalThis.TavernHelper || window.TavernHelper || null;
}

function readTavernHelperPresets(issues) {
    const helper = getTavernHelper();
    const items = [];

    if (!helper) {
        issues.push('未检测到 TavernHelper/酒馆助手对象，跳过酒馆助手运行时预设。');
        return items;
    }

    if (typeof helper.getPresetNames === 'function' && typeof helper.getPreset === 'function') {
        try {
            const names = helper.getPresetNames() || [];
            names.forEach((name, index) => {
                try {
                    items.push(makeItem('tavern-helper', '酒馆助手', 'helper-completion', '助手规范化酒馆预设', name, helper.getPreset(name), { index }));
                } catch (error) {
                    items.push(makeUnavailableItem('tavern-helper', '酒馆助手', 'helper-completion', '助手规范化酒馆预设', name, error?.message || String(error), { index }));
                }
            });
        } catch (error) {
            issues.push(`酒馆助手 getPresetNames 调用失败：${error?.message || String(error)}`);
        }
    }

    if (typeof helper.getScriptTrees === 'function') {
        for (const type of ['global', 'preset', 'character']) {
            try {
                const scriptTrees = helper.getScriptTrees({ type }) || [];
                items.push(makeItem('tavern-helper', '酒馆助手', `helper-script-${type}`, `助手脚本树：${type}`, `${type} scripts`, scriptTrees, {
                    index: 0,
                    count: Array.isArray(scriptTrees) ? scriptTrees.length : 0,
                }));
            } catch (error) {
                issues.push(`酒馆助手 ${type} 脚本树读取失败：${error?.message || String(error)}`);
            }
        }
    }

    if (!items.length) {
        issues.push('检测到酒馆助手，但没有读到可识别的预设或脚本树。');
    }

    return items;
}

function getShujukuApi() {
    return globalThis.AutoCardUpdaterAPI || window.AutoCardUpdaterAPI || null;
}

function readShujukuApiPresets(issues) {
    const api = getShujukuApi();
    const items = [];

    if (!api) {
        issues.push('未检测到 window.AutoCardUpdaterAPI，跳过 shujuku 业务预设。');
        return items;
    }

    const apiReaders = [
        {
            method: 'getPlotPresets',
            kind: 'shujuku-plot',
            kindLabel: 'shujuku 剧情推进预设',
        },
        {
            method: 'exportAllPlotPresets',
            kind: 'shujuku-plot-export',
            kindLabel: 'shujuku 剧情推进导出',
        },
        {
            method: 'getApiPresets',
            kind: 'shujuku-api',
            kindLabel: 'shujuku API 预设',
        },
    ];

    for (const reader of apiReaders) {
        if (typeof api[reader.method] !== 'function') {
            continue;
        }

        try {
            const result = api[reader.method]() || [];
            const list = Array.isArray(result) ? result : [result];
            list.forEach((content, index) => {
                const name = getNameFromContent(content, `${reader.kindLabel} ${index + 1}`);
                items.push(makeItem('shujuku', 'shujuku', reader.kind, reader.kindLabel, name, content, {
                    index,
                    method: reader.method,
                }));
            });
        } catch (error) {
            issues.push(`shujuku ${reader.method} 调用失败：${error?.message || String(error)}`);
        }
    }

    if (typeof api.getTableTemplate === 'function') {
        try {
            const template = api.getTableTemplate();
            if (template) {
                items.push(makeItem('shujuku', 'shujuku', 'shujuku-template-current', 'shujuku 当前模板', '当前模板', template, {
                    method: 'getTableTemplate',
                }));
            }
        } catch (error) {
            issues.push(`shujuku getTableTemplate 调用失败：${error?.message || String(error)}`);
        }
    }

    if (typeof api.getTemplatePresetNames === 'function') {
        try {
            const names = api.getTemplatePresetNames() || [];
            names.forEach((name, index) => {
                items.push(makeUnavailableItem('shujuku', 'shujuku', 'shujuku-template-name', 'shujuku 模板预设名', name, '公开 API 只返回模板预设名称；正在尝试从存储读取内容。', {
                    index,
                    method: 'getTemplatePresetNames',
                }));
            });
        } catch (error) {
            issues.push(`shujuku getTemplatePresetNames 调用失败：${error?.message || String(error)}`);
        }
    }

    return mergeRicherShujukuPlotItems(items);
}

function getExtractedPresetTextLength(content) {
    try {
        return extractPresetContentText(content).length;
    } catch {
        return safeStringify(content).length;
    }
}

function mergeRicherShujukuPlotItems(items) {
    const exportedByName = new Map(
        items
            .filter(item => item.kind === 'shujuku-plot-export')
            .map(item => [String(item.name || '').trim(), item]),
    );

    return items.map(item => {
        if (item.kind !== 'shujuku-plot') {
            return item;
        }

        const exported = exportedByName.get(String(item.name || '').trim());
        if (!exported) {
            return item;
        }

        const itemLength = getExtractedPresetTextLength(item.content);
        const exportedLength = getExtractedPresetTextLength(exported.content);
        if (exportedLength <= itemLength) {
            return item;
        }

        return {
            ...item,
            content: clone(exported.content),
            meta: {
                ...item.meta,
                enrichedFrom: exported.kind,
                originalContentLength: itemLength,
                enrichedContentLength: exportedLength,
            },
        };
    });
}

function readTemplateStoreFromExtensionSettings() {
    const namespaces = [
        extension_settings?.__userscripts?.[SHUJUKU_ID],
        window.SillyTavern?.getContext?.()?.extensionSettings?.__userscripts?.[SHUJUKU_ID],
    ].filter(Boolean);

    for (const namespace of namespaces) {
        const raw = namespace?.[SHUJUKU_TEMPLATE_PRESETS_KEY];
        if (raw) {
            const parsed = tryParseJson(raw);
            if (parsed.ok) {
                return { store: parsed.value, backend: 'extension_settings' };
            }
        }
    }

    return null;
}

function readTemplateStoreFromWebStorage(storage, label) {
    if (!storage?.getItem) {
        return null;
    }

    const direct = storage.getItem(SHUJUKU_TEMPLATE_PRESETS_KEY);
    if (direct) {
        const parsed = tryParseJson(direct);
        if (parsed.ok) {
            return { store: parsed.value, backend: label };
        }
    }

    try {
        for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index);
            if (!key || !key.endsWith('_templatePresets_v1')) {
                continue;
            }
            const value = storage.getItem(key);
            const parsed = tryParseJson(value);
            if (parsed.ok && parsed.value?.presets) {
                return { store: parsed.value, backend: `${label}:${key}` };
            }
        }
    } catch {
        // ignore inaccessible storage
    }

    return null;
}

async function readTemplateStoreFromIndexedDb() {
    if (!window.indexedDB) {
        return null;
    }

    if (typeof indexedDB.databases === 'function') {
        try {
            const databases = await indexedDB.databases();
            if (Array.isArray(databases) && !databases.some(db => db?.name === SHUJUKU_CONFIG_DB)) {
                return null;
            }
        } catch {
            // Some browsers restrict databases(); continue with a normal open.
        }
    }

    return await new Promise((resolve) => {
        let request;
        try {
            request = indexedDB.open(SHUJUKU_CONFIG_DB);
        } catch {
            resolve(null);
            return;
        }

        request.onerror = () => resolve(null);
        request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(SHUJUKU_CONFIG_STORE)) {
                db.close();
                resolve(null);
                return;
            }

            const tx = db.transaction(SHUJUKU_CONFIG_STORE, 'readonly');
            const store = tx.objectStore(SHUJUKU_CONFIG_STORE);
            const getReq = store.get(SHUJUKU_TEMPLATE_PRESETS_KEY);
            getReq.onerror = () => {
                db.close();
                resolve(null);
            };
            getReq.onsuccess = () => {
                db.close();
                const raw = getReq.result;
                if (!raw) {
                    resolve(null);
                    return;
                }
                const parsed = tryParseJson(raw);
                resolve(parsed.ok ? { store: parsed.value, backend: 'indexedDB' } : null);
            };
        };
        request.onupgradeneeded = () => {
            request.transaction?.abort?.();
            resolve(null);
        };
    });
}

function addTemplateStoreItems(items, templateStoreInfo, issues) {
    const store = templateStoreInfo?.store;
    const presets = store?.presets;

    if (!presets || typeof presets !== 'object') {
        issues.push('没有在 shujuku 模板预设存储中找到 presets 对象。');
        return;
    }

    Object.entries(presets).forEach(([name, record], index) => {
        const templateStr = record?.templateStr ?? record?.template ?? record;
        const parsed = tryParseJson(templateStr);
        items.push(makeItem('shujuku', 'shujuku', 'shujuku-template', 'shujuku 模板预设', name, parsed.value, {
            index,
            backend: templateStoreInfo.backend,
            updatedAt: record?.updatedAt || null,
            raw: typeof templateStr === 'string' ? templateStr : '',
            status: parsed.ok ? 'ok' : 'warning',
            warning: parsed.ok ? '' : `模板 JSON 解析失败：${parsed.error}`,
        }));
    });
}

async function readShujukuTemplateStorePresets(issues) {
    const items = [];
    const storeInfo = readTemplateStoreFromExtensionSettings()
        || readTemplateStoreFromWebStorage(window.localStorage, 'localStorage')
        || readTemplateStoreFromWebStorage(window.sessionStorage, 'sessionStorage')
        || await readTemplateStoreFromIndexedDb();

    if (!storeInfo) {
        issues.push('未能从 extension_settings、localStorage、sessionStorage 或 IndexedDB 读取 shujuku 模板预设库。');
        return items;
    }

    addTemplateStoreItems(items, storeInfo, issues);
    return items;
}

function mergeTemplateNamePlaceholders(items) {
    const templateNamesWithContent = new Set(
        items
            .filter(item => item.source === 'shujuku' && item.kind === 'shujuku-template')
            .map(item => item.name),
    );

    return items.filter(item => {
        if (item.kind !== 'shujuku-template-name') return true;
        return !templateNamesWithContent.has(item.name);
    });
}

async function readShujukuPresets(issues) {
    const apiItems = readShujukuApiPresets(issues);
    const templateItems = await readShujukuTemplateStorePresets(issues);
    return mergeTemplateNamePlaceholders([...apiItems, ...templateItems]);
}

function summarizeCounts(items) {
    return items.reduce((acc, item) => {
        acc.total += 1;
        acc.sources[item.sourceLabel] = (acc.sources[item.sourceLabel] || 0) + 1;
        acc.kinds[item.kindLabel] = (acc.kinds[item.kindLabel] || 0) + 1;
        return acc;
    }, { total: 0, sources: {}, kinds: {} });
}

function filterItems(items, { source = 'all', kind = 'all', name = '' } = {}) {
    const sourceValue = normalizeFilterValue(source);
    const kindValue = normalizeFilterValue(kind);
    const nameValue = String(name || '').trim().toLowerCase();

    return items.filter(item => {
        if (sourceValue !== 'all' && item.source !== sourceValue) return false;
        if (kindValue !== 'all' && item.kind !== kindValue) return false;
        if (nameValue) {
            const haystack = `${item.name} ${item.sourceLabel} ${item.kindLabel}`.toLowerCase();
            if (!haystack.includes(nameValue)) return false;
        }
        return true;
    });
}

export async function readAll(options = {}) {
    const issues = [];
    let items = [];

    try {
        items = items.concat(await readSillyTavernPresets(issues));
    } catch (error) {
        issues.push(error?.message || String(error));
    }

    try {
        items = items.concat(readTavernHelperPresets(issues));
    } catch (error) {
        issues.push(`酒馆助手读取失败：${error?.message || String(error)}`);
    }

    try {
        items = items.concat(await readShujukuPresets(issues));
    } catch (error) {
        issues.push(`shujuku 读取失败：${error?.message || String(error)}`);
    }

    const filteredItems = filterItems(items, options);
    const snapshot = {
        generatedAt: new Date().toISOString(),
        filters: {
            source: normalizeFilterValue(options.source),
            kind: normalizeFilterValue(options.kind),
            name: String(options.name || ''),
        },
        counts: summarizeCounts(filteredItems),
        issues,
        items: filteredItems.map(item => ({
            source: item.source,
            sourceLabel: item.sourceLabel,
            kind: item.kind,
            kindLabel: item.kindLabel,
            name: item.name,
            status: item.status,
            warning: item.warning,
            meta: item.meta,
            content: item.content,
        })),
    };

    lastSnapshot = snapshot;
    return snapshot;
}

function getContentMetric(content) {
    if (Array.isArray(content)) return `${content.length} 项`;
    if (content && typeof content === 'object') return `${Object.keys(content).length} 键`;
    return `${String(content ?? '').length} 字符`;
}

function renderSummaryText(snapshot) {
    const sourceParts = Object.entries(snapshot.counts.sources)
        .map(([label, count]) => `${label}: ${count}`)
        .join(', ') || '无';

    return [
        `预设读取完成：${snapshot.counts.total} 条`,
        `来源：${sourceParts}`,
        snapshot.issues.length ? `提示：${snapshot.issues.join('；')}` : '',
    ].filter(Boolean).join('\n');
}

function resultToMarkdown(snapshot) {
    const lines = [
        `预设读取完成：${snapshot.counts.total} 条`,
        '',
        ...Object.entries(snapshot.counts.sources).map(([label, count]) => `- ${label}: ${count}`),
    ];

    if (snapshot.issues.length) {
        lines.push('', '提示：');
        snapshot.issues.forEach(issue => lines.push(`- ${issue}`));
    }

    lines.push('', '条目：');
    snapshot.items.forEach(item => {
        lines.push(`- [${item.sourceLabel}/${item.kindLabel}] ${item.name}`);
    });

    return lines.join('\n');
}

function isPromptTextField(key, inherited = false) {
    if (inherited) {
        return true;
    }

    const normalized = String(key || '').trim();
    if (!normalized) {
        return false;
    }

    if (/group|tasks|list|settings|config|presets|entries|items|worldbooks/i.test(normalized)) {
        return false;
    }

    const exactKeys = new Set([
        'content',
        'prompt',
        'system_prompt',
        'systemPrompt',
        'main_prompt',
        'instruction',
        'instructions',
        'rules',
        'format',
        'template',
        'templateStr',
        'text',
        'value',
        'message',
        'prefix',
        'suffix',
        'finalSystemDirective',
    ]);

    return exactKeys.has(normalized) || /content|prompt|rule|format|template|instruction|message|tag|wrap|prefix|suffix|directive/i.test(normalized);
}

function makeContentPathLabel(parent, key) {
    if (typeof key === 'number') {
        return `${parent}[${key}]`;
    }

    if (!parent || parent === 'content') {
        return String(key || 'content');
    }

    return `${parent}.${key}`;
}

function collectTextFromContent(value, parts, seen = new WeakSet(), label = 'content', inTextField = false) {
    if (value == null) {
        return;
    }

    if (typeof value === 'string') {
        const text = value.trim();
        if (text && inTextField) {
            parts.push(`【${label}】\n${text}`);
        }
        return;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return;
    }

    if (Array.isArray(value)) {
        value.forEach((entry, index) => collectTextFromContent(entry, parts, seen, makeContentPathLabel(label, index), inTextField));
        return;
    }

    if (typeof value !== 'object' || seen.has(value)) {
        return;
    }

    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
        const nextIsTextField = isPromptTextField(key, inTextField);
        collectTextFromContent(entry, parts, seen, makeContentPathLabel(label, key), nextIsTextField);
    }
}

function extractPresetContentText(content) {
    const parts = [];
    collectTextFromContent(content, parts, new WeakSet(), 'content', false);

    if (!parts.length) {
        return safeStringify(content);
    }

    return parts.join('\n\n');
}

function limitText(text, limit) {
    const value = String(text || '');
    if (value.length <= limit) {
        return value;
    }

    return `${value.slice(0, limit)}\n\n[内容过长，已截断 ${value.length - limit} 字符]`;
}

function buildAgentUserPrompt(selectedItems) {
    let totalLength = 0;
    const sections = [];

    for (const [index, item] of selectedItems.entries()) {
        if (totalLength >= AGENT_PRESET_TOTAL_LIMIT) {
            sections.push('[后续预设因上下文长度限制已省略]');
            break;
        }

        const rawText = extractPresetContentText(item.content);
        const itemText = limitText(rawText, AGENT_PRESET_ITEM_LIMIT);
        const remaining = AGENT_PRESET_TOTAL_LIMIT - totalLength;
        const finalText = limitText(itemText, remaining);
        totalLength += finalText.length;
        sections.push([
            `## 预设 ${index + 1}: ${item.name}`,
            `来源: ${item.sourceLabel} / ${item.kindLabel}`,
            '```text',
            finalText,
            '```',
        ].join('\n'));
    }

    return [
        '请基于下面这些用户预选预设的 content，生成一份“格式修复 skill/提示词”。',
        '',
        '这份 skill 的使用场景：另一个 AI 已经生成了一段内容，但没有遵守这些预设要求的格式；使用者会把那段未格式化内容交给这个 skill，让 AI 在不改变事实、不扩写、不新增设定的情况下重新补齐格式。',
        '',
        'skill 必须包含：',
        '- 对输入文本的占位说明，例如“待修复文本”。',
        '- 从预设中抽取到的标签、包裹符、章节顺序、字段名、换行规则和禁止项。',
        '- 明确要求保留原文事实、角色、事件、时间线，不新增剧情。',
        '- 明确要求只输出修复后的文本，不解释修复过程。',
        '- 如果存在 <xxx>...</xxx> 这类标签，必须要求成对补齐并把对应内容放入标签内。',
        '',
        '用户预选预设 content：',
        '',
        sections.join('\n\n'),
    ].join('\n');
}

function normalizeAgentBaseEndpoint(endpoint) {
    const trimmed = String(endpoint || '').trim().replace(/\/+$/, '');
    if (!trimmed) {
        return '';
    }

    if (/\/chat\/completions$/i.test(trimmed)) {
        return trimmed.replace(/\/chat\/completions$/i, '');
    }

    if (/\/completions$/i.test(trimmed)) {
        return trimmed.replace(/\/completions$/i, '');
    }

    if (/\/models$/i.test(trimmed)) {
        return trimmed.replace(/\/models$/i, '');
    }

    if (/\/v1$/i.test(trimmed)) {
        return trimmed;
    }

    return `${trimmed}/v1`;
}

function makeSillyTavernBackendPayload(settings, extra = {}) {
    return {
        chat_completion_source: 'openai',
        reverse_proxy: normalizeAgentBaseEndpoint(settings.endpoint),
        proxy_password: settings.apiKey || '',
        stream: false,
        ...extra,
    };
}

async function fetchAvailableModels(settings = getAgentSettings()) {
    return fetchAvailableModelsViaSillyTavern(settings);
}

async function fetchAvailableModelsViaSillyTavern(settings = getAgentSettings()) {
    const reverseProxy = normalizeAgentBaseEndpoint(settings.endpoint);
    if (!reverseProxy) {
        throw new Error('请先填写 API 地址。');
    }

    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(makeSillyTavernBackendPayload(settings)),
    });
    const responseText = await response.text();
    let payload = null;

    try {
        payload = responseText ? JSON.parse(responseText) : null;
    } catch {
        payload = null;
    }

    if (!response.ok || payload?.error) {
        throw new Error(payload?.error?.message || payload?.message || responseText || `模型列表读取失败：HTTP ${response.status}`);
    }

    const models = Array.isArray(payload?.data)
        ? payload.data.map(model => model?.id).filter(Boolean)
        : [];

    return [...new Set(models)].sort((a, b) => a.localeCompare(b));
}

function extractAgentResponseText(payload) {
    if (typeof payload?.output_text === 'string') {
        return payload.output_text;
    }

    const firstChoice = payload?.choices?.[0];
    if (typeof firstChoice?.message?.content === 'string') {
        return firstChoice.message.content;
    }

    if (Array.isArray(firstChoice?.message?.content)) {
        return firstChoice.message.content
            .map(part => part?.text || part?.content || '')
            .filter(Boolean)
            .join('\n');
    }

    if (typeof firstChoice?.text === 'string') {
        return firstChoice.text;
    }

    if (Array.isArray(payload?.output)) {
        return payload.output
            .flatMap(item => Array.isArray(item?.content) ? item.content : [])
            .map(part => part?.text || '')
            .filter(Boolean)
            .join('\n');
    }

    return '';
}

function rememberFormatSkillResult(skillText, model, endpoint, selectedItems) {
    const settings = getAgentSettings();
    const selectedPresets = selectedItems.map(item => ({
        source: item.source,
        sourceLabel: item.sourceLabel,
        kind: item.kind,
        kindLabel: item.kindLabel,
        name: item.name,
    }));
    const savedSkill = normalizeGeneratedSkill({
        id: makeSkillId(),
        name: createUniqueSkillName(selectedPresets[0]?.name || '格式修复 Skill', settings.generatedSkills),
        generatedAt: new Date().toISOString(),
        model,
        endpoint,
        selectedPresets,
        skill: skillText,
    });

    saveAgentSettings({ generatedSkills: [savedSkill, ...settings.generatedSkills] });
    lastFormatSkill = clone(savedSkill);
    return lastFormatSkill;
}

async function generateFormatSkillViaSillyTavern(selectedItems, settings, model, endpoint) {
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(makeSillyTavernBackendPayload(settings, {
            model,
            messages: [
                { role: 'system', content: AGENT_SYSTEM_PROMPT },
                { role: 'user', content: buildAgentUserPrompt(selectedItems) },
            ],
            temperature: Number(settings.temperature ?? DEFAULT_AGENT_SETTINGS.temperature),
            max_tokens: Number(settings.maxTokens ?? DEFAULT_AGENT_SETTINGS.maxTokens),
        })),
    });

    const responseText = await response.text();
    let payload = null;

    try {
        payload = responseText ? JSON.parse(responseText) : null;
    } catch {
        payload = null;
    }

    if (!response.ok || payload?.error) {
        throw new Error(payload?.error?.message || payload?.message || responseText || `Agent API 请求失败：HTTP ${response.status}`);
    }

    const skillText = extractAgentResponseText(payload).trim();
    if (!skillText) {
        throw new Error('Agent API 没有返回可用文本。');
    }

    return rememberFormatSkillResult(skillText, model, endpoint, selectedItems);
}

async function generateFormatSkill(selectedItems, settings = getAgentSettings()) {
    const backendEndpoint = normalizeAgentBaseEndpoint(settings.endpoint);
    const model = String(settings.model || '').trim();

    if (!selectedItems.length) {
        throw new Error('请先勾选要交给 Agent 分析的预设。');
    }

    if (selectedItems.length > 1) {
        throw new Error('一次只能选择一个预设生成 Skill。');
    }

    if (!backendEndpoint) {
        throw new Error('请先配置 Agent API 地址。');
    }

    if (!model) {
        throw new Error('请先配置 Agent 模型名。');
    }

    return generateFormatSkillViaSillyTavern(selectedItems, settings, model, backendEndpoint);
}

function makePopupHtml() {
    return $(`
        <div id="${EXTENSION_ID}-panel" class="preset-reader-panel">
            <div class="preset-reader-toolbar">
                <button id="${EXTENSION_ID}-agent-settings" class="menu_button">
                    <i class="fa-solid fa-key"></i>
                    <span>Agent API</span>
                </button>
                <button id="${EXTENSION_ID}-saved-skills" class="menu_button">
                    <i class="fa-solid fa-folder-open"></i>
                    <span>浏览 Skill</span>
                </button>
                <button id="${EXTENSION_ID}-generate-skill" class="menu_button">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>生成格式 Skill</span>
                </button>
                <span id="${EXTENSION_ID}-selected-count" class="preset-reader-selected-count">未选择</span>
            </div>
            <div class="preset-reader-filters">
                <label>
                    <span>来源</span>
                    <select id="${EXTENSION_ID}-source"></select>
                </label>
                <label>
                    <span>类型</span>
                    <select id="${EXTENSION_ID}-kind"></select>
                </label>
                <label class="preset-reader-search">
                    <span>搜索</span>
                    <input id="${EXTENSION_ID}-search" type="search" placeholder="名称 / 类型 / 来源">
                </label>
            </div>
            <div id="${EXTENSION_ID}-status" class="preset-reader-status">正在读取...</div>
            <div class="preset-reader-selected-panel">
                <div class="preset-reader-selected-panel-header">
                    <strong>当前预设</strong>
                    <small id="${EXTENSION_ID}-selected-summary">选择一个预设后显示</small>
                </div>
                <div id="${EXTENSION_ID}-selected-list" class="preset-reader-selected-list">
                    <span class="preset-reader-selected-empty">未选择</span>
                </div>
            </div>
            <div class="preset-reader-layout">
                <div id="${EXTENSION_ID}-list" class="preset-reader-list"></div>
                <div class="preset-reader-preview">
                    <div class="preset-reader-preview-header">
                        <div>
                            <strong id="${EXTENSION_ID}-preview-title">未选择</strong>
                            <small id="${EXTENSION_ID}-preview-meta"></small>
                        </div>
                    </div>
                    <pre id="${EXTENSION_ID}-preview-content"></pre>
                </div>
            </div>
        </div>
    `);
}

function getUiFilters(root) {
    return {
        source: root.find(`#${EXTENSION_ID}-source`).val() || 'all',
        kind: root.find(`#${EXTENSION_ID}-kind`).val() || 'all',
        name: root.find(`#${EXTENSION_ID}-search`).val() || '',
    };
}

function setSelectOptions(select, entries, allLabel) {
    const current = select.val() || 'all';
    select.empty();
    select.append($('<option></option>', { value: 'all', text: allLabel }));
    entries.forEach(entry => select.append($('<option></option>', { value: entry.value, text: entry.label })));
    select.val(entries.some(entry => entry.value === current) ? current : 'all');
}

function refreshFilterOptions(root, items) {
    const sources = [...new Map(items.map(item => [item.source, { value: item.source, label: item.sourceLabel }])).values()]
        .sort((a, b) => a.label.localeCompare(b.label));
    const kinds = [...new Map(items.map(item => [item.kind, { value: item.kind, label: item.kindLabel }])).values()]
        .sort((a, b) => a.label.localeCompare(b.label));

    setSelectOptions(root.find(`#${EXTENSION_ID}-source`), sources, '全部来源');
    setSelectOptions(root.find(`#${EXTENSION_ID}-kind`), kinds, '全部类型');
}

function groupItems(items) {
    const groups = new Map();
    items.forEach(item => {
        const key = `${item.sourceLabel} / ${item.kindLabel}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    });
    return groups;
}

function getExpandedGroups(root) {
    let groups = root.data('expanded-groups');
    if (!(groups instanceof Set)) {
        groups = new Set();
        root.data('expanded-groups', groups);
    }
    return groups;
}

function getPreselectedKeys(root) {
    let keys = root.data('preselected-keys');
    if (!(keys instanceof Set)) {
        keys = new Set(getAgentSettings().selectedPresetKeys.slice(0, 1));
        root.data('preselected-keys', keys);
    } else if (keys.size > 1) {
        const firstKey = [...keys][0];
        keys.clear();
        if (firstKey) {
            keys.add(firstKey);
        }
    }
    return keys;
}

function savePreselectedKeys(root) {
    const keys = getPreselectedKeys(root);
    saveAgentSettings({ selectedPresetKeys: [...keys] });
}

function getPreselectedItems(root) {
    const keys = getPreselectedKeys(root);
    const allItems = root.data('all-items') || [];
    return allItems.filter(item => keys.has(item.selectionKey));
}

function previewItemFromSelection(root, item) {
    const list = root.find(`#${EXTENSION_ID}-list`);
    list.find('.preset-reader-item').removeClass('is-selected');
    list.find(`[data-selection-key="${CSS.escape(item.selectionKey)}"] .preset-reader-item`).addClass('is-selected');
    renderPreview(root, item);
}

function renderPreselectedPanel(root) {
    const selectedItems = getPreselectedItems(root);
    const selectedList = root.find(`#${EXTENSION_ID}-selected-list`);
    const summary = root.find(`#${EXTENSION_ID}-selected-summary`);

    summary.text(selectedItems.length ? `${selectedItems[0].sourceLabel} / ${selectedItems[0].kindLabel}` : '选择一个预设后显示');
    selectedList.empty();

    if (!selectedItems.length) {
        selectedList.append($('<span class="preset-reader-selected-empty"></span>').text('未选择'));
        return;
    }

    selectedItems.forEach(item => {
        const row = $(`
            <div class="preset-reader-selected-pill">
                <button class="preset-reader-selected-preview" type="button">
                    <strong></strong>
                    <small></small>
                </button>
                <button class="preset-reader-selected-remove" type="button" aria-label="移除预选">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        `);
        row.find('strong').text(item.name);
        row.find('small').text(`${item.sourceLabel} / ${item.kindLabel}`);
        row.find('.preset-reader-selected-preview').on('click', () => previewItemFromSelection(root, item));
        row.find('.preset-reader-selected-remove').on('click', () => {
            getPreselectedKeys(root).delete(item.selectionKey);
            savePreselectedKeys(root);
            renderList(root, root.data('all-items') || []);
        });
        selectedList.append(row);
    });
}

function updateSelectedCount(root) {
    const count = getPreselectedItems(root).length;
    root.find(`#${EXTENSION_ID}-selected-count`).text(count ? '已选择 1/1' : '未选择');
    root.find(`#${EXTENSION_ID}-generate-skill`).prop('disabled', count !== 1);
    renderPreselectedPanel(root);
}

function renderList(root, allItems) {
    const list = root.find(`#${EXTENSION_ID}-list`);
    const filtered = filterItems(allItems, getUiFilters(root));
    const preselectedKeys = getPreselectedKeys(root);
    const selectedItem = root.data('selected-item');
    const expandedGroups = getExpandedGroups(root);
    list.empty();

    if (!filtered.length) {
        list.append($('<div class="preset-reader-empty"></div>').text('没有匹配的预设'));
        renderPreview(root, null);
        updateSelectedCount(root);
        return;
    }

    for (const [group, items] of groupItems(filtered)) {
        const isExpanded = expandedGroups.has(group);
        const groupHeader = $(`
            <button class="preset-reader-group" type="button">
                <i class="fa-solid fa-chevron-right"></i>
                <span></span>
                <small></small>
            </button>
        `);
        groupHeader.toggleClass('is-expanded', isExpanded);
        groupHeader.find('span').text(group);
        groupHeader.find('small').text(`${items.length}`);
        groupHeader.on('click', () => {
            if (expandedGroups.has(group)) {
                expandedGroups.delete(group);
            } else {
                expandedGroups.add(group);
            }
            renderList(root, allItems);
        });
        list.append(groupHeader);
        if (!isExpanded) {
            continue;
        }

        items.forEach(item => {
            const row = $(`
                <div class="preset-reader-item-row">
                    <label class="preset-reader-preselect-wrap">
                        <input class="preset-reader-preselect" type="radio" name="${EXTENSION_ID}-preselect" aria-label="选择给 Agent">
                    </label>
                    <button class="preset-reader-item" type="button">
                        <span class="preset-reader-item-name"></span>
                        <small></small>
                    </button>
                </div>
            `);
            const itemButton = row.find('.preset-reader-item');
            const checkbox = row.find('.preset-reader-preselect');
            row.attr('data-id', item.id);
            row.attr('data-selection-key', item.selectionKey);
            itemButton.toggleClass('is-warning', item.status === 'warning');
            itemButton.toggleClass('is-selected', selectedItem?.selectionKey === item.selectionKey);
            checkbox.prop('checked', preselectedKeys.has(item.selectionKey));
            row.find('.preset-reader-item-name').text(item.name);
            row.find('small').text(`${getContentMetric(item.content)}${item.warning ? ' / 有提示' : ''}`);
            checkbox.on('change', () => {
                if (checkbox.prop('checked')) {
                    preselectedKeys.clear();
                    preselectedKeys.add(item.selectionKey);
                    list.find('.preset-reader-item').removeClass('is-selected');
                    itemButton.addClass('is-selected');
                    renderPreview(root, item);
                }
                savePreselectedKeys(root);
                list.find('.preset-reader-preselect').prop('checked', false);
                checkbox.prop('checked', preselectedKeys.has(item.selectionKey));
                updateSelectedCount(root);
            });
            itemButton.on('click', () => {
                list.find('.preset-reader-item').removeClass('is-selected');
                itemButton.addClass('is-selected');
                renderPreview(root, item);
            });
            list.append(row);
        });
    }

    const previewItem = filtered.find(item => item.selectionKey === selectedItem?.selectionKey) || filtered[0];
    list.find(`[data-selection-key="${CSS.escape(previewItem.selectionKey)}"] .preset-reader-item`).addClass('is-selected');
    renderPreview(root, previewItem);
    updateSelectedCount(root);
}

function renderPreview(root, item) {
    const title = root.find(`#${EXTENSION_ID}-preview-title`);
    const meta = root.find(`#${EXTENSION_ID}-preview-meta`);
    const content = root.find(`#${EXTENSION_ID}-preview-content`);

    if (!item) {
        title.text('未选择');
        meta.text('');
        content.text('');
        root.data('selected-item', null);
        return;
    }

    title.text(item.name);
    meta.text(`${item.sourceLabel} / ${item.kindLabel}${item.warning ? ` / ${item.warning}` : ''}`);
    content.text(safeStringify(item.content));
    root.data('selected-item', item);
}

function renderStatus(root, snapshot) {
    const issueHtml = snapshot.issues.length
        ? `<div class="preset-reader-issues">${snapshot.issues.map(issue => `<div>${escapeHtml(issue)}</div>`).join('')}</div>`
        : '';
    root.find(`#${EXTENSION_ID}-status`).html(`${escapeHtml(renderSummaryText(snapshot))}${issueHtml}`);
}

async function loadIntoPanel(root) {
    root.find(`#${EXTENSION_ID}-status`).text('正在读取...');
    const snapshot = await readAll();
    const allItems = snapshot.items.map((item, index) => ({
        id: `${item.source}:${item.kind}:${index}:${item.name}`,
        selectionKey: makeSelectionKey(item, index),
        ...item,
    }));

    if (!(root.data('preselected-keys') instanceof Set)) {
        root.data('preselected-keys', new Set(getAgentSettings().selectedPresetKeys.slice(0, 1)));
    }
    root.data('all-items', allItems);
    refreshFilterOptions(root, allItems);
    renderStatus(root, snapshot);
    renderList(root, allItems);
}

function setAgentSettingsForm(root, preset) {
    root.find(`#${EXTENSION_ID}-agent-endpoint`).val(normalizeAgentBaseEndpoint(preset.endpoint));
    root.find(`#${EXTENSION_ID}-agent-model`).val(preset.model || '');
    root.find(`#${EXTENSION_ID}-agent-api-key`).val(preset.apiKey || '');
    root.find(`#${EXTENSION_ID}-agent-temperature`).val(preset.temperature ?? DEFAULT_AGENT_SETTINGS.temperature);
    root.find(`#${EXTENSION_ID}-agent-max-tokens`).val(preset.maxTokens ?? DEFAULT_AGENT_SETTINGS.maxTokens);
}

function renderApiPresetOptions(root) {
    const settings = getAgentSettings();
    const select = root.find(`#${EXTENSION_ID}-agent-api-preset`);
    select.empty();
    settings.apiPresets.forEach(preset => {
        select.append($('<option></option>', { value: preset.id, text: preset.name }));
    });
    select.val(settings.activeApiPresetId);
}

function getActiveApiPreset() {
    const settings = getAgentSettings();
    return settings.apiPresets.find(preset => preset.id === settings.activeApiPresetId) || settings.apiPresets[0];
}

function saveCurrentApiPreset(root) {
    const formSettings = readAgentSettingsForm(root);
    const settings = getAgentSettings();
    const activeId = formSettings.activeApiPresetId || settings.activeApiPresetId;
    const currentPreset = settings.apiPresets.find(preset => preset.id === activeId) || settings.apiPresets[0];
    const nextPreset = {
        ...currentPreset,
        ...makeApiPresetFromSettings(formSettings, activeId, currentPreset?.name || '默认'),
    };
    const nextPresets = settings.apiPresets.map(preset => preset.id === activeId ? nextPreset : preset);

    saveAgentSettings({
        ...formSettings,
        activeApiPresetId: activeId,
        apiPresets: nextPresets,
    });
    renderApiPresetOptions(root);
    toastr.success('API 预设已保存');
}

function applyApiPresetToForm(root, presetId) {
    const settings = getAgentSettings();
    const preset = settings.apiPresets.find(item => item.id === presetId) || settings.apiPresets[0];
    if (!preset) {
        return;
    }

    root.find(`#${EXTENSION_ID}-agent-api-preset`).val(preset.id);
    setAgentSettingsForm(root, preset);
    root.data('available-models', []);
    hideModelOptions(root);
    saveAgentSettings({
        activeApiPresetId: preset.id,
        apiPresets: settings.apiPresets,
    });
    loadAgentModelsIntoSettings(root, { silent: true });
}

function showApiPresetEditor(root) {
    const settings = getAgentSettings();
    const preset = getActiveApiPreset();
    const editor = $(`
        <div class="preset-reader-api-preset-editor">
            <label>
                <span>预设名称</span>
                <input id="${EXTENSION_ID}-api-preset-name" type="text">
            </label>
            <div class="preset-reader-api-preset-editor-actions">
                <button id="${EXTENSION_ID}-api-preset-rename" class="menu_button" type="button">
                    <i class="fa-solid fa-pen"></i>
                    <span>重命名</span>
                </button>
                <button id="${EXTENSION_ID}-api-preset-new" class="menu_button" type="button">
                    <i class="fa-solid fa-plus"></i>
                    <span>另存为新预设</span>
                </button>
                <button id="${EXTENSION_ID}-api-preset-delete" class="menu_button" type="button">
                    <i class="fa-solid fa-trash"></i>
                    <span>删除</span>
                </button>
            </div>
        </div>
    `);
    editor.find(`#${EXTENSION_ID}-api-preset-name`).val(preset?.name || '默认');

    editor.find(`#${EXTENSION_ID}-api-preset-rename`).on('click', () => {
        const name = String(editor.find(`#${EXTENSION_ID}-api-preset-name`).val() || '').trim();
        if (!name) {
            toastr.warning('请填写预设名称');
            return;
        }

        const currentSettings = getAgentSettings();
        const activeId = String(root.find(`#${EXTENSION_ID}-agent-api-preset`).val() || currentSettings.activeApiPresetId);
        const activePreset = currentSettings.apiPresets.find(item => item.id === activeId) || currentSettings.apiPresets[0];
        const nextPresets = currentSettings.apiPresets.map(item => item.id === activePreset.id ? { ...item, name } : item);
        saveAgentSettings({ activeApiPresetId: activePreset.id, apiPresets: nextPresets });
        renderApiPresetOptions(root);
        toastr.success('API 预设已重命名');
    });

    editor.find(`#${EXTENSION_ID}-api-preset-new`).on('click', () => {
        const name = String(editor.find(`#${EXTENSION_ID}-api-preset-name`).val() || '').trim() || '新 API 预设';
        const formSettings = readAgentSettingsForm(root);
        const currentSettings = getAgentSettings();
        const id = makeApiPresetId();
        const nextPreset = makeApiPresetFromSettings(formSettings, id, name);
        saveAgentSettings({
            ...formSettings,
            activeApiPresetId: id,
            apiPresets: [...currentSettings.apiPresets, nextPreset],
        });
        renderApiPresetOptions(root);
        applyApiPresetToForm(root, id);
        toastr.success('已另存为新 API 预设');
    });

    editor.find(`#${EXTENSION_ID}-api-preset-delete`).on('click', () => {
        const currentSettings = getAgentSettings();
        const activeId = String(root.find(`#${EXTENSION_ID}-agent-api-preset`).val() || currentSettings.activeApiPresetId);
        const activePreset = currentSettings.apiPresets.find(item => item.id === activeId) || currentSettings.apiPresets[0];
        if (currentSettings.apiPresets.length <= 1) {
            toastr.warning('至少保留一个 API 预设');
            return;
        }

        const nextPresets = currentSettings.apiPresets.filter(item => item.id !== activePreset.id);
        const nextActive = nextPresets[0];
        saveAgentSettings({ activeApiPresetId: nextActive.id, apiPresets: nextPresets });
        renderApiPresetOptions(root);
        applyApiPresetToForm(root, nextActive.id);
        toastr.success('API 预设已删除');
    });

    callGenericPopup(editor, POPUP_TYPE.TEXT, '修改 API 预设', {
        wide: true,
        allowVerticalScrolling: true,
    });
}

function makeAgentSettingsHtml() {
    const settings = getAgentSettings();
    return $(`
        <div class="preset-reader-agent-settings">
            <label>
                <span>API 预设</span>
                <div class="preset-reader-api-preset-row">
                    <select id="${EXTENSION_ID}-agent-api-preset"></select>
                    <button id="${EXTENSION_ID}-agent-edit-preset" class="menu_button" type="button">
                        <i class="fa-solid fa-pen-to-square"></i>
                        <span>修改</span>
                    </button>
                    <button id="${EXTENSION_ID}-agent-save-preset" class="menu_button" type="button">
                        <i class="fa-solid fa-floppy-disk"></i>
                        <span>保存</span>
                    </button>
                </div>
            </label>
            <label>
                <span>API 地址</span>
                <input id="${EXTENSION_ID}-agent-endpoint" type="text" placeholder="https://api.openai.com/v1">
            </label>
            <label>
                <span>模型</span>
                <div class="preset-reader-model-field">
                    <input id="${EXTENSION_ID}-agent-model" type="text" autocomplete="off" placeholder="gpt-4.1-mini">
                    <button id="${EXTENSION_ID}-agent-refresh-models" class="menu_button" type="button">
                        <i class="fa-solid fa-cloud-arrow-down"></i>
                        <span>获取模型</span>
                    </button>
                </div>
                <div id="${EXTENSION_ID}-agent-model-list" class="preset-reader-model-options" hidden></div>
                <small id="${EXTENSION_ID}-agent-model-status" class="preset-reader-agent-model-status">打开后会自动读取可用模型。</small>
            </label>
            <label>
                <span>API Key</span>
                <input id="${EXTENSION_ID}-agent-api-key" type="password" autocomplete="off">
            </label>
            <div class="preset-reader-agent-settings-grid">
                <label>
                    <span>Temperature</span>
                    <input id="${EXTENSION_ID}-agent-temperature" type="number" min="0" max="2" step="0.1">
                </label>
                <label>
                    <span>Max Tokens</span>
                    <input id="${EXTENSION_ID}-agent-max-tokens" type="number" min="256" max="32000" step="128">
                </label>
            </div>
            <div class="preset-reader-agent-settings-actions">
                <button id="${EXTENSION_ID}-agent-save" class="menu_button">
                    <i class="fa-solid fa-floppy-disk"></i>
                    <span>保存配置</span>
                </button>
            </div>
        </div>
    `).each((_, root) => {
        const panel = $(root);
        renderApiPresetOptions(panel);
        panel.find(`#${EXTENSION_ID}-agent-endpoint`).val(normalizeAgentBaseEndpoint(settings.endpoint));
        panel.find(`#${EXTENSION_ID}-agent-model`).val(settings.model);
        panel.find(`#${EXTENSION_ID}-agent-api-key`).val(settings.apiKey);
        panel.find(`#${EXTENSION_ID}-agent-temperature`).val(settings.temperature);
        panel.find(`#${EXTENSION_ID}-agent-max-tokens`).val(settings.maxTokens);
    });
}

function readAgentSettingsForm(root) {
    const temperature = Number(root.find(`#${EXTENSION_ID}-agent-temperature`).val());
    const maxTokens = Number(root.find(`#${EXTENSION_ID}-agent-max-tokens`).val());

    return {
        endpoint: normalizeAgentBaseEndpoint(root.find(`#${EXTENSION_ID}-agent-endpoint`).val()),
        activeApiPresetId: String(root.find(`#${EXTENSION_ID}-agent-api-preset`).val() || getAgentSettings().activeApiPresetId),
        model: String(root.find(`#${EXTENSION_ID}-agent-model`).val() || '').trim(),
        apiKey: String(root.find(`#${EXTENSION_ID}-agent-api-key`).val() || '').trim(),
        temperature: Number.isFinite(temperature) ? temperature : DEFAULT_AGENT_SETTINGS.temperature,
        maxTokens: Number.isFinite(maxTokens) ? maxTokens : DEFAULT_AGENT_SETTINGS.maxTokens,
    };
}

function hideModelOptions(root) {
    root.find(`#${EXTENSION_ID}-agent-model-list`).prop('hidden', true);
}

function renderModelOptions(root, models = root.data('available-models') || []) {
    const input = root.find(`#${EXTENSION_ID}-agent-model`);
    const list = root.find(`#${EXTENSION_ID}-agent-model-list`);
    const query = String(input.val() || '').trim().toLowerCase();
    const filteredModels = models.filter(model => !query || model.toLowerCase().includes(query));

    list.empty();
    if (!models.length) {
        list.append($('<div class="preset-reader-model-empty"></div>').text('暂无模型列表'));
    } else if (!filteredModels.length) {
        list.append($('<div class="preset-reader-model-empty"></div>').text('没有匹配的模型'));
    } else {
        filteredModels.forEach(model => {
            const option = $('<button class="preset-reader-model-option" type="button"></button>').text(model);
            option.toggleClass('is-current', model === input.val());
            option.on('click', () => {
                input.val(model);
                hideModelOptions(root);
            });
            list.append(option);
        });
    }

    list.prop('hidden', false);
}

async function loadAgentModelsIntoSettings(root, { silent = false } = {}) {
    const modelInput = root.find(`#${EXTENSION_ID}-agent-model`);
    const modelList = root.find(`#${EXTENSION_ID}-agent-model-list`);
    const status = root.find(`#${EXTENSION_ID}-agent-model-status`);
    const button = root.find(`#${EXTENSION_ID}-agent-refresh-models`);
    const settings = readAgentSettingsForm(root);

    if (!settings.endpoint) {
        status.text('请先填写 API 地址。');
        return [];
    }

    try {
        button.prop('disabled', true);
        status.text('正在读取可用模型...');
        const models = await fetchAvailableModels(settings);
        root.data('available-models', models);

        if (!modelInput.val() && models.length) {
            modelInput.val(models[0]);
        }

        status.text(models.length ? `已读取 ${models.length} 个模型。` : 'API 没有返回模型列表。');
        if (models.length) {
            renderModelOptions(root, models);
            if (silent) {
                hideModelOptions(root);
            }
        } else {
            modelList.empty();
            hideModelOptions(root);
        }
        return models;
    } catch (error) {
        const message = error?.message || String(error);
        status.text(`模型读取失败：${message}`);
        root.data('available-models', []);
        modelList.empty();
        hideModelOptions(root);
        if (!silent) {
            toastr.error(message);
        }
        return [];
    } finally {
        button.prop('disabled', false);
    }
}

function showAgentSettings() {
    const root = makeAgentSettingsHtml();
    let modelFetchTimer = null;

    const scheduleModelFetch = () => {
        clearTimeout(modelFetchTimer);
        modelFetchTimer = setTimeout(() => {
            loadAgentModelsIntoSettings(root, { silent: true });
        }, 500);
    };

    root.find(`#${EXTENSION_ID}-agent-api-preset`).on('change', event => applyApiPresetToForm(root, event.target.value));
    root.find(`#${EXTENSION_ID}-agent-edit-preset`).on('click', () => showApiPresetEditor(root));
    root.find(`#${EXTENSION_ID}-agent-save-preset, #${EXTENSION_ID}-agent-save`).on('click', () => {
        saveCurrentApiPreset(root);
        loadAgentModelsIntoSettings(root, { silent: true });
    });
    root.find(`#${EXTENSION_ID}-agent-refresh-models`).on('click', () => loadAgentModelsIntoSettings(root));
    root.find(`#${EXTENSION_ID}-agent-endpoint, #${EXTENSION_ID}-agent-api-key`).on('change blur', scheduleModelFetch);
    root.find(`#${EXTENSION_ID}-agent-model`).on('focus input', () => renderModelOptions(root));
    root.find(`#${EXTENSION_ID}-agent-model`).on('keydown', event => {
        if (event.key === 'Escape') {
            hideModelOptions(root);
        }
    });
    root.on('click', event => {
        if (!$(event.target).closest('.preset-reader-model-field, .preset-reader-model-options').length) {
            hideModelOptions(root);
        }
    });

    callGenericPopup(root, POPUP_TYPE.TEXT, 'Preset Reader Agent API', {
        wide: true,
        allowVerticalScrolling: true,
    });

    loadAgentModelsIntoSettings(root, { silent: true });
}

function getGeneratedSkills() {
    return getAgentSettings().generatedSkills;
}

function saveGeneratedSkills(skills) {
    saveAgentSettings({ generatedSkills: skills });
}

function formatSavedSkillDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    return date.toLocaleString();
}

function getSavedSkillSourceText(skill) {
    const preset = skill.selectedPresets?.[0];
    if (!preset) {
        return '未知预设';
    }

    return `${preset.sourceLabel || preset.source} / ${preset.kindLabel || preset.kind}`;
}

function showSavedSkillsBrowser() {
    const root = $(`
        <div class="preset-reader-skill-browser">
            <div class="preset-reader-skill-browser-sidebar">
                <div id="${EXTENSION_ID}-skill-browser-list" class="preset-reader-skill-browser-list"></div>
            </div>
            <div class="preset-reader-skill-browser-main">
                <div class="preset-reader-skill-browser-toolbar">
                    <input id="${EXTENSION_ID}-skill-browser-name" type="text" placeholder="Skill 名称">
                    <button id="${EXTENSION_ID}-skill-browser-rename" class="menu_button" type="button">
                        <i class="fa-solid fa-pen"></i>
                        <span>改名</span>
                    </button>
                    <button id="${EXTENSION_ID}-skill-browser-export" class="menu_button" type="button">
                        <i class="fa-solid fa-download"></i>
                        <span>导出</span>
                    </button>
                    <button id="${EXTENSION_ID}-skill-browser-delete" class="menu_button" type="button">
                        <i class="fa-solid fa-trash"></i>
                        <span>删除</span>
                    </button>
                </div>
                <div id="${EXTENSION_ID}-skill-browser-meta" class="preset-reader-skill-browser-meta"></div>
                <textarea id="${EXTENSION_ID}-skill-browser-content" readonly></textarea>
            </div>
        </div>
    `);
    let activeId = null;

    const getActiveSkill = () => getGeneratedSkills().find(skill => skill.id === activeId) || null;
    const render = () => {
        const skills = getGeneratedSkills();
        const list = root.find(`#${EXTENSION_ID}-skill-browser-list`);
        const nameInput = root.find(`#${EXTENSION_ID}-skill-browser-name`);
        const meta = root.find(`#${EXTENSION_ID}-skill-browser-meta`);
        const content = root.find(`#${EXTENSION_ID}-skill-browser-content`);
        const actionButtons = root.find(`#${EXTENSION_ID}-skill-browser-rename, #${EXTENSION_ID}-skill-browser-export, #${EXTENSION_ID}-skill-browser-delete`);

        list.empty();
        if (!skills.length) {
            activeId = null;
            list.append($('<div class="preset-reader-empty"></div>').text('还没有保存过 Skill'));
            nameInput.val('');
            meta.text('');
            content.val('');
            actionButtons.prop('disabled', true);
            return;
        }

        if (!skills.some(skill => skill.id === activeId)) {
            activeId = skills[0].id;
        }

        skills.forEach(skill => {
            const item = $(`
                <button class="preset-reader-skill-browser-item" type="button">
                    <strong></strong>
                    <small></small>
                </button>
            `);
            item.toggleClass('is-selected', skill.id === activeId);
            item.find('strong').text(skill.name);
            item.find('small').text(`${getSavedSkillSourceText(skill)} / ${formatSavedSkillDate(skill.generatedAt)}`);
            item.on('click', () => {
                activeId = skill.id;
                render();
            });
            list.append(item);
        });

        const activeSkill = getActiveSkill();
        nameInput.val(activeSkill.name);
        meta.text(`${getSavedSkillSourceText(activeSkill)} / ${activeSkill.model || '未记录模型'} / ${formatSavedSkillDate(activeSkill.generatedAt)}`);
        content.val(activeSkill.skill);
        actionButtons.prop('disabled', false);
    };

    root.find(`#${EXTENSION_ID}-skill-browser-rename`).on('click', () => {
        const activeSkill = getActiveSkill();
        if (!activeSkill) {
            return;
        }

        const skills = getGeneratedSkills();
        const name = createUniqueSkillName(root.find(`#${EXTENSION_ID}-skill-browser-name`).val(), skills, activeSkill.id);
        saveGeneratedSkills(skills.map(skill => skill.id === activeSkill.id ? { ...skill, name } : skill));
        toastr.success('Skill 已改名');
        render();
    });

    root.find(`#${EXTENSION_ID}-skill-browser-export`).on('click', () => {
        const activeSkill = getActiveSkill();
        if (!activeSkill) {
            return;
        }

        download(activeSkill.skill, `${sanitizeFileName(activeSkill.name)}.md`, 'text/markdown');
    });

    root.find(`#${EXTENSION_ID}-skill-browser-delete`).on('click', () => {
        const activeSkill = getActiveSkill();
        if (!activeSkill) {
            return;
        }

        if (!confirm(`删除 Skill「${activeSkill.name}」？`)) {
            return;
        }

        const skills = getGeneratedSkills().filter(skill => skill.id !== activeSkill.id);
        saveGeneratedSkills(skills);
        activeId = skills[0]?.id || null;
        toastr.success('Skill 已删除');
        render();
    });

    render();
    callGenericPopup(root, POPUP_TYPE.TEXT, '已保存 Skill', {
        wide: true,
        large: true,
        allowVerticalScrolling: false,
    });
}

function showAgentResult(result) {
    const root = $(`
        <div class="preset-reader-agent-result">
            <div class="preset-reader-agent-result-toolbar">
                <button id="${EXTENSION_ID}-agent-copy-result" class="menu_button">
                    <i class="fa-solid fa-copy"></i>
                    <span>复制 Skill</span>
                </button>
                <button id="${EXTENSION_ID}-agent-download-result" class="menu_button">
                    <i class="fa-solid fa-download"></i>
                    <span>下载 Markdown</span>
                </button>
                <span>${escapeHtml(result.name)} / ${escapeHtml(result.model)} / 已保存</span>
            </div>
            <textarea id="${EXTENSION_ID}-agent-result-text" readonly></textarea>
        </div>
    `);
    root.find(`#${EXTENSION_ID}-agent-result-text`).val(result.skill);
    root.find(`#${EXTENSION_ID}-agent-copy-result`).on('click', async () => {
        try {
            await navigator.clipboard.writeText(result.skill);
            toastr.success('Skill 已复制到剪贴板');
        } catch {
            toastr.error('复制失败');
        }
    });
    root.find(`#${EXTENSION_ID}-agent-download-result`).on('click', () => {
        download(result.skill, `${sanitizeFileName(result.name)}.md`, 'text/markdown');
    });

    callGenericPopup(root, POPUP_TYPE.TEXT, '格式修复 Skill', {
        wide: true,
        large: true,
        allowVerticalScrolling: false,
    });
}

async function generateFormatSkillFromPanel(root) {
    const button = root.find(`#${EXTENSION_ID}-generate-skill`);
    const selectedItems = getPreselectedItems(root);

    if (!selectedItems.length) {
        toastr.warning('请先勾选要交给 Agent 分析的预设');
        return;
    }

    if (selectedItems.length > 1) {
        toastr.warning('一次只能选择一个预设生成 Skill');
        return;
    }

    try {
        button.prop('disabled', true);
        button.find('span').text('生成中...');
        root.find(`#${EXTENSION_ID}-status`).text(`Agent 正在分析「${selectedItems[0].name}」...`);

        const result = await generateFormatSkill(selectedItems);
        if (lastSnapshot) {
            renderStatus(root, lastSnapshot);
        }
        showAgentResult(result);
        toastr.success('格式修复 Skill 已生成并保存');
    } catch (error) {
        if (lastSnapshot) {
            renderStatus(root, lastSnapshot);
        }
        toastr.error(error?.message || String(error));
    } finally {
        button.find('span').text('生成格式 Skill');
        updateSelectedCount(root);
    }
}

async function showPresetReader() {
    const root = makePopupHtml();
    root.find(`#${EXTENSION_ID}-agent-settings`).on('click', () => showAgentSettings());
    root.find(`#${EXTENSION_ID}-saved-skills`).on('click', () => showSavedSkillsBrowser());
    root.find(`#${EXTENSION_ID}-generate-skill`).on('click', () => generateFormatSkillFromPanel(root));
    root.find(`#${EXTENSION_ID}-source, #${EXTENSION_ID}-kind, #${EXTENSION_ID}-search`).on('input change', () => {
        renderList(root, root.data('all-items') || []);
    });

    callGenericPopup(root, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    await loadIntoPanel(root);
}

function addMenuButton() {
    if (menuInitialized || document.getElementById(`${EXTENSION_ID}-button`)) {
        return;
    }

    const button = $(`
        <div id="${EXTENSION_ID}-button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div>
            <span>预设读取器</span>
        </div>
    `);
    button.on('click', () => showPresetReader().catch(error => toastr.error(error?.message || String(error))));

    const container = $('#extensionsMenu');
    if (container.length) {
        container.append(button);
        menuInitialized = true;
    }
}

function registerSlashCommands() {
    if (commandsInitialized) {
        return;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'presetreader',
        aliases: ['preset-reader'],
        callback: async () => {
            await showPresetReader();
            return '';
        },
        helpString: '打开预设读取器面板。',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'presetdump',
        callback: async (args) => {
            const snapshot = await readAll({
                source: args.source || 'all',
                kind: args.kind || 'all',
                name: args.name || '',
            });
            return slashCommandReturnHelper.doReturn(String(args.return || 'popup-html'), snapshot, {
                objectToStringFunc: resultToMarkdown,
                objectToHtmlFunc: resultToMarkdown,
            });
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'source',
                description: '来源过滤',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'all',
                enumList: ['all', 'sillytavern', 'tavern-helper', 'shujuku'],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'kind',
                description: '类型过滤',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'all',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: '名称搜索',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: '返回方式',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'popup-html',
                enumList: slashCommandReturnHelper.enumList({ allowPipe: true, allowObject: true, allowPopup: true, allowTextVersion: true }),
            }),
        ],
        returns: 'preset snapshot',
        helpString: '读取酒馆本体、酒馆助手和 shujuku 预设。示例：/presetdump source=shujuku return=object',
    }));

    commandsInitialized = true;
}

function exposeApi() {
    window[API_NAME] = {
        readAll,
        getLastSnapshot: () => clone(lastSnapshot),
        getLastFormatSkill: () => clone(lastFormatSkill),
        getAgentSettings,
        saveAgentSettings,
        getGeneratedSkills: () => clone(getGeneratedSkills()),
        fetchAvailableModels,
        generateFormatSkill,
        openAgentSettings: showAgentSettings,
        openSavedSkills: showSavedSkillsBrowser,
        open: showPresetReader,
    };
}

export function init() {
    addMenuButton();
    registerSlashCommands();
    exposeApi();
}
