import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {languageLabel, TARGET_LANGUAGES} from './languages.js';
import {_} from '../i18n.js';

const PANEL_PADDING = 16;
const PANEL_GAP = 16;
const PANEL_WIDTH_MAX = 940;
const PANEL_WIDTH_MIN = 620;
const PANEL_MARGIN = 24;
const PANEL_MARGIN_TOP = 56;
const COLUMN_HEIGHT_MAX = 360;
const ANIMATION_TIME = 160;

const ENGINE_LABELS = {
    gradia: () => _('Gradia app'),
    rapidocr: () => _('RapidOCR (local engine)'),
    llm: () => _('LLM'),
};

const TRANSLATE_LABELS = {
    none: () => _('No translation'),
    google: () => _('Google Translate'),
    llm: () => _('LLM'),
};

let _activePanel = null;
let _busyToast = null;

function _sectionTitle(text) {
    return new St.Label({
        text,
        style: 'font-size: 11px; font-weight: bold; opacity: 0.6;',
    });
}

// 选项按钮 + 下拉菜单 (shell 的 PopupMenu)
class Selector {
    constructor(panel, label, items, onSelect, side = St.Side.BOTTOM) {
        this._panel = panel;
        this._onSelect = onSelect;

        this.button = new St.Button({
            style_class: 'gradia-pill-button gradia-osd-button',
            child: new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}),
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._menu = new PopupMenu.PopupMenu(this.button, 0.0, side);
        this._menu.actor.hide();
        Main.uiGroup.add_child(this._menu.actor);
        this._manager = new PopupMenu.PopupMenuManager(this.button);
        this._manager.addMenu(this._menu);
        panel._addMenu(this._menu);

        for (const item of items)
            this._menu.addAction(item.label, () => this._onSelect(item.id));

        this.button.connect('clicked', () => {
            if (!this._panel._busy)
                this._menu.open(BoxPointer.PopupAnimation.FULL);
        });
    }

    setLabel(text) {
        this.button.get_child().text = text;
    }

    destroy() {
        this._menu.destroy();
    }
}

