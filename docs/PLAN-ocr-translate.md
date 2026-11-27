# Gradia Capture（本地 fork）— OCR 与翻译功能实施方案

> 交接文档。开发方：dsh（专业代码 agent）。需求方：jssd。
> 目标：在本仓库的 **本地 fork 分支** 上实现「截图 → OCR → 可选翻译 → 剪贴板/浮层」。
> 本文档中的所有约定（默认值、命名、禁止事项）都是需求方已拍板的结论，**不要自行更改**；有疑问先记录，最后统一问。

---

## 1. 背景

### 1.1 项目与仓库关系

- 上游：`https://github.com/AlexanderVanhee/gradia-capture`（GPLv3，个人维护）
- 本仓库：`https://github.com/jssda/gradia-capture`，是本地维护的 fork
- 本地工作副本：`/home/jssd/project/gradia-capture`

分支模型（已建立，勿改）：

```
master                 = 上游镜像，只允许 fast-forward（跟踪 upstream/master）
local                  = master + 本地提交（GNOME 48 支持、gettext+zh_CN、CHANGELOG/许可）
gnome-48-support       = 已提交上游的 PR 分支（PR #43）
i18n-gettext-zh_CN     = 已提交上游的 PR 分支（PR #44）
feature/ocr-translate  = 本次开发的开发分支（从 local 拉出）
```

### 1.2 扩展当前如何做 OCR（关键背景）

`src/extension.js` 第 1264 行附近：

```js
if (isGradiaFlatpakInstalled()) {
    const ui = Main.screenshotUI;
    this._ocrButton = createOcrButton(async () => {
        const file = await this._captureScreenshot({ ocr: true });
        Main.screenshotUI.close();
        launchGradiaOcrForFile(file);      // ← 把 PNG 交给 Gradia flatpak 应用
    });
    ui._showPointerButtonContainer.insert_child_below(this._ocrButton, ui._showPointerButton);
}
```

要点：

1. 扩展**自己不做识别**，只是转发给外部 Gradia 应用；本机**没有安装**该 flatpak，所以现在按钮根本不会创建；
2. 截图链路已经完整：`_captureScreenshot({ocr:true})` 返回一个 `Gio.File`（PNG，已包含标注合成、已按选区裁剪），我们只需接管“拿到文件之后做什么”；
3. 快捷键 `Ctrl+E` 已经绑定到该按钮；`Ctrl+C/S/Z` 也已被占用；
4. 扩展在 Wayland 下的截图来源是 `Shell.Screenshot.composite_to_stream()`，**不需要再做一次系统截图**。

### 1.3 需求方已确认的产品决策

| 编号 | 决策 |
|---|---|
| D1 | **保留 Gradia 转发优先**：装了 Gradia 且未改配置就沿用上游行为（利于后续 rebase，少动上游代码） |
| D2 | OCR 引擎三选一：`gradia`（转发）/ `rapidocr`（本地）/ `llm`（多模态大模型） |
| D3 | RapidOCR 的 Python venv 放在 **扩展数据目录**：`~/.local/share/gradia-capture/venv` |
| D4 | **不预填任何 LLM 配置**（base_url / model / key 全为空）；文档示例使用 DeepSeek |
| D5 | 仅支持 **OpenAI 兼容** 的 `/chat/completions` 协议，不做其他厂商适配 |
| D6 | OCR 用 LLM 与翻译用 LLM **分开配置**；翻译可「继承 OCR 的配置」 |
| D7 | 继承时启用 **一体化**：一次请求同时返回原文与译文（仅当两处都用 LLM 且继承开启） |
| D8 | 目标语言可配置，默认 `zh-CN` |
| D9 | 每个网络后端独立代理设置：`system` / `direct` / `custom`（原因：Google 需走代理，国内大模型需直连） |
| D10 | 全部新增界面文案必须走 gettext，并提供 zh_CN 译文（不留未翻译条目） |
| D11 | 本期结果呈现只用 **MVP**：写入剪贴板 + 顶部 toast；结果面板留到后续 |

---

## 2. 范围

### 2.1 本期要做（In scope）

- 三档 OCR 引擎与派发逻辑
- OpenAI 兼容的 LLM OCR（多模态）与 LLM 翻译
- Google 免 key 翻译
- 翻译继承 / 一体化模式
- 三组代理配置
- 剪贴板输出 + 只读结果面板（原文/译文左右对比、可滚动、面板内切换引擎与目标语言、复制后自动关闭）
- 首选项界面（引擎选择、两套 LLM 配置、代理、目标语言、说明文字）
- i18n 文案（zh_CN 完整）

### 2.2 本期不做（Out of scope）

- 可编辑文本窗（已知在 Shell 内 `St.Entry` 拿不到 fcitx5 候选，见上游 issue #19，故不做编辑；只读结果面板见 D12）
- 识别框可视化、表格结构还原、批量处理、历史记录
- 流式输出、失败重试与队列
- 除 OpenAI 兼容格式外的任何厂商专有协议
- 上游 PR（本功能是 fork 专属，不进上游）

---

## 3. 用户可见行为（验收基准）

1. 按 `Ctrl+E`（或点工具条 OCR 按钮）→ 选区 → 松手；
2. 若 OCR 后端未配置/未装好：toast 明确报错，说明缺少什么、怎么修（含可复制的命令）；
3. OCR 成功：
   - 剪贴板写入识别结果（按 `ocr-copy-mode` 决定写原文、译文或两者）；
   - toast 显示前 `ocr-toast-chars` 个字符，并提供「复制原文」「复制译文」「关闭」；
