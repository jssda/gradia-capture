import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { OcrError } from './errors.js';

// 扩展侧允许透传的 helper 错误码, 其他未知码统一折叠成 OCR_FAILED.
const HELPER_ERRORS = new Set([
    'IMAGE_NOT_FOUND',
    'OCR_ENV_MISSING',
    'MODEL_LOAD_FAILED',
    'OCR_FAILED',
]);

export function rapidOcrPythonPath(settings) {
    const configured = (settings.get_string('ocr-rapidocr-python') ?? '').trim();
    if (configured)
        return configured;
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'gradia-capture', 'venv', 'bin', 'python']);
}

export function isRapidOcrEnvironmentReady(pythonPath) {
    return !!pythonPath && GLib.file_test(pythonPath, GLib.FileTest.IS_EXECUTABLE);
}

export async function ocrWithRapidOcr(file, { pythonPath, lang = 'ch', timeoutMs = 30000, helperPath } = {}) {
    const imagePath = file?.get_path?.() ?? null;
    if (!imagePath)
        throw new OcrError('OCR_FAILED', 'Screenshot file is not available on disk');
    if (!helperPath || !GLib.file_test(helperPath, GLib.FileTest.EXISTS))
        throw new OcrError('OCR_FAILED', 'ocr_helper.py is missing from the extension');
    if (!isRapidOcrEnvironmentReady(pythonPath)) {
        throw new OcrError('OCR_ENV_MISSING',
            'RapidOCR python environment not found',
            'uv venv --python 3.13 ~/.local/share/gradia-capture/venv && ' +
            'uv pip install --python ~/.local/share/gradia-capture/venv/bin/python ' +
            '-i https://pypi.tuna.tsinghua.edu.cn/simple rapidocr onnxruntime');
    }

    const started = GLib.get_monotonic_time();
    let process;
    try {
        process = Gio.Subprocess.new(
            [pythonPath, helperPath, '--json', '--lang', lang, imagePath],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch (e) {
        throw new OcrError('OCR_ENV_MISSING', 'Cannot start the RapidOCR helper', e.message);
    }

    let timedOut = false;
    let timeoutId = 0;
    timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1000, timeoutMs), () => {
        timedOut = true;
        timeoutId = 0;
        process.force_exit();
        return GLib.SOURCE_REMOVE;
    });

    let stdout = '';
    let stderr = '';
    try {
        const [, out, err] = await new Promise((resolve, reject) => {
            process.communicate_utf8_async(null, null, (source, result) => {
                try {
                    resolve(source.communicate_utf8_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
        });
        stdout = out ?? '';
        stderr = err ?? '';
    } finally {
        if (timeoutId) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }
    }

    const elapsedMs = Math.round((GLib.get_monotonic_time() - started) / 1000);

    if (timedOut)
        throw new OcrError('OCR_TIMEOUT', 'RapidOCR timed out', `${elapsedMs} ms`);

    let payload = null;
    try {
        payload = JSON.parse(stdout.trim());
    } catch (e) {
        payload = null;
    }

    if (!payload) {
        if (!process.get_successful())
            throw new OcrError('OCR_FAILED', 'RapidOCR helper failed', stderr.slice(-500));
        throw new OcrError('OCR_FAILED', 'RapidOCR helper returned invalid JSON', stdout.slice(0, 300));
    }

    if (payload.ok === false) {
        const code = HELPER_ERRORS.has(payload.error) ? payload.error : 'OCR_FAILED';
        throw new OcrError(code, 'RapidOCR helper failed', payload.detail ?? stderr.slice(-500));
    }

    const text = typeof payload.text === 'string' ? payload.text : '';
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    if (!text.trim())
        throw new OcrError('OCR_EMPTY', 'RapidOCR returned no text');

    return { text, lines, ms: typeof payload.ms === 'number' ? payload.ms : elapsedMs };
}
