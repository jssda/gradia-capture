import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { isGradiaFlatpakInstalled, launchGradiaOcrForFile } from '../gradiaIntegration.js';
import { ocrWithLlm } from './llm.js';
import { ocrWithRapidOcr, rapidOcrPythonPath } from './rapidocr.js';
import { destroyOcrBusyToast, showOcrBusyToast, showOcrToast } from './toast.js';
import { translateText } from '../translate.js';
import { OcrError } from './errors.js';
import {_, N_} from '../i18n.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.gradia-companion';

const PROVIDER_GRADIA = 'gradia';
const PROVIDER_RAPIDOCR = 'rapidocr';
const PROVIDER_LLM = 'llm';

const TRANSLATE_GOOGLE = 'google';
const TRANSLATE_LLM = 'llm';
const TRANSLATE_NONE = 'none';

// OCR 临时截图用完即删; 删除是异步的, 失败(已删除/路径不存在)直接忽略 (issue #1 P1-1)
function _deleteTempFile(file) {
    if (!file)
        return;
    file.delete_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
        try {
            source.delete_finish(result);
        } catch (e) {
            // 忽略: 临时文件可能已被清理
        }
    });
}

const ERROR_TITLES = {
    GRADIA_MISSING: N_('The Gradia app is not installed. Select another OCR engine in Settings → OCR & Translation.'),
    LLM_DISABLED: N_('LLM OCR is disabled. Enable it in Settings → OCR & Translation.'),
    LLM_NOT_CONFIGURED: N_('OCR backend is not configured: fill in the base URL and model in Settings → OCR & Translation.'),
    LLM_KEY_FILE: N_('Cannot read the API key file. Check its path and permissions.'),
    LLM_EXTRA_BODY: N_('The extra body is not valid JSON. Fix it in Settings → OCR & Translation.'),
    LLM_TRUNCATED: N_('The model output was truncated. Disable thinking mode in the extra body ({"thinking": {"type": "disabled"}}) or raise max_tokens.'),
    LLM_EMPTY: N_('The model returned no text. Check that the model supports image input.'),
    LLM_BAD_JSON: N_('The model returned unexpected JSON. The original text is still available.'),
    NET_TIMEOUT: N_('The request timed out.'),
    NET_HTTP: N_('The service returned an HTTP error.'),
    NET_UNREACHABLE: N_('Cannot reach the service. Check the base URL, network and proxy settings.'),
    NET_BAD_JSON: N_('The service returned an invalid response.'),
    TRANSLATE_NOT_CONFIGURED: N_('The translation backend is not configured.'),
    TRANSLATE_BAD_RESPONSE: N_('The translation service returned an unexpected response.'),
    TRANSLATE_EMPTY: N_('The translation is empty.'),
    TRANSLATE_PROVIDER: N_('Unknown translation provider.'),
    OCR_ENV_MISSING: N_('RapidOCR is not installed. Create the Python virtual environment as described in the documentation.'),
    OCR_TIMEOUT: N_('RapidOCR timed out. Select a smaller area or increase the timeout in Settings.'),
    OCR_EMPTY: N_('No text was recognized in the selection.'),
    IMAGE_NOT_FOUND: N_('The screenshot file could not be read.'),
    MODEL_LOAD_FAILED: N_('RapidOCR could not load its models. Recreate the Python environment as described in the documentation.'),
    OCR_FAILED: N_('OCR failed.'),
    PROVIDER_NOT_READY: N_('The selected OCR engine is not available yet.'),
};

function _settingsFrom(opts) {
    if (opts.settings)
        return opts.settings;
    return new Gio.Settings({ schema_id: SCHEMA_ID });
}

function _elapsedMs(startedUs) {
    return Math.round((GLib.get_monotonic_time() - startedUs) / 1000);
}