4. OCR 成功但翻译失败：**原文照常可用**，toast 提示翻译失败原因；
5. 全程桌面不得卡顿（所有阻塞操作异步）；
6. 无网络、无 venv、无 key 的任意组合下，都要有明确且可操作的错误信息。

---

## 4. 架构

### 4.1 新增文件（全部新增，避免与上游冲突）

```
src/net.js                网络层：按代理配置构造 Soup.Session，封装 GET/POST JSON
src/ocr/engine.js         引擎派发与流程编排（OCR → 可选翻译 / 一体化）
src/ocr/rapidocr.js       本地 RapidOCR：惰性探测 python，异步子进程
src/ocr/llm.js            多模态 LLM OCR（OpenAI 兼容）
src/translate.js          翻译：Google 免 key / LLM
src/ocr/toast.js          OCR 结果面板（只读、左右对比、可切换引擎）与识别中提示
src/ocr/languages.js      翻译目标语言列表（面板与首选项共用）
src/ocr/errors.js         统一错误类型 OcrError（带机器可读的 code）
src/prefs/ocrPage.js      首选项中的「OCR 与翻译」页面
python/ocr_helper.py      RapidOCR 命令行助手（打包进扩展）
scripts/ocr-selftest.sh   自测脚本（三种后端对比，输出表格）
docs/PLAN-ocr-translate.md 本文件
```

### 4.2 对既有文件的改动（改动必须最小，便于 rebase）

| 文件 | 改动 |
|---|---|
| `src/extension.js` | ① 按钮创建条件放宽为 `isGradiaFlatpakInstalled() \|\| ocrEnabled`；② 回调里 `launchGradiaOcrForFile(file)` → `dispatchOcr(file)`（import 1 行） |
| `src/prefs.js` | 顶部 import 新增页面；`fillPreferencesWindow()` 里追加一行 `window.add(this._ocrPage);`（或等价） |
| `schemas/org.gnome.shell.extensions.gradia-companion.gschema.xml` | 在既有 `<schema>` 内**追加**新键（不改动已有 5 个键） |
| `build.sh` | `gnome-extensions pack` 增加 `--extra-source="ocr"`、`--extra-source="prefs"`（子目录不会被自动打包）和 `--extra-source="../python/ocr_helper.py"` |
| `po/gradia-capture.pot`、`po/zh_CN.po` | 重新生成/合并，补译新增条目 |
| `CHANGELOG.md` | 增加“fork 专属功能”小节（注明不进上游 PR） |

### 4.3 数据流

```
Ctrl+E / 按钮
   └─ _captureScreenshot({ocr:true}) → Gio.File(PNG)
        └─ dispatchOcr(file)                       [src/ocr/engine.js]
             ├─ provider = 'gradia'   → 上游行为（launchGradiaOcrForFile）
             ├─ provider = 'rapidocr' → ocrWithRapidOcr(file)          [本地子进程]
             └─ provider = 'llm'      → ocrWithLlm(pngBytes, cfg)      [网络]
                  └─ 若 translate.provider=='llm' 且 inherit → 提示词要求同时返回译文（一体化）
        └─ 若需要单独翻译 → translateText(text, …)  [src/translate.js]
             ├─ google → translate_a/single（免 key）
             └─ llm    → /chat/completions
        └─ 写剪贴板 + showOcrToast({text, translation})
```

### 4.4 模块契约（函数签名与返回结构，实现必须遵守）

```js
// src/ocr/engine.js
export async function dispatchOcr(file /* Gio.File */, opts = {})
// → { engine: 'gradia'|'rapidocr'|'llm', text: string, translation: string|null,
//     ms: { ocr: number, translate: number, total: number }, warnings: string[],
//     translationError?: string, requestId?: string }

// src/ocr/rapidocr.js
export async function ocrWithRapidOcr(file, { pythonPath, lang, timeoutMs })
// → { text, lines: [{ text, score }], ms }

// src/ocr/llm.js
export async function ocrWithLlm(pngBytes /* GLib.Bytes|Uint8Array */, cfg,
                                 { translate = false, targetLang = 'zh-CN', extraBody = {} })
// → { text, translation: string|null, ms, requestId?: string }

// src/translate.js
export async function translateText(text, { provider, targetLang, profile, warnings })
// → string；warnings 由调用方传入数组, 用于记录 TRANSLATE_TRUNCATED 等非致命告警

// src/net.js
export function sessionFor({ mode /* 'system'|'direct'|'custom' */, url, ignoreHosts })
export async function requestJson(session, { method, url, headers, json, timeoutMs })
// → { status, data }；失败抛 OcrError

// src/ocr/toast.js
export function showOcrToast({ text, translation, chars, ms })   // 复用 screenshotToast 的样式类; ms 显示为耗时
export function destroyOcrToast()
```

---

## 5. 配置项（GSettings）

