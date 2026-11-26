import GLib from 'gi://GLib';

import { sessionFor, requestJson } from './net.js';
import { chatEndpoint, extractMessageContent, readApiKey } from './ocr/llm.js';
import { OcrError } from './ocr/errors.js';
import {_, N_} from './i18n.js';

const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const GOOGLE_MAX_CHARS_PER_PIECE = 4000;
const GOOGLE_MAX_PIECES = 3;
const DEFAULT_TIMEOUT_MS = 30000;
const LLM_MAX_TOKENS = 2048;

const LLM_TRANSLATE_PROMPT = N_('把下面的文字翻译成 %s，只输出译文，不要解释、不要加引号、不要 Markdown 代码块。');

// 把文本按段落切成不超过 4000 字符的小块; 原文过长时只翻前 3 块并记 TRUNCATED.
function _splitPieces(text) {
    const paragraphs = text.replace(/\r\n/g, '\n').split(/\n\s*\n/);
    const pieces = [];
    let truncated = false;

    for (const paragraph of paragraphs) {
        if (!paragraph.trim())
            continue;
        let rest = paragraph;
        while (rest.length > 0) {
            const piece = rest.slice(0, GOOGLE_MAX_CHARS_PER_PIECE);
            rest = rest.slice(GOOGLE_MAX_CHARS_PER_PIECE);
            if (pieces.length < GOOGLE_MAX_PIECES)
                pieces.push(piece);
            else
                truncated = true;
        }
    }

    return { pieces, truncated };
}

function _parseGoogleResponse(data) {
    const segments = data?.[0];
    if (!Array.isArray(segments))
        throw new OcrError('TRANSLATE_BAD_RESPONSE', 'Unexpected Google Translate response');
    return segments
        .map(segment => (Array.isArray(segment) ? segment[0] ?? '' : ''))
        .join('');
}

async function _googleTranslate(text, targetLang, profile, warnings) {
    const { pieces, truncated } = _splitPieces(text);
    if (!pieces.length)
        throw new OcrError('TRANSLATE_EMPTY', 'Nothing to translate');

    const session = sessionFor({
        mode: profile?.proxyMode ?? 'system',
        url: profile?.proxyUrl ?? '',
    });
    const timeoutMs = profile?.timeoutMs > 0 ? profile.timeoutMs : DEFAULT_TIMEOUT_MS;
    const translated = [];

    for (const piece of pieces) {
        const url = `${GOOGLE_ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t` +
            `&q=${encodeURIComponent(piece)}`;
        const { data } = await requestJson(session, { method: 'GET', url, timeoutMs });
        translated.push(_parseGoogleResponse(data));
    }

    if (truncated && Array.isArray(warnings))
        warnings.push('TRANSLATE_TRUNCATED');

    return translated.join('\n\n');
}

async function _llmTranslate(text, targetLang, profile) {
    const endpoint = chatEndpoint(profile?.baseUrl);
    if (!endpoint)
        throw new OcrError('TRANSLATE_NOT_CONFIGURED', 'Translation backend is not configured');
    if (!(profile.model ?? '').trim())
        throw new OcrError('TRANSLATE_NOT_CONFIGURED', 'Translation model is missing');

    const apiKey = readApiKey(profile);
    let body = {
        model: profile.model,
        temperature: 0,
        max_tokens: LLM_MAX_TOKENS,
        messages: [
            { role: 'system', content: _(LLM_TRANSLATE_PROMPT).replace('%s', targetLang) },
            { role: 'user', content: text },
        ],
    };
    if (profile.extraBody && typeof profile.extraBody === 'object')
        body = { ...body, ...profile.extraBody };

    const headers = { Accept: 'application/json' };
    if (apiKey)
        headers.Authorization = `Bearer ${apiKey}`;

    const session = sessionFor({ mode: profile.proxyMode, url: profile.proxyUrl });
    const { data } = await requestJson(session, {
        method: 'POST',
        url: endpoint,
        headers,
        json: body,
        timeoutMs: profile.timeoutMs > 0 ? profile.timeoutMs : DEFAULT_TIMEOUT_MS,
    });

    if (data?.choices?.[0]?.finish_reason === 'length')
        throw new OcrError('LLM_TRUNCATED', 'Translation output was truncated by max_tokens');

    const content = extractMessageContent(data).trim();
    if (!content)
        throw new OcrError('TRANSLATE_EMPTY', 'The translation model returned nothing');
    return content;
}

// 翻译入口: 失败抛 OcrError, 由调用方决定降级 (原文必须保留).
export async function translateText(text, { provider = 'none', targetLang = 'zh-CN', profile = null, warnings = null } = {}) {
    const source = (text ?? '').trim();
    if (!source)
        throw new OcrError('TRANSLATE_EMPTY', 'Nothing to translate');

    if (provider === 'google')
        return _googleTranslate(source, targetLang, profile, warnings);
    if (provider === 'llm')
        return _llmTranslate(source, targetLang, profile);

    throw new OcrError('TRANSLATE_PROVIDER', `Unknown translation provider: ${provider}`);
}