function _readFileBytes(file) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (source, result) => {
            try {
                const [, contents] = source.load_contents_finish(result);
                resolve(contents);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function _llmConfig(settings) {
    return {
        baseUrl: settings.get_string('ocr-llm-base-url'),
        model: settings.get_string('ocr-llm-model'),
        apiKey: settings.get_string('ocr-llm-api-key'),
        apiKeyFile: settings.get_string('ocr-llm-api-key-file'),
        proxyMode: settings.get_string('ocr-llm-proxy-mode'),
        proxyUrl: settings.get_string('ocr-llm-proxy-url'),
        timeoutMs: settings.get_int('ocr-llm-timeout-ms'),
        prompt: settings.get_string('ocr-llm-prompt'),
    };
}

function _translateLlmConfig(settings) {
    return {
        baseUrl: settings.get_string('translate-llm-base-url'),
        model: settings.get_string('translate-llm-model'),
        apiKey: settings.get_string('translate-llm-api-key'),
        apiKeyFile: settings.get_string('translate-llm-api-key-file'),
        proxyMode: settings.get_string('translate-llm-proxy-mode'),
        proxyUrl: settings.get_string('translate-llm-proxy-url'),
        timeoutMs: settings.get_int('translate-llm-timeout-ms'),
    };
}

function _parseExtraBody(raw) {
    const text = (raw ?? '').trim();
    if (!text)
        return {};
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
        throw new OcrError('LLM_EXTRA_BODY', 'extra body is not valid JSON');
    }
}

function _translationProvider(settings) {
    if (!settings.get_boolean('translate-enabled'))
        return TRANSLATE_NONE;
    const provider = settings.get_string('translate-provider');
    return provider === TRANSLATE_GOOGLE || provider === TRANSLATE_LLM ? provider : TRANSLATE_NONE;
}

// Google 用 google-proxy-*, LLM 用 translate-llm-*; inherit=true 时复用 OCR 的 LLM 配置 (D6).
function _translationProfile(settings, provider) {
    if (provider === TRANSLATE_GOOGLE) {
        return {
            proxyMode: settings.get_string('google-proxy-mode'),
            proxyUrl: settings.get_string('google-proxy-url'),
        };
    }

    if (settings.get_boolean('translate-llm-inherit')) {
        const inherited = _llmConfig(settings);
        return {
            baseUrl: inherited.baseUrl,
            model: inherited.model,
            apiKey: inherited.apiKey,
            apiKeyFile: inherited.apiKeyFile,
            proxyMode: inherited.proxyMode,
            proxyUrl: inherited.proxyUrl,
            timeoutMs: inherited.timeoutMs,
            extraBody: _parseExtraBody(settings.get_string('ocr-llm-extra-body')),
        };
    }

    return {
        ..._translateLlmConfig(settings),
        extraBody: _parseExtraBody(settings.get_string('translate-llm-extra-body')),
    };
}

function _clipboardText(settings, result) {
    if (!result.translation)
        return result.text;
    const mode = settings.get_string('ocr-copy-mode');
    if (mode === 'translation')
        return result.translation;
    if (mode === 'both')
        return `${result.text}\n\n${result.translation}`;
    return result.text;
}

function _copyToClipboard(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}

function errorText(code) {
    if (code in ERROR_TITLES)
        return _(ERROR_TITLES[code]);
    return _('OCR failed.');
}

function _translationNotice(result) {
    if (result.translationError) {
        const reason = errorText(result.translationError);
        return _('Translation failed (%s). The original text is still available.').replace('%s', reason);
    }
    if (result.warnings.includes('TRANSLATE_TRUNCATED'))
        return _('The text was too long; only the first part was translated.');
    return null;
}

function _notifyError(error) {
    const code = error?.code ?? 'OCR_FAILED';
    console.error(`[gradia-capture] OCR failed: ${code} | ${error?.message ?? ''} | ${error?.detail ?? ''}`);
    if (!(error instanceof OcrError))
        console.error(error?.stack ?? String(error));
    Main.notify(_('OCR failed'), errorText(code));
}

async function _runLlmOcr(file, settings, { integrated = false, targetLang = 'zh-CN' } = {}) {
    if (!settings.get_boolean('ocr-llm-enabled'))
        throw new OcrError('LLM_DISABLED', 'LLM OCR is not enabled');

    const cfg = _llmConfig(settings);
    if (!(cfg.baseUrl ?? '').trim() || !(cfg.model ?? '').trim())
        throw new OcrError('LLM_NOT_CONFIGURED', 'LLM OCR is not configured');

    const extraBody = _parseExtraBody(settings.get_string('ocr-llm-extra-body'));
    const bytes = await _readFileBytes(file);
    const started = GLib.get_monotonic_time();
    const result = await ocrWithLlm(bytes, cfg, { translate: integrated, targetLang, extraBody });
    const totalMs = _elapsedMs(started);

    return {
        engine: PROVIDER_LLM,
        text: result.text,
        translation: result.translation,
        // 一体化模式只发一次请求, OCR 与翻译的耗时无法拆分, 统一记在 ocr 上
        ms: { ocr: totalMs, translate: 0, total: totalMs },
        warnings: result.warnings,
        requestId: result.requestId,
    };
}

async function _runRapidOcr(file, settings, extensionPath) {
    const started = GLib.get_monotonic_time();
    const result = await ocrWithRapidOcr(file, {
        pythonPath: rapidOcrPythonPath(settings),
        lang: settings.get_string('ocr-rapidocr-lang'),
        timeoutMs: settings.get_int('ocr-rapidocr-timeout-ms'),
        helperPath: extensionPath ? `${extensionPath}/ocr_helper.py` : null,
    });
    const ocrMs = _elapsedMs(started);

    return {
        engine: PROVIDER_RAPIDOCR,
        text: result.text,
        translation: null,
        ms: { ocr: ocrMs, translate: 0, total: ocrMs },
        warnings: [],
    };
}

async function _translateResult(settings, result, provider, targetLang) {
    const started = GLib.get_monotonic_time();
    try {
        const profile = _translationProfile(settings, provider);
        result.translation = await translateText(result.text, {
            provider,
            targetLang,
            profile,
            warnings: result.warnings,
        });
    } catch (error) {
        result.translationError = error?.code ?? 'TRANSLATE_FAILED';
        result.warnings.push('TRANSLATE_FAILED');
        console.warn(`[gradia-capture] translate failed: ${result.translationError} | ${error?.message ?? ''}`);
    } finally {
        result.ms.translate = _elapsedMs(started);
        result.ms.total += result.ms.translate;
    }
}

// 执行一次 OCR + 可选翻译, 不写剪贴板、不弹面板; 失败抛 OcrError.
// overrides 用于结果面板里的引擎/语言切换.
export async function runOcr(file, {
    settings,
    extensionPath = null,
    ocrProvider = null,
    translateProvider = null,
    targetLang = null,
} = {}) {
    const provider = ocrProvider ?? settings.get_string('ocr-provider');
    const tProvider = translateProvider ?? _translationProvider(settings);
    const lang = targetLang ?? settings.get_string('translate-target-lang');

    if (provider === PROVIDER_GRADIA) {
        if (!isGradiaFlatpakInstalled())
            throw new OcrError('GRADIA_MISSING', 'Gradia app is not installed');
        launchGradiaOcrForFile(file);
        return {
            engine: PROVIDER_GRADIA,
            text: '',
            translation: null,
            ms: { ocr: 0, translate: 0, total: 0 },
            warnings: [],
        };
    }

    if (!file)
        throw new OcrError('OCR_FAILED', 'No screenshot file');

    // 一体化 (D7): OCR 与翻译都用 LLM 且继承配置时, 只发一次请求
    const integrated = provider === PROVIDER_LLM &&
        tProvider === TRANSLATE_LLM &&
        settings.get_boolean('translate-llm-inherit');

    let result;
    if (provider === PROVIDER_LLM)
        result = await _runLlmOcr(file, settings, { integrated, targetLang: lang });
    else if (provider === PROVIDER_RAPIDOCR)
        result = await _runRapidOcr(file, settings, extensionPath);
    else
        throw new OcrError('PROVIDER_NOT_READY', `Unknown provider: ${provider}`);

    if (!integrated && tProvider !== TRANSLATE_NONE)
        await _translateResult(settings, result, tProvider, lang);

    return result;
}

function _busyMessage(provider, translateProvider) {
    if (translateProvider !== TRANSLATE_NONE)
        return _('Recognizing text and translating…');
    return provider === PROVIDER_RAPIDOCR ? _('Running local OCR…') : _('Recognizing text…');
}

// OCR 入口: 按 ocr-provider 派发; 所有失败都转成可操作通知, 不向调用方抛异常.
export async function dispatchOcr(file, opts = {}) {
    const settings = _settingsFrom(opts);
    const started = GLib.get_monotonic_time();
    const provider = settings.get_string('ocr-provider');
    const translateProvider = _translationProvider(settings);

    if (provider === PROVIDER_GRADIA) {
        if (!isGradiaFlatpakInstalled()) {
            _notifyError(new OcrError('GRADIA_MISSING', 'Gradia app is not installed'));
            return {
                engine: PROVIDER_GRADIA,
                text: '',
                translation: null,
                ms: { ocr: 0, translate: 0, total: _elapsedMs(started) },
                warnings: [],
                error: 'GRADIA_MISSING',
            };
        }
        launchGradiaOcrForFile(file);
        return {
            engine: PROVIDER_GRADIA,
            text: '',
            translation: null,
            ms: { ocr: 0, translate: 0, total: _elapsedMs(started) },
            warnings: [],
        };
    }

    if (!file) {
        Main.notify(_('OCR failed'), _('No screenshot was captured.'));
        return null;
    }

    const extensionPath = opts.extensionPath ?? null;
    const tempFile = !!opts.tempFile;
    showOcrBusyToast(_busyMessage(provider, translateProvider));

    try {
        const result = await runOcr(file, {settings, extensionPath});
        destroyOcrBusyToast();
        _copyToClipboard(_clipboardText(settings, result));

        const panelResult = {...result, notice: _translationNotice(result)};
        showOcrToast({
            ...panelResult,
            translateProvider,
            targetLang: settings.get_string('translate-target-lang'),
            settings,
            // 面板关闭(复制/关闭/Esc/被新面板替换)时才删临时文件, 重新识别还要用同一张图
            onClose: tempFile ? () => _deleteTempFile(file) : null,
            onRerun: async selection => {
                showOcrBusyToast(_busyMessage(selection.ocrProvider, selection.translateProvider));
                try {
                    const rerun = await runOcr(file, {
                        settings,
                        extensionPath,
                        ocrProvider: selection.ocrProvider,
                        translateProvider: selection.translateProvider,
                        targetLang: selection.targetLang,
                    });
                    _copyToClipboard(_clipboardText(settings, rerun));
                    return {...rerun, notice: _translationNotice(rerun)};
                } finally {
                    destroyOcrBusyToast();
                }
            },
        });

        for (const warning of result.warnings)
            console.warn(`[gradia-capture] OCR warning: ${warning}`);

        return result;
    } catch (error) {
        destroyOcrBusyToast();
        if (tempFile)
            _deleteTempFile(file);
        _notifyError(error);
        return {
            engine: provider,
            text: '',
            translation: null,
            ms: { ocr: 0, translate: 0, total: _elapsedMs(started) },
            warnings: [],
            error: error?.code ?? 'OCR_FAILED',
        };
    }
}