**全部加进现有 schema** `org.gnome.shell.extensions.gradia-companion`（路径不变），键名与默认值如下，**默认值不得改动**（尤其不得预填 URL/model/key）。

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `ocr-enabled` | `b` | `true` | 关闭后即使装了 Gradia 也不显示 OCR 按钮 |
| `ocr-provider` | `s` | `'gradia'` | 可选：`gradia` / `rapidocr` / `llm`（用 `<choices>` 约束） |
| `ocr-rapidocr-python` | `s` | `''` | 空 = 使用 `<扩展数据目录>/venv/bin/python` |
| `ocr-rapidocr-lang` | `s` | `'ch'` | RapidOCR 的 `--lang_type` |
| `ocr-rapidocr-timeout-ms` | `i` | `30000` | 子进程超时 |
| `ocr-llm-enabled` | `b` | `false` | LLM OCR 总开关（`ocr-provider='llm'` 时仍要求此开关为真，否则报“未启用”） |
| `ocr-llm-base-url` | `s` | `''` | 例：`https://api.deepseek.com`（不预填） |
| `ocr-llm-model` | `s` | `''` | 例：`deepseek-flash`（不预填） |
| `ocr-llm-api-key` | `s` | `''` | 明文存 dconf；仅本机 |
| `ocr-llm-api-key-file` | `s` | `''` | 非空则优先读该文件首行（权限建议 600） |
| `ocr-llm-proxy-mode` | `s` | `'direct'` | `system` / `direct` / `custom` |
| `ocr-llm-proxy-url` | `s` | `'http://127.0.0.1:12334'` | 仅 `custom` 时使用 |
| `ocr-llm-timeout-ms` | `i` | `60000` | 网络超时 |
| `ocr-llm-prompt` | `s` | `''` | 空 = 内置提示词 |
| `ocr-llm-extra-body` | `s` | `'{}'` | JSON，浅合并进请求体（用于厂商扩展参数，如关闭思考模式） |
| `translate-enabled` | `b` | `true` | 是否翻译（`translate-provider='none'` 时无效） |
| `translate-provider` | `s` | `'none'` | `none` / `google` / `llm` |
| `translate-target-lang` | `s` | `'zh-CN'` | 目标语言（Google 与 LLM 共用） |
| `translate-llm-inherit` | `b` | `true` | 继承 OCR 的 LLM 配置 |
| `translate-llm-base-url` | `s` | `''` | 独立配置（`inherit=false` 时生效） |
| `translate-llm-model` | `s` | `''` | 同上 |
| `translate-llm-api-key` | `s` | `''` | 同上 |
| `translate-llm-api-key-file` | `s` | `''` | 同上 |
| `translate-llm-proxy-mode` | `s` | `'direct'` | 同上 |
| `translate-llm-proxy-url` | `s` | `'http://127.0.0.1:12334'` | 同上 |
| `translate-llm-timeout-ms` | `i` | `30000` | 同上 |
| `translate-llm-extra-body` | `s` | `'{}'` | 同上 |
| `google-proxy-mode` | `s` | `'system'` | Google 翻译的代理 |
| `google-proxy-url` | `s` | `'http://127.0.0.1:12334'` | 仅 `custom` 时使用 |
| `ocr-copy-mode` | `s` | `'both'` | `text` / `translation` / `both`（`both` = 原文 + 空行 + 译文） |

说明：原 `ocr-toast-chars` 键已移除——结果面板改为完整显示 + 滚动（D12）。

代理语义（**已在本机验证**）：

- `system`：不设置 `proxy-resolver`，走 GLib 系统代理（本机为 manual → `127.0.0.1:12334`）；
- `direct`：`Gio.SimpleProxyResolver.new('direct://', [])`；
- `custom`：`Gio.SimpleProxyResolver.new(<url>, ['localhost', '127.0.0.1'])`；
- 挂到会话：`soupSession.set_property('proxy-resolver', resolver)`。

**注意**：`Soup.Session.timeout` 是秒（`guint`），配置里的 `*-timeout-ms` 需要换算；请求取消/超时请用 `Gio.Cancellable` + `GLib.timeout_add`，不要用同步调用。

---

## 6. LLM 协议规范（仅 OpenAI 兼容）

### 6.1 请求

```
POST {base_url}/chat/completions          // base_url 末尾斜杠需归一化
Authorization: Bearer <key>
Content-Type: application/json

{
  "model": "<model>",
  "temperature": 0,
  "max_tokens": 2048,          // 可在 extra-body 覆盖 (P0 实测: 思考模式下单次 1344 tokens, 1024 会被截断)
  "messages": [
    { "role": "system", "content": "<内置系统提示词>" },
    { "role": "user", "content": [
        { "type": "text", "text": "<指令>" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,<...>" } }
    ]}
  ]
}
```

- 图片一律 PNG data URL（OCR 路径已是 PNG）；
- `extra-body` 做**浅合并**（顶层键覆盖）；
- 只从 `choices[0].message.content` 取文本；`content` 为数组时拼接其中的 `text` 字段。

### 6.2 提示词（内置，`ocr-llm-prompt` 为空时使用）

**仅 OCR：**

```
只识别图片中的文字，按原始阅读顺序逐行输出，保留换行与标点，不要解释、不要加引号、不要 Markdown 代码块。
```

**一体化（OCR + 翻译）：**

```
识别图片中的文字，并翻译成 {targetLang}。
只输出一个 JSON 对象，不要代码块、不要额外文字，格式：
{"text": "原文（保留换行）", "translation": "译文"}
```

### 6.3 响应解析（必须容错）

1. 去掉首尾空白与 ```json / ``` 围栏；
2. 若整体不是合法 JSON：截取第一个 `{` 到最后一个 `}` 再解析；
3. 仍失败：把整段文本当作 `text`，`translation=null`，并在 `warnings` 里记录 `LLM_BAD_JSON`；
4. 字段缺失或空字符串视为失败，抛 `OcrError('LLM_EMPTY')`。

### 6.4 厂商示例（文档与首选项说明里使用，**不预填**）

