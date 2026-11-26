import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {_} from '../i18n.js';

const TOAST_WIDTH = 380;
const TOAST_MARGIN = 18;
const ANIMATION_TIME = 160;
const AUTO_HIDE_TIMEOUT = 12000;
const PADDING = 14;
// 即使 ocr-toast-chars=0 (不截断), 预览也最多展示 2000 字符:
// 否则超长文本会把 toast 撑出屏幕, 关闭按钮点不到. 剪贴板内容始终完整.
const MAX_PREVIEW_CHARS = 2000;

let _activeToast = null;
let _busyToast = null;

function _truncate(text, chars) {
    const limit = chars > 0 ? Math.min(chars, MAX_PREVIEW_CHARS) : MAX_PREVIEW_CHARS;
    const points = Array.from(text);
    if (points.length <= limit)
        return text;
    return `${points.slice(0, limit).join('')}…`;
}

class OcrToast {
    constructor({ text = '', translation = null, chars = 200, ms = 0 }) {
        this._timeoutId = 0;
        this._signalIds = [];

        this._container = new St.BoxLayout({
            vertical: true,
            reactive: true,
            track_hover: true,
            style: `
                spacing: 8px;
                background-color: #222226;
                border: 1px solid #3a3a3d;
                border-radius: 12px;
                padding: ${PADDING}px;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
            `,
        });
        this._container.set_width(TOAST_WIDTH);

        const header = new St.BoxLayout({ vertical: false, style: 'spacing: 8px;' });
        const title = new St.Label({
            text: translation ? _('OCR + Translation') : _('OCR'),
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style: 'font-weight: bold; font-size: 14px;',
        });
        header.add_child(title);

        if (ms > 0) {
            header.add_child(new St.Label({
                text: `${_('Time')}: ${ms} ms`,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 12px; opacity: 0.7;',
            }));
        }

        const closeButton = new St.Button({
            style_class: 'gradia-circle-button gradia-selection-trash',
            child: new St.Icon({ icon_name: 'window-close-symbolic', style: 'icon-size: 14px;' }),
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        closeButton.set_size(28, 28);
        this._signalIds.push([closeButton, closeButton.connect('clicked', () => this.destroy())]);
        header.add_child(closeButton);
        this._container.add_child(header);

        this._container.add_child(this._makeSection(_('Original Text'), _truncate(text, chars)));

        if (translation)
            this._container.add_child(this._makeSection(_('Translation'), _truncate(translation, chars)));

        const buttons = new St.BoxLayout({ vertical: false, style: 'spacing: 8px; margin-top: 2px;' });
        this._addCopyButton(buttons, _('Copy Original'), text);
        if (translation)
            this._addCopyButton(buttons, _('Copy Translation'), translation);

        const hideButton = new St.Button({
            style_class: 'gradia-pill-button gradia-osd-button',
            child: new St.Label({ text: _('Close'), y_align: Clutter.ActorAlign.CENTER }),
            reactive: true,
            x_expand: true,
        });
        this._signalIds.push([hideButton, hideButton.connect('clicked', () => this.destroy())]);
        buttons.add_child(hideButton);
        this._container.add_child(buttons);

        this._signalIds.push([this._container, this._container.connect('notify::hover', () => {
            if (this._container.hover)
                this._clearTimeout();
            else
                this._scheduleHide();
        })]);

        this._addToStage();
        this._scheduleHide();
    }

    _makeSection(title, body) {
        const box = new St.BoxLayout({ vertical: true, style: 'spacing: 2px;' });
        box.add_child(new St.Label({
            text: title,
            style: 'font-size: 11px; font-weight: bold; opacity: 0.6;',
        }));
        const bodyLabel = new St.Label({
            text: body,
            style: 'font-size: 13px;',
            x_expand: true,
        });
        // StLabel 没有 line_wrap 属性, 换行要设在内部的 Clutter.Text 上
        bodyLabel.clutter_text.line_wrap = true;
        bodyLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        box.add_child(bodyLabel);
        return box;
    }

    _addCopyButton(parent, label, value) {
        const button = new St.Button({
            style_class: 'gradia-pill-button gradia-osd-button',
            child: new St.Label({ text: label, y_align: Clutter.ActorAlign.CENTER }),
            reactive: true,
            x_expand: true,
        });
        this._signalIds.push([button, button.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, value);
            const child = button.get_child();
            child.text = _('Copied!');
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                if (button.get_child())
                    child.text = label;
                return GLib.SOURCE_REMOVE;
            });
        })]);
        parent.add_child(button);
    }

    _addToStage() {
        Main.layoutManager.addChrome(this._container);

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const [, naturalHeight] = this._container.get_preferred_height(TOAST_WIDTH);
        const targetX = monitor.x + monitor.width - TOAST_WIDTH - TOAST_MARGIN;
        const targetY = monitor.y + monitor.height - naturalHeight - TOAST_MARGIN;
        const hiddenY = monitor.y + monitor.height + 10;

        this._container.set_position(targetX, hiddenY);
        this._container.opacity = 0;
        this._container.show();

        this._container.ease({
            y: targetY,
            opacity: 255,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _scheduleHide() {
        this._clearTimeout();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AUTO_HIDE_TIMEOUT, () => {
            this._timeoutId = 0;
            this.destroy();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimeout() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    destroy() {
        this._clearTimeout();
        for (const [obj, id] of this._signalIds)
            obj.disconnect(id);
        this._signalIds = [];

        if (_activeToast === this)
            _activeToast = null;

        if (!this._container)
            return;
        const container = this._container;
        this._container = null;
        container.ease({
            y: container.y + 20,
            opacity: 0,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                Main.layoutManager.removeChrome(container);
                container.destroy();
            },
        });
    }
}

export function showOcrToast({ text, translation = null, chars = 200, ms = 0 } = {}) {
    destroyOcrToast();
    _activeToast = new OcrToast({ text, translation, chars, ms });
}

export function destroyOcrToast() {
    _activeToast?.destroy();
    _activeToast = null;
}

// OCR 期间的轻量提示: 截图界面关闭后立即出现, 让用户知道正在识别, 而不是干等.
export function showOcrBusyToast(message = null) {
    destroyOcrBusyToast();

    const container = new St.BoxLayout({
        vertical: false,
        reactive: false,
        style: `
            spacing: 10px;
            padding: 10px 18px;
            border-radius: 9999px;
            background-color: rgba(0, 0, 0, 0.78);
            color: #ffffff;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
        `,
    });

    // St 没有 Spinner 类, 用 shell 自带的 Spinner 组件
    const spinner = new Animation.Spinner(16, { animate: true });
    spinner.play();
    container.add_child(spinner);
    container.add_child(new St.Label({
        text: message ?? _('Recognizing text…'),
        y_align: Clutter.ActorAlign.CENTER,
        style: 'font-size: 13px; font-weight: bold;',
    }));

    Main.layoutManager.addChrome(container);

    const monitor = Main.layoutManager.primaryMonitor;
    if (monitor) {
        const [, width] = container.get_preferred_width(-1);
        const [, height] = container.get_preferred_height(width);
        container.set_position(
            monitor.x + Math.round((monitor.width - width) / 2),
            monitor.y + monitor.height - height - 120);
    }

    container.opacity = 0;
    container.show();
    container.ease({
        opacity: 255,
        duration: 120,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
    });

    _busyToast = container;
}

export function destroyOcrBusyToast() {
    if (!_busyToast)
        return;
    const container = _busyToast;
    _busyToast = null;
    Main.layoutManager.removeChrome(container);
    container.destroy();
}
