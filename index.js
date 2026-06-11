import { getRequestHeaders } from '../../../../script.js';
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

let lastSnapshot = null;
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

    return items;
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

function makePopupHtml() {
    return $(`
        <div id="${EXTENSION_ID}-panel" class="preset-reader-panel">
            <div class="preset-reader-toolbar">
                <button id="${EXTENSION_ID}-refresh" class="menu_button">
                    <i class="fa-solid fa-rotate-right"></i>
                    <span>刷新</span>
                </button>
                <button id="${EXTENSION_ID}-copy" class="menu_button">
                    <i class="fa-solid fa-copy"></i>
                    <span>复制当前</span>
                </button>
                <button id="${EXTENSION_ID}-export" class="menu_button">
                    <i class="fa-solid fa-download"></i>
                    <span>导出 JSON</span>
                </button>
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

function renderList(root, allItems) {
    const list = root.find(`#${EXTENSION_ID}-list`);
    const filtered = filterItems(allItems, getUiFilters(root));
    list.empty();

    if (!filtered.length) {
        list.append($('<div class="preset-reader-empty"></div>').text('没有匹配的预设'));
        renderPreview(root, null);
        return;
    }

    for (const [group, items] of groupItems(filtered)) {
        list.append($('<div class="preset-reader-group"></div>').text(group));
        items.forEach(item => {
            const row = $(`
                <button class="preset-reader-item" type="button">
                    <span class="preset-reader-item-name"></span>
                    <small></small>
                </button>
            `);
            row.attr('data-id', item.id);
            row.toggleClass('is-warning', item.status === 'warning');
            row.find('.preset-reader-item-name').text(item.name);
            row.find('small').text(`${getContentMetric(item.content)}${item.warning ? ' / 有提示' : ''}`);
            row.on('click', () => {
                list.find('.preset-reader-item').removeClass('is-selected');
                row.addClass('is-selected');
                renderPreview(root, item);
            });
            list.append(row);
        });
    }

    const first = filtered[0];
    list.find(`[data-id="${CSS.escape(first.id)}"]`).addClass('is-selected');
    renderPreview(root, first);
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
        ...item,
    }));

    root.data('all-items', allItems);
    refreshFilterOptions(root, allItems);
    renderStatus(root, snapshot);
    renderList(root, allItems);
}

async function copySelected(root) {
    const item = root.data('selected-item');
    const value = item ? safeStringify(item.content) : safeStringify(lastSnapshot);

    try {
        await navigator.clipboard.writeText(value);
        toastr.success('已复制到剪贴板');
    } catch {
        toastr.error('复制失败');
    }
}

function exportCurrent(root) {
    const filters = getUiFilters(root);
    const allItems = root.data('all-items') || [];
    const filteredItems = filterItems(allItems, filters).map(item => ({
        source: item.source,
        sourceLabel: item.sourceLabel,
        kind: item.kind,
        kindLabel: item.kindLabel,
        name: item.name,
        status: item.status,
        warning: item.warning,
        meta: item.meta,
        content: item.content,
    }));
    const payload = {
        generatedAt: new Date().toISOString(),
        filters,
        counts: summarizeCounts(filteredItems),
        items: filteredItems,
    };
    download(safeStringify(payload), `${sanitizeFileName('preset-reader-export')}.json`, 'application/json');
}

async function showPresetReader() {
    const root = makePopupHtml();
    root.find(`#${EXTENSION_ID}-refresh`).on('click', () => loadIntoPanel(root).catch(error => toastr.error(error?.message || String(error))));
    root.find(`#${EXTENSION_ID}-copy`).on('click', () => copySelected(root));
    root.find(`#${EXTENSION_ID}-export`).on('click', () => exportCurrent(root));
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
        open: showPresetReader,
    };
}

export function init() {
    addMenuButton();
    registerSlashCommands();
    exposeApi();
}
