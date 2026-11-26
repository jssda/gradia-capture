import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { isGradiaFlatpakInstalled, launchGradiaOcrForFile } from '../gradiaIntegration.js';
import { ocrWithLlm } from './llm.js';
import { ocrWithRapidOcr, rapidOcrPythonPath } from './rapidocr.js';
import { destroyOcrBusyToast, showOcrBusyToast, showOcrToast } from './toast.js';
import { OcrError } from './errors.js';
import {_, N_} from '../i18n.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.gradia-companion';

const PROVIDER_GRADIA = 'gradia';
const PROVIDER_RAPIDOCR = 'rapidocr';
const PROVIDER_LLM = 'llm';

const ERROR_TITLES = {
    GRADIA_MISSING: N_('The Gradia app is not installed. Select another OCR engine in Settings → OCR & Translation.'),
    LLM_DISABLED: N_('LLM OCR is disabled. Enable it in Settings → OCR & Translation.'),
    LLM_NOT_CONFIGURED: N_('OCR backend is not configured: fill in the base URL and model in Settings → OCR & Translation.'),
    LLM_KEY_FILE: N_('Cannot read the API key file. Check its path and permissions.'),
    LLM_EXTRA_BODY: N_('The extra body is not valid JSON. Fix it in Settings → OCR & Translation.'),
    LLM_TRUNCATED: N_('The model output was truncated. Disable thinking mode in the extra body ({"thinking": {"type": "disabled"}}) or raise max_tokens.'),
    LLM_EMPTY: N_('The model returned no text. Check that the model supports image input.'),
    LLM_BAD_JSON: N_('The model returned unexpected JSON. The original text is still available.'),
    NET_TIMEOUT: N_('The OCR request timed out. Check the network and proxy settings.'),
    NET_HTTP: N_('The OCR service returned an HTTP error. Check the base URL, model name and API key.'),
    NET_UNREACHABLE: N_('Cannot reach the OCR service. Check the base URL and network connection.'),
    NET_BAD_JSON: N_('The OCR service returned an invalid response.'),
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

function _copyToClipboard(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}

function _notifyError(error) {
    const code = error?.code ?? 'OCR_FAILED';
    const message = code in ERROR_TITLES ? _(ERROR_TITLES[code]) : (error?.message ?? String(error));
    console.error(`[gradia-capture] OCR failed: ${code} | ${error?.message ?? ''} | ${error?.detail ?? ''}`);
    if (!(error instanceof OcrError))
        console.error(error?.stack ?? String(error));
    Main.notify(_('OCR failed'), message);
}

async function _runLlmOcr(file, settings) {
    if (!settings.get_boolean('ocr-llm-enabled'))
        throw new OcrError('LLM_DISABLED', 'LLM OCR is not enabled');

    const cfg = _llmConfig(settings);
    if (!(cfg.baseUrl ?? '').trim() || !(cfg.model ?? '').trim())
        throw new OcrError('LLM_NOT_CONFIGURED', 'LLM OCR is not configured');

    const extraBody = _parseExtraBody(settings.get_string('ocr-llm-extra-body'));
    const bytes = await _readFileBytes(file);
    const started = GLib.get_monotonic_time();
    const result = await ocrWithLlm(bytes, cfg, { extraBody });
    const ocrMs = _elapsedMs(started);

    return {
        engine: PROVIDER_LLM,
        text: result.text,
        translation: result.translation,
        ms: { ocr: ocrMs, translate: 0, total: ocrMs },
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

// OCR 入口: 按 ocr-provider 派发; 所有失败都转成可操作通知, 不向调用方抛异常.
export async function dispatchOcr(file, opts = {}) {
    const settings = _settingsFrom(opts);
    const started = GLib.get_monotonic_time();
    const provider = settings.get_string('ocr-provider');

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

    showOcrBusyToast(provider === PROVIDER_RAPIDOCR ? _('Running local OCR…') : _('Recognizing text…'));

    try {
        let result;
        if (provider === PROVIDER_LLM)
            result = await _runLlmOcr(file, settings);
        else if (provider === PROVIDER_RAPIDOCR)
            result = await _runRapidOcr(file, settings, opts.extensionPath);
        else
            throw new OcrError('PROVIDER_NOT_READY', `Unknown provider: ${provider}`);

        destroyOcrBusyToast();
        _copyToClipboard(result.text);
        showOcrToast({
            text: result.text,
            translation: result.translation,
            chars: settings.get_int('ocr-toast-chars'),
            ms: result.ms.total,
        });

        for (const warning of result.warnings)
            console.warn(`[gradia-capture] OCR warning: ${warning}`);

        return result;
    } catch (error) {
        destroyOcrBusyToast();
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
