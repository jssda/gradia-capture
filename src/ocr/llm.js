import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { sessionFor, requestJson } from '../net.js';
import { OcrError } from './errors.js';
import {_, N_} from '../i18n.js';

const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 60000;

const OCR_PROMPT = N_('只识别图片中的文字，按原始阅读顺序逐行输出，保留换行与标点，不要解释、不要加引号、不要 Markdown 代码块。');
const INLINE_PROMPT = N_('识别图片中的文字，并翻译成 %s。\n只输出一个 JSON 对象，不要代码块、不要额外文字，格式：\n{"text": "原文（保留换行）", "translation": "译文"}');

export function chatEndpoint(baseUrl) {
    const base = (baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base)
        return '';
    if (base.endsWith('/chat/completions'))
        return base;
    return `${base}/chat/completions`;
}

export function readApiKey(cfg) {
    const inline = (cfg.apiKey ?? '').trim();
    if (inline)
        return inline;

    const keyFile = (cfg.apiKeyFile ?? '').trim();
    if (!keyFile)
        return '';

    try {
        const [ok, contents] = Gio.File.new_for_path(keyFile).load_contents(null);
        if (!ok)
            throw new Error('unreadable');
        return new TextDecoder('utf-8').decode(contents).split('\n')[0].trim();
    } catch (e) {
        throw new OcrError('LLM_KEY_FILE', 'Cannot read API key file', keyFile);
    }
}

function _bytesOf(pngBytes) {
    if (pngBytes && typeof pngBytes.get_data === 'function')
        return pngBytes.get_data();
    return pngBytes;
}

export function extractMessageContent(data) {
    const message = data?.choices?.[0]?.message;
    const content = message?.content;
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content))
        return content.map(part => part?.text ?? '').join('');
    return '';
}

function _stripFences(text) {
    return text
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();
}

function _parseJsonObject(text) {
    const candidates = [text];
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start)
        candidates.push(text.slice(start, end + 1));

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object')
                return parsed;
        } catch (e) {
            // 继续尝试下一个候选
        }
    }
    return null;
}

export async function ocrWithLlm(pngBytes, cfg = {}, { translate = false, targetLang = 'zh-CN', extraBody = {} } = {}) {
    const endpoint = chatEndpoint(cfg.baseUrl);
    if (!endpoint)
        throw new OcrError('LLM_NOT_CONFIGURED', 'Missing base URL');
    if (!(cfg.model ?? '').trim())
        throw new OcrError('LLM_NOT_CONFIGURED', 'Missing model');

    const apiKey = readApiKey(cfg);
    const imageData = _bytesOf(pngBytes);
    const base64 = GLib.base64_encode(imageData);

    const systemPrompt = (cfg.prompt ?? '').trim() ||
        (translate ? _(INLINE_PROMPT).replace('%s', targetLang) : _(OCR_PROMPT));

    const userText = translate
        ? _('识别截图中的全部文字并翻译。')
        : _('识别截图中的全部文字。');

    let body = {
        model: cfg.model,
        temperature: 0,
        max_tokens: DEFAULT_MAX_TOKENS,
        messages: [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: [
                    { type: 'text', text: userText },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
                ],
            },
        ],
    };

    if (extraBody && typeof extraBody === 'object')
        body = { ...body, ...extraBody };

    const headers = { Accept: 'application/json' };
    if (apiKey)
        headers.Authorization = `Bearer ${apiKey}`;

    const session = sessionFor({ mode: cfg.proxyMode, url: cfg.proxyUrl });
    const started = GLib.get_monotonic_time();

    const { data } = await requestJson(session, {
        method: 'POST',
        url: endpoint,
        headers,
        json: body,
        timeoutMs: cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
    });

    const ms = Math.round((GLib.get_monotonic_time() - started) / 1000);
    const content = extractMessageContent(data).trim();
    const finishReason = data?.choices?.[0]?.finish_reason ?? null;

    if (finishReason === 'length')
        throw new OcrError('LLM_TRUNCATED', 'LLM output was truncated by max_tokens', finishReason);
    if (!content)
        throw new OcrError('LLM_EMPTY', 'LLM returned empty content', finishReason ?? '');

    const warnings = [];
    let text = content;
    let translation = null;

    if (translate) {
        const parsed = _parseJsonObject(_stripFences(content));
        if (parsed && typeof parsed.text === 'string' && parsed.text.trim()) {
            text = parsed.text.trim();
            translation = typeof parsed.translation === 'string' && parsed.translation.trim()
                ? parsed.translation.trim()
                : null;
            if (!translation)
                warnings.push('LLM_NO_TRANSLATION');
        } else {
            warnings.push('LLM_BAD_JSON');
        }
    }

    return {
        text,
        translation,
        ms,
        requestId: data?.id ?? null,
        warnings,
    };
}
