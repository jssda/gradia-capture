import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';

import {_, N_} from '../i18n.js';

const PROVIDERS = [
    { id: 'gradia', label: N_('Gradia app (hand the screenshot over)') },
    { id: 'rapidocr', label: N_('RapidOCR (local, works offline)') },
    { id: 'llm', label: N_('LLM vision model (OpenAI compatible)') },
];

const TRANSLATE_PROVIDERS = [
    { id: 'none', label: N_('No translation') },
    { id: 'google', label: N_('Google Translate (free)') },
    { id: 'llm', label: N_('LLM') },
];

const COPY_MODES = [
    { id: 'text', label: N_('Original text only') },
    { id: 'translation', label: N_('Translation only') },
    { id: 'both', label: N_('Original and translation') },
];

const PROXY_MODES = [
    { id: 'system', label: N_('Use system proxy') },
    { id: 'direct', label: N_('Connect directly') },
    { id: 'custom', label: N_('Use custom proxy') },
];

export const OcrPage = GObject.registerClass(
    class OcrPage extends Adw.PreferencesPage {
        constructor(settings) {
            super({
                title: _('OCR & Translation'),
                icon_name: 'scanner-symbolic',
            });

            this._settings = settings;
            this._settingsSignals = [];
            this._buildOcrGroup();
            this._buildRapidOcrGroup();
            this._buildLlmGroup();
            this._buildTranslationGroup();
            this._buildResultGroup();

            this.connect('destroy', () => {
                for (const id of this._settingsSignals)
                    this._settings.disconnect(id);
                this._settingsSignals = [];
            });
        }

        _bind(key, row, property) {
            this._settings.bind(key, row, property, Gio.SettingsBindFlags.DEFAULT);
        }

        _comboRow(group, key, title, subtitle, items, onChange = null) {
            const row = new Adw.ComboRow({ title, subtitle });

            const model = new Gtk.StringList();
            for (const item of items)
                model.append(_(item.label));
            row.set_model(model);

            const sync = () => {
                const current = this._settings.get_string(key);
                const index = items.findIndex(item => item.id === current);
                row.set_selected(index >= 0 ? index : 0);
            };

            sync();
            this._settingsSignals.push(this._settings.connect(`changed::${key}`, sync));

            row.connect('notify::selected', () => {
                const item = items[row.get_selected()];
                if (!item)
                    return;
                this._settings.set_string(key, item.id);
                onChange?.(item.id);
            });

            group.add(row);
            return row;
        }

        // GSettings 的 i 类型不能直接 bind 到 SpinRow 的 double 型 value, 手动同步
        _spinRow(group, key, title, subtitle, { lower, upper, step }) {
            const row = new Adw.SpinRow({
                title,
                subtitle,
                adjustment: new Gtk.Adjustment({ lower, upper, step_increment: step }),
            });

            const sync = () => {
                const value = this._settings.get_int(key);
                if (Math.round(row.value) !== value)
                    row.value = value;
            };
            sync();
            this._settingsSignals.push(this._settings.connect(`changed::${key}`, sync));
            row.connect('notify::value', () => {
                this._settings.set_int(key, Math.round(row.value));
            });

            group.add(row);
            return row;
        }

        // libadwaita 1.7 (GNOME 48) 的 Adw.EntryRow 没有 subtitle, 用 ActionRow + 输入框代替
        _entryRow(group, key, title, subtitle = null, { password = false } = {}) {
            const row = new Adw.ActionRow({ title, subtitle });
            const entry = password
                ? new Gtk.PasswordEntry({ hexpand: true, valign: Gtk.Align.CENTER, show_peek_icon: false })
                : new Gtk.Entry({ hexpand: true, valign: Gtk.Align.CENTER });
            entry.width_chars = 24;
            this._bind(key, entry, 'text');
            row.add_suffix(entry);
            row.set_activatable_widget(entry);
            group.add(row);
            return row;
        }

        _buildOcrGroup() {
            const group = new Adw.PreferencesGroup({ title: _('OCR') });
            group.set_description(_('Ctrl+E or the scanner button in the screenshot UI extracts the text of the selection.'));

            const enableRow = new Adw.SwitchRow({
                title: _('Enable OCR'),
                subtitle: _('Show the OCR button in the screenshot UI'),
            });
            this._bind('ocr-enabled', enableRow, 'active');
            group.add(enableRow);

            this._comboRow(group, 'ocr-provider', _('OCR engine'),
                _('Choose how the screenshot is turned into text'), PROVIDERS);

            this.add(group);
        }

        _buildRapidOcrGroup() {
            const group = new Adw.PreferencesGroup({ title: _('RapidOCR (local engine)') });
            group.set_description(_('Works offline after a one time setup. Create the environment once with:\nuv venv --python 3.13 ~/.local/share/gradia-capture/venv\nuv pip install --python ~/.local/share/gradia-capture/venv/bin/python -i https://pypi.tuna.tsinghua.edu.cn/simple rapidocr onnxruntime'));

            this._entryRow(group, 'ocr-rapidocr-python', _('Python interpreter'),
                _('Leave empty to use the venv in the extension data directory'));
            this._entryRow(group, 'ocr-rapidocr-lang', _('Language'),
                _('RapidOCR language type, for example ch or en'));
            this._spinRow(group, 'ocr-rapidocr-timeout-ms', _('Timeout'),
                _('Helper process timeout in milliseconds'), { lower: 1000, upper: 300000, step: 1000 });

            this.add(group);
        }

        _buildLlmGroup() {
            const group = new Adw.PreferencesGroup({ title: _('LLM OCR') });
            group.set_description(_('Only the OpenAI compatible /chat/completions protocol is supported. The model must accept image input. Nothing is prefilled. Example: base URL https://api.deepseek.com, model deepseek-flash. Thinking modes add latency: pass {"thinking": {"type": "disabled"}} in the extra body to disable it when the vendor supports it.'));

            const enableRow = new Adw.SwitchRow({
                title: _('Enable LLM OCR'),
                subtitle: _('Required when the OCR engine is set to LLM'),
            });
            this._bind('ocr-llm-enabled', enableRow, 'active');
            group.add(enableRow);

            this._entryRow(group, 'ocr-llm-base-url', _('Base URL'),
                _('Example: https://api.deepseek.com (leave empty until you configure it)'));
            this._entryRow(group, 'ocr-llm-model', _('Model'), _('Example: deepseek-flash'));
            this._entryRow(group, 'ocr-llm-api-key', _('API key'),
                _('Stored in plain text in dconf; prefer the key file below when possible'),
                { password: true });
            this._entryRow(group, 'ocr-llm-api-key-file', _('API key file'),
                _('When set, the first line of this file is used instead of the API key'));

            this._comboRow(group, 'ocr-llm-proxy-mode', _('Proxy'),
                _('Use the system proxy, connect directly, or use a custom proxy'), PROXY_MODES);
            const proxyUrlRow = this._entryRow(group, 'ocr-llm-proxy-url', _('Proxy URL'),
                _('Only used when the proxy mode is set to custom'));
            const updateProxySensitivity = () => {
                proxyUrlRow.set_sensitive(this._settings.get_string('ocr-llm-proxy-mode') === 'custom');
            };
            updateProxySensitivity();
            this._settingsSignals.push(this._settings.connect('changed::ocr-llm-proxy-mode', updateProxySensitivity));

            this._spinRow(group, 'ocr-llm-timeout-ms', _('Timeout'),
                _('Network timeout in milliseconds'), { lower: 1000, upper: 300000, step: 1000 });
            this._entryRow(group, 'ocr-llm-prompt', _('Custom prompt'),
                _('Leave empty to use the built-in prompt'));
            this._entryRow(group, 'ocr-llm-extra-body', _('Extra request body'),
                _('JSON object merged into the request body, e.g. vendor specific parameters'));

            this.add(group);
        }

        _buildTranslationGroup() {
            const group = new Adw.PreferencesGroup({ title: _('Translation') });
            group.set_description(_('When a translation provider is set, the recognized text is translated before it is shown and copied.'));

            const enableRow = new Adw.SwitchRow({
                title: _('Enable translation'),
                subtitle: _('Translate recognized text when a provider is selected'),
            });
            this._bind('translate-enabled', enableRow, 'active');
            group.add(enableRow);

            this._comboRow(group, 'translate-provider', _('Translation provider'),
                _('Choose how the text is translated'), TRANSLATE_PROVIDERS);
            this._entryRow(group, 'translate-target-lang', _('Target language'),
                _('Example: zh-CN, en, ja'));

            const inheritRow = new Adw.SwitchRow({
                title: _('Reuse the LLM OCR connection'),
                subtitle: _('Use the LLM OCR base URL, model, key and proxy for translation; with the LLM OCR engine this sends a single combined request'),
            });
            this._bind('translate-llm-inherit', inheritRow, 'active');
            group.add(inheritRow);

            this._entryRow(group, 'translate-llm-base-url', _('Translation base URL'),
                _('Only used when the configuration is not inherited'));
            this._entryRow(group, 'translate-llm-model', _('Translation model'),
                _('Example: deepseek-flash'));
            this._entryRow(group, 'translate-llm-api-key', _('Translation API key'),
                _('Stored in plain text in dconf'), { password: true });
            this._entryRow(group, 'translate-llm-api-key-file', _('Translation API key file'),
                _('When set, the first line of this file is used instead'));
            this._comboRow(group, 'translate-llm-proxy-mode', _('Translation proxy'),
                _('Proxy mode for the translation LLM'), PROXY_MODES);
            this._entryRow(group, 'translate-llm-proxy-url', _('Translation proxy URL'),
                _('Only used when the proxy mode is set to custom'));
            this._spinRow(group, 'translate-llm-timeout-ms', _('Translation timeout'),
                _('Network timeout in milliseconds'), { lower: 1000, upper: 300000, step: 1000 });
            this._entryRow(group, 'translate-llm-extra-body', _('Translation extra body'),
                _('JSON object merged into translation requests'));

            this._comboRow(group, 'google-proxy-mode', _('Google Translate proxy'),
                _('Google Translate usually needs a proxy'), PROXY_MODES);
            this._entryRow(group, 'google-proxy-url', _('Google Translate proxy URL'),
                _('Only used when the custom proxy mode is set'));

            this.add(group);
        }

        _buildResultGroup() {
            const group = new Adw.PreferencesGroup({ title: _('Result') });

            this._comboRow(group, 'ocr-copy-mode', _('Copy to clipboard'),
                _('What is written to the clipboard after recognition'), COPY_MODES);

            this._spinRow(group, 'ocr-toast-chars', _('Preview characters'),
                _('Characters shown in the result toast, 0 means no truncation'), { lower: 0, upper: 5000, step: 50 });

            this.add(group);
        }
    });