- DeepSeek（OpenAI 兼容）：`base_url = https://api.deepseek.com`，`model = deepseek-flash`（支持图片输入，可同时用于 OCR 与翻译）。
- 其他厂商只要兼容 `/chat/completions` 即可；OCR 要求模型**支持图片输入**，纯文本模型只能用于翻译。
- 部分厂商默认开启“思考模式”，会增加延迟；可用 `ocr-llm-extra-body` 传厂商参数关闭（具体键名以厂商文档为准）。
  DeepSeek V4.1 系列经 OpenAI 兼容网关实测：`{"thinking": {"type": "disabled"}}` 有效（单次耗时 3.6–6.5 秒降到 1.3–1.9 秒），`{"enable_thinking": false}` 无效。P0 数据见 `docs/P0-ocr-baseline.md`。

---

## 7. 本地 RapidOCR 规范

### 7.1 环境（由开发者创建，不写入仓库）

```bash
uv venv --python 3.13 ~/.local/share/gradia-capture/venv
uv pip install --python ~/.local/share/gradia-capture/venv/bin/python -i https://pypi.tuna.tsinghua.edu.cn/simple rapidocr onnxruntime
```

说明：Debian 13 的系统 Python 受 PEP 668 保护，必须用 venv；`uv` 已安装。

### 7.2 助手脚本 `python/ocr_helper.py`

- 参数：`--json --lang <ch|en|...> <image-path>`
- 必须先把结果 `json.dumps(ensure_ascii=False)` 打到 stdout，**不要在 stdout 打日志**（日志走 stderr）；
- stdout 成功格式：

```json
{"ok": true, "engine": "rapidocr", "ms": 812,
 "lines": [{"text": "第一行", "score": 0.98}],
 "text": "第一行\n第二行"}
```

- 失败格式（退出码 1）：

```json
{"ok": false, "error": "MODEL_LOAD_FAILED", "detail": "..."}
```

- 首次运行允许下载/加载模型（模型已随 wheel 提供，注意路径权限）。
- 子进程环境已隔离：通过 `Gio.SubprocessLauncher` 清空 `PYTHONPATH`/`PYTHONHOME`/`PYTHONSTARTUP` 并设置 `PYTHONNOUSERSITE=1`，避免宿主环境的其他 Python site-packages 污染 venv（issue #1 P1-2）。

### 7.3 扩展侧调用

1. **惰性**：只有 `ocr-provider='rapidocr'` 且真正触发时才解析 python 路径并 `stat`；
2. python 解析顺序：`ocr-rapidocr-python` → `<XDG_DATA>/gradia-capture/venv/bin/python`；
3. 不存在 → `OcrError('OCR_ENV_MISSING')`，提示文案包含上面两条安装命令；
4. spawn：`Gio.Subprocess.new([py, helper, '--json', '--lang', lang, path], STDOUT_PIPE | STDERR_PIPE)`，随后 `communicate_utf8_async`；
5. **禁止同步的 `communicate_utf8()`**；
6. 超时：超过 `ocr-rapidocr-timeout-ms` 就 `force_exit()` 并报 `OCR_TIMEOUT`；
7. 退出码非 0 / JSON 解析失败 → `OCR_FAILED`（stderr 截断 500 字符进 `detail`，仅记录日志，不展示给用户）。

---

## 8. Google 翻译

```
GET https://translate.googleapis.com/translate_a/single
    ?client=gtx&sl=auto&tl=<targetLang>&dt=t&q=<urlencoded text>
```

- 返回 JSON 数组，取 `[0]` 中每段的 `[0]` 拼接；
- 免 key，但需代理（默认 `system`）；
- 文本长度 > 4000 字符时按段落分批（每批 ≤ 4000，串行，最多 3 批，超出部分只翻前 3 批并在 warnings 记 `TRUNCATED`）；
- 失败抛 `NET_*` 错误码，由调用方决定是否降级（**原文必须保留**）。

---

## 9. UI 规范

- 结果面板（D12）：屏幕顶部居中，宽度自适应（最大 940），原文/译文左右两栏，各栏独立滚动（超长不再截断）；
- 面板头部：标题（OCR / OCR + 翻译）、总耗时、关闭按钮；
- 引擎行：OCR 引擎、翻译引擎、目标语言三个下拉选择器 + 「重新识别」按钮；切换后立即写回 GSettings 并重新识别，剪贴板同步更新；
- 面板按钮：「复制原文」「复制译文」「关闭」，点击任一复制按钮写入剪贴板后面板自动关闭；
- OCR 按钮保持原有图标按钮（`scanner-symbolic`），不加大、不加文字（曾试过胶囊按钮，与截图界面的截图按钮布局冲突，已回滚）；
- 剪贴板：`St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, str)`；
- 复制模式 `both` 时写入：`原文 + "\n\n" + 译文`；
- 长文本按 `ocr-toast-chars` 截断预览（末尾加 `…`），**剪贴板内容不截断**；
- 错误提示用现有通知机制（`Main.notify` 或扩展已有 toast），文案必须可操作（例：「未配置 OCR 后端：请在扩展设置 → OCR 与翻译中填写 base_url 与模型」）。

---

## 10. i18n 工作流

1. 所有新增用户可见字符串（toast、通知、首选项标签/副标题/说明）必须走 `src/i18n.js` 的 `_()`；模块级常量用 `N_()` 并在使用时再套 `_()`（与现有 `tools.js` 一致）；
2. 重新生成模板（命令已在本机验证，产出与现有 76 条一致）：

```bash
xgettext --from-code=UTF-8 --language=JavaScript \
  --keyword=_ --keyword=N_ --keyword=n_:1,2 \
  --package-name=gradia-capture --add-comments=TRANSLATORS: \
  -o po/gradia-capture.pot src/*.js src/ocr/*.js src/prefs/*.js
```