class OcrResultPanel {
    constructor({text = '', translation = null, ms = 0, notice = null, engine = 'llm',
        translateProvider = 'none', targetLang = 'zh-CN', onRerun = null, settings = null} = {}) {
        this._engine = engine;
        this._translateProvider = translateProvider;
        this._targetLang = targetLang;
        this._onRerun = onRerun;
        this._settings = settings;
        this._text = text;
        this._translation = translation;
        this._ms = ms;
        this._notice = notice;
        this._busy = false;
        this._destroyed = false;
        this._menus = [];
        this._signalIds = [];

        const monitor = Main.layoutManager.primaryMonitor;
        const monitorWidth = monitor?.width ?? 1280;
        const monitorHeight = monitor?.height ?? 800;
        this._width = Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, monitorWidth - PANEL_MARGIN * 2));
        this._columnHeight = Math.min(COLUMN_HEIGHT_MAX, Math.max(160, monitorHeight * 0.40));

        this._container = new St.BoxLayout({
            vertical: true,
            reactive: true,
            style: `
                spacing: 10px;
                padding: ${PANEL_PADDING}px;
                background-color: #222226;
                border: 1px solid #3a3a3d;
                border-radius: 14px;
                box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
            `,
        });
        this._container.set_width(this._width);

        this._buildHeader();
        this._buildSelectors();
        this._contentBox = new St.BoxLayout({vertical: false, style: `spacing: ${PANEL_GAP}px;`});
        this._container.add_child(this._contentBox);
        this._buildNotice();
        this._buildButtons();
        this._render();

        this._addToStage();
    }

    _buildHeader() {
        const header = new St.BoxLayout({vertical: false, style: 'spacing: 10px;'});

        this._titleLabel = new St.Label({
            text: _('OCR'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 15px; font-weight: bold;',
        });
        header.add_child(this._titleLabel);

        this._msLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 12px; opacity: 0.7;',
        });
        header.add_child(this._msLabel);

        const closeButton = new St.Button({
            style_class: 'gradia-circle-button gradia-selection-trash',
            child: new St.Icon({icon_name: 'window-close-symbolic', style: 'icon-size: 14px;'}),
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        closeButton.set_size(28, 28);
        this._signalIds.push([closeButton, closeButton.connect('clicked', () => this.destroy())]);
        header.add_child(closeButton);

        this._container.add_child(header);
    }

    _buildSelectors() {
        const row = new St.BoxLayout({vertical: false, style: 'spacing: 8px;'});

        row.add_child(_sectionTitle(_('OCR engine')));
        this._engineSelector = new Selector(this,
            ENGINE_LABELS[this._engine]?.() ?? this._engine,
            [
                {id: 'rapidocr', label: _('RapidOCR (local engine)')},
                {id: 'llm', label: _('LLM')},
            ],
            id => this._selectEngine(id));
        row.add_child(this._engineSelector.button);

        this._translateTitle = _sectionTitle(_('Translation'));
        row.add_child(this._translateTitle);
        this._translateSelector = new Selector(this,
            TRANSLATE_LABELS[this._translateProvider]?.() ?? this._translateProvider,
            [
                {id: 'none', label: _('No translation')},
                {id: 'google', label: _('Google Translate')},
                {id: 'llm', label: _('LLM')},
            ],
            id => this._selectTranslateProvider(id));
        row.add_child(this._translateSelector.button);

        this._langTitle = _sectionTitle(_('Target language'));
        row.add_child(this._langTitle);
        this._langSelector = new Selector(this,
            languageLabel(this._targetLang),
            TARGET_LANGUAGES.map(lang => ({id: lang.id, label: lang.label})),
            id => this._selectTargetLang(id));
        row.add_child(this._langSelector.button);

        const spacer = new St.Widget({x_expand: true});
        row.add_child(spacer);

        if (this._onRerun) {
            this._rerunButton = new St.Button({
                style_class: 'gradia-pill-button gradia-osd-button',
                child: new St.Label({text: _('Recognize again'), y_align: Clutter.ActorAlign.CENTER}),
                reactive: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._signalIds.push([this._rerunButton, this._rerunButton.connect('clicked', () => {
                if (!this._busy)
                    this._rerun();
            })]);
            row.add_child(this._rerunButton);
        }

        this._container.add_child(row);
    }

    _buildNotice() {
        this._noticeLabel = new St.Label({
            x_expand: true,
            style: 'font-size: 12px; color: #f5a623;',
        });
        this._noticeLabel.clutter_text.line_wrap = true;
        this._noticeLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._container.add_child(this._noticeLabel);
    }

    _buildButtons() {
        this._buttonsBox = new St.BoxLayout({vertical: false, style: 'spacing: 8px;'});

        this._copyTextButton = this._makeButton(_('Copy Original'), () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._text);
            this.destroy();
        });
        this._buttonsBox.add_child(this._copyTextButton);

        this._copyTranslationButton = this._makeButton(_('Copy Translation'), () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._translation ?? '');
            this.destroy();
        });
        this._buttonsBox.add_child(this._copyTranslationButton);

        const closeButton = this._makeButton(_('Close'), () => this.destroy());
        this._buttonsBox.add_child(closeButton);

        this._container.add_child(this._buttonsBox);
    }

    _makeButton(label, onClick) {
        const button = new St.Button({
            style_class: 'gradia-pill-button gradia-osd-button',
            child: new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}),
            reactive: true,
            x_expand: true,
        });
        this._signalIds.push([button, button.connect('clicked', onClick)]);
        return button;
    }

    _render() {
        this._titleLabel.text = this._translation ? _('OCR + Translation') : _('OCR');
        this._msLabel.text = this._ms > 0 ? `${_('Time')}: ${this._ms} ms` : '';

        this._translateTitle.visible = true;
        this._translateSelector.button.visible = true;

        const hasTranslation = !!this._translation;
        this._langTitle.visible = hasTranslation;

        this._contentBox.destroy_all_children();

        const columnWidth = hasTranslation
            ? Math.round((this._width - PANEL_PADDING * 2 - PANEL_GAP) / 2)
            : this._width - PANEL_PADDING * 2;

        this._contentBox.add_child(this._buildColumn(_('Original Text'), this._text, columnWidth));
        if (hasTranslation)
            this._contentBox.add_child(this._buildColumn(_('Translation'), this._translation, columnWidth));

        this._copyTranslationButton.visible = hasTranslation;
        this._noticeLabel.text = this._notice ?? '';
        this._noticeLabel.visible = !!this._notice;
    }

    _buildColumn(title, body, width) {
        const box = new St.BoxLayout({vertical: true, style: 'spacing: 4px;'});
        box.add_child(_sectionTitle(title));

        const label = new St.Label({
            text: body ?? '',
            style: 'font-size: 13px;',
            x_expand: true,
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.set_width(Math.max(120, width - 16));

        // St.ScrollView 的子节点必须实现 St.Scrollable, St.Label 不行, 外面包一层 BoxLayout
        const content = new St.BoxLayout({
            vertical: true,
            style: 'padding: 8px;',
            x_expand: true,
        });
        content.add_child(label);
        content.set_width(width);

        const scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: content,
            style: 'background-color: rgba(255, 255, 255, 0.04); border-radius: 8px;',
        });
        scroll.set_size(width, this._columnHeight);

        box.add_child(scroll);
        return box;
    }

    _selectEngine(id) {
        this._engine = id;
        this._engineSelector.setLabel(ENGINE_LABELS[id]?.() ?? id);
        if (this._settings)
            this._settings.set_string('ocr-provider', id);
    }

    _selectTranslateProvider(id) {
        this._translateProvider = id;
        this._translateSelector.setLabel(TRANSLATE_LABELS[id]?.() ?? id);
        if (this._settings)
            this._settings.set_string('translate-provider', id);
    }

    _selectTargetLang(id) {
        this._targetLang = id;
        this._langSelector.setLabel(languageLabel(id));
        if (this._settings)
            this._settings.set_string('translate-target-lang', id);
    }

    async _rerun() {
        if (!this._onRerun || this._busy || this._destroyed)
            return;

        this._busy = true;
        this._setControlsSensitive(false);
        this._notice = _('Recognizing…');
        this._noticeLabel.text = this._notice;
        this._noticeLabel.visible = true;

        try {
            const result = await this._onRerun({
                ocrProvider: this._engine,
                translateProvider: this._translateProvider,
                targetLang: this._targetLang,
            });
            if (!result || this._destroyed)
                return;
            this._text = result.text ?? '';
            this._translation = result.translation ?? null;
            this._ms = result.ms?.total ?? 0;
            this._engine = result.engine ?? this._engine;
            this._notice = result.notice ?? null;
            this._render();
        } catch (e) {
            if (this._destroyed)
                return;
            this._notice = e.message ?? String(e);
            this._noticeLabel.text = this._notice;
            this._noticeLabel.visible = true;
        } finally {
            this._busy = false;
            if (!this._destroyed)
                this._setControlsSensitive(true);
        }
    }

    _setControlsSensitive(sensitive) {
        this._engineSelector.button.reactive = sensitive;
        this._translateSelector.button.reactive = sensitive;
        this._langSelector.button.reactive = sensitive;
        if (this._rerunButton)
            this._rerunButton.reactive = sensitive;
    }

    _addMenu(menu) {
        this._menus.push(menu);
    }

    _addToStage() {
        Main.layoutManager.addChrome(this._container);

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const [, naturalHeight] = this._container.get_preferred_height(this._width);
        const targetX = monitor.x + Math.round((monitor.width - this._width) / 2);
        const targetY = monitor.y + PANEL_MARGIN_TOP;
        const hiddenY = targetY - naturalHeight - 20;

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

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        if (_activePanel === this)
            _activePanel = null;

        for (const [obj, id] of this._signalIds)
            obj.disconnect(id);
        this._signalIds = [];

        for (const menu of this._menus)
            menu.destroy();
        this._menus = [];

        if (!this._container)
            return;
        const container = this._container;
        this._container = null;

        container.ease({
            y: container.y - 20,
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

export function showOcrToast(options = {}) {
    destroyOcrToast();
    _activePanel = new OcrResultPanel(options);
}

export function destroyOcrToast() {
    _activePanel?.destroy();
    _activePanel = null;
}

// OCR/翻译期间的轻量提示: 截图界面关闭后立即出现, 让用户知道正在识别, 而不是干等.
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

    const spinner = new Animation.Spinner(16, {animate: true});
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
