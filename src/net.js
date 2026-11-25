import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import { OcrError } from './ocr/errors.js';

const REQUEST_TIMEOUT_MS = 30000;

// 按配置给出代理语义 (已在 GNOME 48 / libsoup 3.6 上验证):
// system = 不设 resolver, 走 GLib 系统代理; direct = 直连; custom = 指定代理地址.
export function sessionFor({ mode = 'system', url = '', ignoreHosts = null } = {}) {
    const session = new Soup.Session();

    if (mode === 'direct') {
        session.set_property('proxy-resolver', Gio.SimpleProxyResolver.new('direct://', []));
    } else if (mode === 'custom') {
        const hosts = ignoreHosts ?? ['localhost', '127.0.0.1'];
        session.set_property('proxy-resolver', Gio.SimpleProxyResolver.new(url, hosts));
    }

    return session;
}

function _decode(bytes) {
    return new TextDecoder('utf-8').decode(bytes.get_data());
}

// 统一异步请求: 任何 HTTP 响应都会带上 status 解析; 传输层失败抛 OcrError.
export async function requestJson(session, { method = 'GET', url, headers = {}, json = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    if (!url)
        throw new OcrError('NET_BAD_URL', 'Empty request URL');

    const message = Soup.Message.new(method, url);
    if (!message)
        throw new OcrError('NET_BAD_URL', 'Invalid request URL', url);

    const requestHeaders = message.get_request_headers();
    for (const [name, value] of Object.entries(headers))
        requestHeaders.append(name, value);

    if (json !== null) {
        const payload = new TextEncoder().encode(JSON.stringify(json));
        message.set_request_body_from_bytes('application/json', new GLib.Bytes(payload));
    }

    session.set_property('timeout', Math.max(1, Math.ceil(timeoutMs / 1000)));

    const cancellable = new Gio.Cancellable();
    let timedOut = false;
    let timeoutId = 0;
    timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
        timedOut = true;
        timeoutId = 0;
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });

    let bytes;
    try {
        bytes = await new Promise((resolve, reject) => {
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                try {
                    resolve(source.send_and_read_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
        });
    } catch (e) {
        if (timedOut)
            throw new OcrError('NET_TIMEOUT', 'Request timed out', url);
        throw new OcrError('NET_UNREACHABLE', e.message ?? String(e), url);
    } finally {
        if (timeoutId) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }
    }

    const status = message.get_status();
    let data = null;
    if (bytes && bytes.get_size() > 0) {
        try {
            data = JSON.parse(_decode(bytes));
        } catch (e) {
            if (status >= 200 && status < 300)
                throw new OcrError('NET_BAD_JSON', 'Response is not valid JSON', _decode(bytes));
            data = { raw: _decode(bytes).slice(0, 300) };
        }
    }

    if (status < 200 || status >= 300) {
        const snippet = data?.raw ?? data?.error?.message ?? (data ? JSON.stringify(data).slice(0, 300) : '');
        throw new OcrError('NET_HTTP', `HTTP ${status}`, snippet);
    }

    return { status, data };
}