3. 合并进中文：

```bash
msgmerge --update --backup=none po/zh_CN.po po/gradia-capture.pot
```

4. 新增条目**必须全部译完**，不留 `fuzzy`、不留空 `msgstr`；校验：

```bash
msgfmt --check -o /dev/null po/zh_CN.po
grep -c 'msgstr ""' po/zh_CN.po   # 只应出现在头部
```

5. 不要改动已有 76 条 msgid（避免与上游 PR #44 冲突）。

---

## 11. 不变量与禁止事项

1. **禁止同步阻塞**：不得在 shell 主线程调用 `communicate_utf8()`、`send_and_read()`、`read_line()` 等同步 API；
2. **禁止 shell 命令拼接**：子进程一律用 argv 数组传参，不经过 `/bin/sh -c`；
3. **禁止记录密钥**：日志、toast、错误 detail 中不得出现 API key（截断/脱敏 `sk-…abcd`）；
4. **不改上游逻辑**：除 4.2 列出的 4 处小改动，不得重构 `extension.js` / `screenshotStore.js` 的既有流程；
5. **不动已有 gschema 键与默认值**；
6. **不把本功能混进上游 PR 分支**（`gnome-48-support`、`i18n-gettext-zh_CN` 保持干净）；
7. **不新增 npm/pip 依赖到仓库**：Python 依赖只存在于用户本机 venv，仓库只放 `ocr_helper.py`；
8. 所有新代码使用 ESM（`import ... from 'gi://...'`），与现有文件风格一致（4 空格缩进、单引号）。

---

## 12. 分阶段任务与验收（DoD）

### P0 — 环境与基线数据（0.5–1 小时，不改仓库代码）— 已完成，见 `docs/P0-ocr-baseline.md`

- 建 venv，装 `rapidocr` + `onnxruntime`（清华源）；
- 写 `python/ocr_helper.py` 原型，能在命令行对 PNG 输出约定 JSON；
- 取 **3 张真实截图**（中文界面、英文终端、中英混排），分别跑：
  - RapidOCR（本机耗时、识别文本）
  - LLM 视觉 OCR（用户自填的网关；仅用于评估，不写入仓库）
- 产出对照表（准确率主观评述 + 耗时），交回需求方决定默认引擎。

**DoD**：数据表 + 结论；`git status` 干净。

### P1 — LLM OCR 通路（0.5–1 天）— 代码完成，运行时问题已修复，待手工验收（Wayland 需注销重登）

范围：`net.js`、`ocr/llm.js`、`ocr/engine.js`（仅 llm 分支）、`ocr/toast.js`、LLM 相关设置键、最小 prefs 页、`extension.js` 两处改动、`build.sh` extra-source。

**DoD（手工验收）**：
1. 配置好 base_url/model/key 后，`Ctrl+E` 框选 → toast 显示文本 → 剪贴板有文本；
2. 未配置时给出可操作错误提示，不崩溃；
3. `journalctl --user -b -o cat /usr/bin/gnome-shell | grep -i gradia` 无 JS 异常；
4. OCR 期间桌面可正常交互（拖动窗口不卡）。

### P2 — 翻译（0.5 天）— 代码完成，待手工验收

范围：`translate.js`、继承/一体化逻辑、目标语言、复制模式、相关设置项。

**DoD**：
1. `translate-provider=google`：验证译文正确（需系统代理可用）；
2. `translate-provider=llm` + `inherit=false`：独立配置生效；
3. `translate-provider=llm` + `inherit=true` + `ocr-provider=llm`：**只发一次请求**（用网关日志或本地抓包确认），返回原文+译文；
4. 翻译失败时原文仍进剪贴板，toast 明确提示翻译失败。

### P3 — RapidOCR 本地引擎（0.5 天）— 已提前实现（代码完成，待手工验收）

**DoD**：
1. `ocr-provider=rapidocr` 在**断网**下可用；
2. 未建 venv 时提示安装命令；
3. `ocr-provider=llm` 时不 spawn python（验证方式：触发 OCR 后用 `pgrep -af ocr_helper.py` 应无输出）；
4. 首次调用延迟有记录（预期 0.5–1.5 秒模型加载）。

### P4 — 收尾（0.5 天）— 代码与文档完成，最终真机验收进行中

范围：三组代理的完整 UI 与说明文案、prefs 页面美化与分组、i18n 补译、`scripts/ocr-selftest.sh`、CHANGELOG。

**DoD**：
1. 三档代理各跑通一次（`system` 用 Google，`direct` 用国内网关，`custom` 故意指向一个不可用端口验证报错文案）；
2. `msgfmt --check` 通过，po 无 fuzzy/空译；
3. `./build.sh -i` 打包安装成功，注销重登后功能正常；
4. CHANGELOG 增加 fork 专属功能小节（注明不进上游 PR）。

---

## 13. 测试与环境操作备忘

### 13.1 语法与打包

```bash
# 纯语法检查（GNOME 扩展是 ESM，node 需要 .mjs 后缀识别）
for f in src/*.js src/ocr/*.js src/prefs/*.js; do cp "$f" /tmp/chk.mjs; node --check /tmp/chk.mjs || echo "FAIL $f"; done

./build.sh          # 只打包
./build.sh -i       # 打包并安装到 ~/.local/share/gnome-shell/extensions/
```

### 13.2 重载与日志

- **Wayland 下修改 JS 必须注销重新登录**才能生效（`gnome-extensions disable/enable` 不会重新加载代码）；
- 日志：`journalctl --user -b -o cat /usr/bin/gnome-shell | grep -i gradia`；
- 可选：用嵌套会话迭代（`dbus-run-session -- gnome-shell --nested --wayland`），不影响当前桌面，但需自行验证可用性。

### 13.3 环境事实（本机，已核实）

| 项 | 值 |
|---|---|
| 系统 | Debian 13.7，GNOME Shell 48.7，Wayland |
| libadwaita | 1.7.6（**没有** `Adw.ShortcutLabel`，有 `Gtk.ShortcutLabel`） |
| 网络库 | libsoup 3.6（`gi://Soup?version=3.0`），支持 `proxy-resolver` 属性 |
| Python | 3.13.5，系统受 PEP 668 保护；`uv` 在 `~/.local/bin/uv` |
| 图像工具 | ImageMagick（`magick`）已装；`tesseract` **未装**（本方案不依赖） |
| 桌面代理 | `org.gnome.system.proxy` = manual → `127.0.0.1:12334` |
| 扩展数据目录 | `~/.local/share/gradia-capture/`（venv 放这里，需自建） |

---

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| Shell 内异步链写错导致桌面冻结 | 所有网络/子进程用 async + Cancellable；P1 DoD 明确“拖动窗口不卡” |
| 上游私有 API 变动（`_showPointerButtonContainer` 等） | 改动面压到 2 行；出错时降级为「无按钮 + 通知」，不抛未捕获异常 |
| LLM 返回非 JSON | 6.3 的容错解析；失败降级为纯文本 + warning |
| 密钥泄漏 | 不入库、不落日志；支持 key 文件方式 |
| 首次 RapidOCR 冷启动慢 | 惰性加载；文档说明；可后续做常驻服务（不在本期） |
| Google 接口变动 | 报错文案明确；翻译失败不影响 OCR 结果 |
| i18n 与上游 PR #44 冲突 | 只增补 po 条目，不改已有 msgid |

---

## 15. 交付物

1. 分支：`feature/ocr-translate`（从 `local` 拉出），按 P0–P4 分阶段提交，每阶段一个或多个原子提交；
2. 代码：第 4.1 / 4.2 节所列文件；
3. 文档：本文件保持更新（决策变更必须回写）；`CHANGELOG.md` 增加该功能小节；
4. 自测：`scripts/ocr-selftest.sh` + P0 的对照数据；
5. **不推送上游**，不创建 PR；是否合并回 `local` 由需求方决定。

---

## 16. 原待确认问题（P0 后已由需求方拍板）

1. `ocr-llm-extra-body` 浅合并已足够（P0 实测 `{"thinking": {"type": "disabled"}}` 生效），不需要深合并；
2. `max_tokens` 默认值 1024 → **2048**；
3. toast **显示耗时**。

## 17. P0 决策记录（2026-11-25，需求方确认）

数据依据：`docs/P0-ocr-baseline.md`。

| 编号 | 决策 |
|---|---|
| D-P0-1 | 主推 LLM OCR（文档与首选项说明推荐）；`ocr-provider` 默认值维持 `gradia`，不改第 5 节默认值 |
| D-P0-2 | LLM 请求默认 `max_tokens` 改为 2048（含一体化模式） |
| D-P0-3 | `showOcrToast` 显示本次耗时 |
| D-P0-4 | P0 评估与 P1 手工验收使用本机 OpenAI 兼容网关（仅本机，配置不入库，不预填） |
| D-P0-5 | P0 样本截图不入库，保留在本机 `~/.local/share/gradia-capture/p0-samples/` |

P0 期间发现、需要在实现中吸收的差异（已回写到相关小节）：

- RapidOCR 3.10 模型随 wheel 自带，无下载；但每次子进程调用 3.5–4.5 秒（本机 4 核 CPU），P3 DoD 的延迟预期需按实测修正；
- 思考模式会挤占 `max_tokens` 并显著增加延迟，文档示例给出关闭方式（不预填）；
- 解析层需处理 `finish_reason == 'length'` 或空 `content` 的截断情况，给出可操作错误。

## 18. 运行时修复记录（2026-11-26）

首次重登实测发现 OCR 成功后仍报「OCR 失败」，排查结论与修复：

1. **toast 用了 GNOME 48 不存在的构造属性**，OCR 成功后创建 toast 抛异常，被 `dispatchOcr` 的 catch 当成 OCR 失败：
   - `St.BoxLayout` 没有 `spacing` 属性（是 CSS 属性），改为 `style: 'spacing: Npx;'`；
   - `St.Label` 没有 `line_wrap` / `line_wrap_mode` 属性，改为在 `label.clutter_text` 上设置；
   - St 没有 `Spinner` 类，改用 shell 自带的 `resource:///org/gnome/shell/ui/animation.js` 的 `Spinner`。
2. **缺少处理中反馈**：截图界面关闭后到结果出现之间没有任何提示（LLM 3-6 秒）。新增 `showOcrBusyToast()` / `destroyOcrBusyToast()`（`src/ocr/toast.js`），`dispatchOcr` 开始即显示「正在识别文字…」，结束或失败时销毁。
3. **失败日志信息不足**：`_notifyError` 只打印错误码。现在同时打印 `error.message`、`detail`，非 `OcrError` 时打印堆栈，便于定位。
4. **OCR 按钮可见性已确认**：在嵌套 shell（`gnome-shell --nested --wayland`）中用临时探针扩展实测，截图界面右下角容器有 3 个可见按钮（OCR `scanner-symbolic`、设置、指针），按钮条件只看 `ocr-enabled`（默认 true）。
5. **双引擎在真实 shell 进程内验证通过**：LLM（关思考）约 1.4 秒、RapidOCR 冷启动约 3.3 秒，均能返回文本并弹出结果 toast。

## 19. P3 提前实现记录（2026-11-26）

用户要求内置引擎也要可用，因此 RapidOCR 通路随 P1 修复一起实现：

- 新文件 `src/ocr/rapidocr.js`：惰性解析 python 路径（`ocr-rapidocr-python` → `<XDG_DATA>/gradia-capture/venv/bin/python`）、异步 `communicate_utf8_async`、超时 `force_exit()`、helper 错误码透传；
- 新增设置键：`ocr-rapidocr-python`、`ocr-rapidocr-lang`、`ocr-rapidocr-timeout-ms`；
- 首选项新增「RapidOCR (本地引擎)」分组，包含安装命令说明、解释器路径、语言、超时；
- 实测（嵌套 shell，本机 4 核 CPU）：冷启动约 3.3 秒，识别结果正确；模型随 wheel 自带，断网可用。

## 20. P2 实现与验证记录（2026-11-26）

P2 范围：`src/translate.js`、LLM 翻译复用、一体化、目标语言、复制模式、首选项翻译分组。

实现要点：

- `src/translate.js`：
  - Google 免 key：`translate_a/single`，`sl=auto`，按段落分批（每批 ≤ 4000 字符、最多 3 批、超出记 `TRANSLATE_TRUNCATED`），串行请求；
  - LLM 翻译：复用 `ocr/llm.js` 导出的 `chatEndpoint` / `readApiKey` / `extractMessageContent`，`max_tokens` 2048，`finish_reason=length` 抛 `LLM_TRUNCATED`；
  - 翻译失败抛 `OcrError`，由 `engine.js` 降级处理（原文保留）。
- `engine.js`：
  - 一体化（D7）：OCR=LLM 且翻译=LLM 且 `translate-llm-inherit=true` 时，一次请求同时取回原文与译文；
  - 非一体化：先 OCR 再调 `translateText()`；翻译失败时 `translation=null`、`translationError` 记录错误码、`warnings` 记 `TRANSLATE_FAILED`，toast 显示提示，剪贴板退化为原文；
  - 剪贴板按 `ocr-copy-mode`：`text` / `translation` / `both`（原文 + 空行 + 译文，翻译缺失时退化为原文）；
  - 翻译 profile：Google 用 `google-proxy-*`；LLM 继承时复用 OCR 的 LLM 配置，否则用 `translate-llm-*`。
- `toast.js`：新增 `notice` 行（翻译失败/截断提示）与 `showOcrBusyToast()`。
- 首选项新增「翻译」分组（启用/提供方/目标语言/继承/独立 LLM 配置/Google 代理），结果分组新增复制模式。

验证（嵌套 shell 内探针实测，真实 shell 进程）：

| 场景 | 结果 |
|---|---|
| Google 直连翻译普通英文句子 | 正确返回中文（经系统代理，0.9 秒） |
| RapidOCR + Google，复制模式 both | 原文 632 字，译文 416 字，剪贴板 1050 字含空行分隔，总耗时约 5.1 秒 |
| RapidOCR + 独立 LLM（inherit=false），复制模式 translation | 译文 279 字，剪贴板等于译文，总耗时约 5.6 秒 |
| 一体化（LLM OCR + LLM 翻译 + inherit），复制模式 text | **单次请求** 1.8 秒返回原文 413 字 + 译文 333 字，剪贴板等于原文 |
| Google 代理故意指向坏端口 | 原文 632 字保留，`translationError=NET_UNREACHABLE`，剪贴板等于原文（无空行） |
| 关闭翻译（translate-enabled=false） | translation 为 null，无翻译请求 |
| 首选项页 | 在 libadwaita 1.7 下构建无异常，新增分组加载正常 |

## 21. 录屏期间无法截图（调研记录，2026-11-26）

结论：这是 GNOME Shell 原生限制（非本 fork 引入）。截图界面 `ScreenshotUI.open()` 在 `_screencastInProgress` 为真时直接返回；该标志只由截图 UI 自带的录屏按钮置位。因此用系统截图 UI 录屏期间，系统截图与本扩展的 OCR 都不可用；用第三方录屏工具（OBS/Kooha/portal）时不设置该标志，按源码推断不影响截图。

顺带修复：`Main.screenshotUI.open` 包装器在 shell 拒绝打开时不再挂扩展 UI（`src/extension.js` 增加 `visible` 检查）。

详见 `docs/RESEARCH-recording-vs-screenshot.md`。

## 22. 需求变更与结果面板优化（2026-11-26，需求方确认）

数据依据：P2 嵌套桌面实测通过后，需求方提出以下优化（D12）：

1. 结果面板中点击「复制原文/复制译文」后自动关闭（复制即完成，无需保留）；
2. 面板加大，原文/译文左右并排对比，超长内容可滚动（不再按字符截断）；
3. 面板内明确显示当前 OCR 引擎与翻译引擎；可直接切换 OCR 引擎、翻译引擎、目标语言后重新识别（切换立即写回配置）；
4. 目标语言改为下拉框（列表见 `src/ocr/languages.js`，面板与首选项共用）；
5. （已回滚）OCR 按钮曾改为「图标 + 提取文字」的胶囊按钮，实测与截图界面的截图按钮布局冲突，恢复为原图标按钮；
6. 翻译失败提示具体到错误码对应原因（超时/无法连接/HTTP 错误/未配置等）；
7. 移除 `ocr-toast-chars` 键。

同步完成的 P4 项：

- `scripts/ocr-selftest.sh`：三档 OCR 后端对比自测（gradia 安装检查 / RapidOCR 直接调 helper / LLM 用 curl 调 OpenAI 兼容接口，输出耗时与字数）；
- `CHANGELOG.md`：新增「OCR 与翻译（fork 专属）」小节，并修正「OCR 按钮依赖 Gradia」的过时描述；
- 首选项页面按引擎/翻译配置动态显隐相关行，补充代理模式说明；
- i18n 新增文案全部补中文。

## 23. P4 验收记录（2026-11-26）

| 项 | 结果 |
|---|---|
| 三档代理：`system` + Google | 经系统代理成功，普通英文句子 0.9 秒返回中文 |
| 三档代理：`direct` + 本机 OpenAI 兼容网关 | 成功（LLM OCR 1.4–1.8 秒，RapidOCR + LLM 翻译 5–6 秒） |
| 三档代理：`custom` 指向不可用端口 | 按预期失败，提示 `NET_UNREACHABLE`，原文保留并写入剪贴板 |
| `msgfmt --check` / 无 fuzzy / 无空译 | 通过（200 条已翻译） |
| `./build.sh -i` 打包安装 | 通过，安装目录与仓库一致 |
| `scripts/ocr-selftest.sh` | 通过：gradia 未安装、RapidOCR 约 5 秒/398 字、LLM 约 1.6 秒/409 字 |
| 嵌套 shell 内结果面板 | 面板构造、重新识别（Google/LLM）、复制、关闭均正常 |
| 真机重登后验收 | 2026-11-26 15:56 已重登加载新代码，扩展 ACTIVE，journal 无 JS 异常；功能由需求方确认中 |

### 结果面板的额外实测

- 嵌套桌面实测：RapidOCR + LLM 翻译一次 398 字原文 + 392 字译文，面板无异常；
- 面板内切到 Google 翻译并重新识别：632 字原文 + 416 字译文；
- 复制写入剪贴板 1085 字（原文 + 空行 + 译文），面板自动关闭。

### 已知遗留（非阻塞）

- 22+ 个提交仅存在于本地 `feature/ocr-translate`，是否推送 origin / 合并回 `local` 待需求方决定；
- `src/metadata.json` 的描述仍是上游文案（未体现 OCR/翻译），可另行决定是否更新。

## 24. 交付后复核修复（issue #1，2026-11-27）

分支 `fix/ocr-followup`，逐项原子提交：

### P1-1 OCR 临时截图不再落到截图目录

- `src/screenshotStore.js` 增加 `tempOnly` 路径：PNG 写入 `$XDG_CACHE_HOME/gradia-capture/ocr-<时间戳>.png`，不复制剪贴板、不弹截图 toast、不写最近使用；
- `src/extension.js` 的 OCR 按钮按引擎决定：`gradia` 仍走常规保存（外部应用要读文件），其它引擎 `tempOnly: true`；
- `src/ocr/engine.js` 增加 `tempFile` 选项：面板关闭（复制/关闭/Esc/被新面板替换）时删除临时文件，识别失败路径也删除；
- 面板 `onClose` 回调负责清理，重新识别期间文件保留。

验收（嵌套 shell 实测）：

- 扩展 `_captureScreenshot({ocr:true,tempOnly:true})` 返回 `~/.cache/gradia-capture/ocr-20261127-162533.png`，`~/图片/截图` 前后均为 16 个文件；
- 面板关闭后临时文件 `query_exists=false`，缓存目录无 `manual-test-*` 残留；
- 故意把 LLM 指向 `127.0.0.1:9`：返回 `NET_UNREACHABLE`，临时文件同样被删除。

### P1-2 RapidOCR 子进程环境隔离

- `src/ocr/rapidocr.js` 改用 `Gio.SubprocessLauncher`，`unsetenv` 三个 Python 环境变量并设置 `PYTHONNOUSERSITE=1`。

验收：

- 污染 `PYTHONPATH=/nonexistent/python3.14/site-packages`、`PYTHONHOME=/nonexistent/python3.14` 后，从扩展触发 RapidOCR：成功识别 32 行 / 708 字，日志无 numpy ABI 报错；
- 同一环境下直接跑 gjs 测试脚本亦成功（`RAPIDOCR_ENV_ISOLATION_OK`）。

### P2-1 结果面板 Esc 关闭

- 面板上屏后 `Main.pushModal(container, {actionMode: NORMAL})` 抓取键盘，容器处理 `key-press-event`：Esc → `destroy()`；销毁时断开信号并 `Main.popModal()` 释放 grab。

验收：

- 面板显示时键盘焦点为面板容器（`St_BoxLayout 752x409`），销毁后焦点释放（`null`），20 次开关无 `incorrect pop`/grab 残留警告；
- Esc 实际按键需在真实会话人工确认（嵌套 Wayland 无法合成按键事件）。

### P2-2 disposed 警告

- `Selector` 自己持有并清理 `PopupMenu`/`PopupMenuManager`，销毁时断开按钮信号并 `removeMenu`；
- 面板销毁统一断开 Esc/按钮信号、销毁选择器，`onClose` 只执行一次；
- 菜单动作、`_render`、`_setControlsSensitive`、三个选择器回调都加 `_destroyed` 判断。

验收：

- 20 次面板打开/销毁循环后，journal 中来自 `ocr/toast.js` 的 disposed 警告为 0。
