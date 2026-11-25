# P0 — OCR 引擎基线数据与结论

> 阶段：P0（环境与基线数据）。对应 `docs/PLAN-ocr-translate.md` 第 12 节 P0。
> 状态：已完成。待需求方决定主推引擎（见第 7 节）。
> 评估用 LLM 网关仅本机使用，不写入仓库，不预填进扩展默认配置。

## 1. 结论速览

1. **推荐主推 LLM OCR（`ocr-provider='llm'`）**：三张样本上准确率明显高于 RapidOCR，关闭思考模式后单次 1.3–1.9 秒，比 RapidOCR（3.5–4.5 秒）更快。
2. **RapidOCR 依然可用**（离线、免 key）：中文正文识别质量中上，但本机 CPU 上每次子进程调用 3.5–4.5 秒，且存在图标噪声、字母 O/数字 0 混淆、偶发漏行。
3. `ocr-provider` **默认值保持 `gradia` 不动**（符合 D1 与第 5 节「默认值不得改动」）；是否改为其他引擎需要先回写方案第 5 节。
4. 三个需要方案层面拍板的事项见第 7 节（默认引擎、`max_tokens` 默认值、toast 是否显示耗时）。

## 2. 环境（实测）

| 项 | 值 |
|---|---|
| 创建方式 | `uv venv --python 3.13 ~/.local/share/gradia-capture/venv`（uv 0.11.15） |
| Python | 3.13.5；venv 体积约 376 MB |
| rapidocr | 3.10.0（onnxruntime 后端） |
| onnxruntime | 1.32.0（CPU，无 GPU） |
| 其他依赖 | opencv-python-headless 5.1.0、numpy 2.5.5、shapely 2.2.0、pyclipper 1.4.0、pillow 13.0.0 |
| 模型 | **随 wheel 自带**，首次运行不需要下载：`PP-OCRv6_det_small`（9.9 MB）、`PP-OCRv6_rec_small`（21.2 MB，多语言）、`ch_ppocr_mobile_v2.0_cls_mobile`（0.6 MB） |
| 硬件 | Intel i5-6300HQ，4 核 4 线程，2.3 GHz，15 GiB RAM |
| 系统 | Debian 13.7、GNOME Shell 48.7、Wayland |

实际执行的安装命令（与方案 7.1 一致）：

```bash
uv venv --python 3.13 ~/.local/share/gradia-capture/venv
uv pip install --python ~/.local/share/gradia-capture/venv/bin/python \
  -i https://pypi.tuna.tsinghua.edu.cn/simple rapidocr onnxruntime
```

## 3. 测试样本

三张**真实应用窗口截图**，存于本机 `~/.local/share/gradia-capture/p0-samples/`，**不入仓库**。

说明：GNOME 48 Wayland 下外部进程调用 `org.gnome.Shell.Screenshot` 一律返回 `AccessDenied`，`gnome-screenshot`/`grim` 也不可用；因此样本用 XWayland 窗口（真实 GTK/xterm 渲染）配合 ImageMagick `import` 捕获，保留真实字体、抗锯齿、深色主题与窗口边框。

| 文件 | 应用与内容 | 尺寸 |
|---|---|---|
| `01-zh-ui.png` | GNOME 设置（无障碍页），中文界面，含开关、图标、快捷键提示 | 1370x911 |
| `02-en-terminal.png` | xterm 英文终端，`git log`/`git status`/`df -h` 输出 | 1086x657 |
| `03-mixed.png` | zenity 文本窗口，中英混排的 Markdown 文档，底部「取消(C)」「确定(O)」按钮 | 1022x682 |

## 4. 实测数据

测量口径：

- RapidOCR = 扩展将来的真实调用方式，即**独立 python 子进程**跑 `python/ocr_helper.py`，计时包含 Python 启动、模型与运行时初始化、推理；每个样本重复 3 次，取范围。
- LLM = 单次 `POST /chat/completions`，经本机 OpenAI 兼容网关（本机回环，仅评估用），计时包含网关路由。
- 硬件为 4 核老款移动 CPU，结果偏悲观；但不影响两个引擎的相对比较。

### 4.1 耗时

| 样本 | RapidOCR 冷进程 | LLM（思考开，默认） | LLM（思考关） |
|---|---|---|---|
| 01 中文界面 | 3.49 / 3.73 / 3.70 s | 4.11 s | 1.31 / 1.68 s |
| 02 英文终端 | 3.61 / 3.91 / 4.49 s | 6.45 s | 1.75 / 1.84 s |
| 03 中英混排 | 3.65 / 4.11 / 4.43 s | 3.61 s | 1.34 / 1.35 s（有 1 次 3.80 s 异常） |

耗时构成（RapidOCR，同进程内测量）：

| 项 | 耗时 |
|---|---|
| `RapidOCR()` 构造（惰性，不加载模型） | 约 17 ms |
| 首次推理额外开销（onnxruntime 会话初始化 + 模型加载） | 约 0.6–0.9 s |
| 热推理 700x320 裁剪 | 1.74–1.80 s |
| 热推理 1370x911 | 约 2.9 s |
| 冷进程总计（扩展实际会遇到） | 3.5–4.5 s |

结论：RapidOCR 的耗时**主要由每次调用新建进程的固定开销决定**，与图片尺寸关系较弱（裁剪到 700x320 仍要 3.3–3.7 s）。

Token 用量（LLM）：

| 样本 | prompt tokens | 思考开 completion | 思考关 completion |
|---|---|---|---|
| 01 | 823 | 585（其中 reasoning 511） | 73 |
| 02 | 507 | 1344（其中 reasoning 1127） | 216 |
| 03 | 517 | 636（其中 reasoning 479） | 154 |

### 4.2 识别质量

**01 中文界面（GNOME 设置）**

- RapidOCR：35 行里 14 行是图标碎片或误识（`Q`、`三`、`x`、`C`、`@`、`8`、`0`、`品`、`白` 等），侧栏「多任务」被识别成「夕仕分」，图标与文字粘连（「品 应用」「Q 搜索」），输出顺序为检测框顺序，侧栏与内容区交错。
- LLM：24 行纯文本，图标全部忽略，顺序为「标题 → 侧栏 → 内容区」，内容全对（含 `(A)`/`(S)`/`(H)`/`(T)`/`(P)`/`(Z)` 快捷键字母）。

**02 英文终端**

- RapidOCR：22 行，**整行漏识** `9286dc1 Add gettext infrastructure and Simplified Chinese translation`，并产生垃圾行 `x`、`g2    t   on`（对应真实的 `?? python/`），其余行准确。
- LLM：仅 1 处字符错误（`9286dc1` → `92860c1`，d 认成 0），其余全对。

**03 中英混排**

- RapidOCR：列表符号 `- ` 全部丢失，`OCR` → `0CR`（2 处），`OpenAI` → `0penAI`，部分半角标点变全角；正文（去空白）字符错误率约 2.7%。
- LLM（思考关）：同样约 2.7%，但错误性质不同：`Gradia` → `Gradio`，括号被写成全角；正文语义基本无损。
- LLM（思考开）：`Gradia` 正确（说明思考模式在个别歧义词上有收益）。

### 4.3 LLM 思考模式与 extra-body（对方案 6.4 / 16.1 的实测）

| 请求体附加参数 | 是否生效 | 说明 |
|---|---|---|
| 不附加（默认） | - | 思考开启：reasoning 479–1127 tokens，耗时 3.6–6.5 s |
| `{"thinking": {"type": "disabled"}}` | 是 | reasoning tokens 归零，耗时 1.3–1.9 s，识别质量基本不变（唯一差异见 03 的 Gradia→Gradio） |
| `{"enable_thinking": false}` | 否 | 仍产生 714 reasoning tokens，耗时 4.1 s |

结论：**`extra-body` 的顶层浅合并足够覆盖目标厂商参数，不需要嵌套深合并**（方案 16.1 问题可以关闭）。但需要在文档/首选项说明里给出该示例，且**不预填**到默认配置（D4）。

### 4.4 max_tokens 截断风险（对方案 6.1 的实测）

- 思考开启时，02 样本单次 OCR 的 completion 达到 **1344 tokens**，已超过方案 6.1 的默认 `max_tokens: 1024`；此时若 `max_tokens` 严格为 1024，输出会被截断，甚至 `content` 为空、`finish_reason=length`（本地验证过：`max_tokens=20` 时 content 为空、只有 reasoning）。
- 关闭思考后 completion 仅 73–216 tokens，1024 足够。
- 一体化模式（原文 + 译文）输出更长，按 1024 更容易被截断。

## 5. 关键发现（对方案的影响）

1. **rapidocr 3.10 的行为与方案假设不同**：模型随 wheel 自带无需下载（这一点假设成立），但方案 7.2 里的 `--lang` 在库内对应参数 `Rec.lang_type`（没有 `--lang_type` CLI），且 PP-OCRv6 识别模型是多语言模型，`ch`/`en` 共用同一模型文件。
2. **方案 P3 DoD 的延迟预期偏乐观**：原文「首次调用延迟 0.5–1.5 秒（模型加载）」应修正为「单次调用 3.5–4.5 秒（4 核 CPU），其中模型与运行时初始化约 0.7 秒，其余为 CPU 推理」。若后续希望提速，需要常驻进程方案（本期不做）。
3. **思考模式是 LLM 路径的主要延迟来源**，且会挤占 `max_tokens`；建议在文档示例中引导用户关闭（`{"thinking": {"type": "disabled"}}`），并在代码里对 `finish_reason == 'length'` 或空 `content` 给出可操作错误，而不是只报 `LLM_EMPTY`。
4. **LLM 响应会带 `reasoning_content` 字段**（DeepSeek V4.1 系列经本机网关）：方案 6.3 只取 `choices[0].message.content` 是对的，注意不要误取 reasoning 字段。
5. **本机截图能力事实**：GNOME 48 Wayland 拒绝外部进程调用 `org.gnome.Shell.Screenshot`；P0 样本用 XWayland 窗口捕获。P1 的 Ctrl+E 验收在扩展内部走 `Main.screenshotUI`，不受影响。

## 6. 建议

1. 默认值按方案保持 `ocr-provider='gradia'`；文档与首选项推荐语写「LLM（准确率优先）」和「RapidOCR（离线可用）」两档，不预填任何 URL/model/key。
2. LLM 文档示例（DeepSeek 兼容接口）建议同时给出：`base_url=https://api.deepseek.com`、`model=deepseek-flash`、`extra-body={"thinking": {"type": "disabled"}}`（均为示例文字，不预填）。
3. `max_tokens` 默认值建议从 1024 上调到 2048（见 7.2），并在解析层处理截断。
4. toast 建议显示耗时（见 7.3），便于用户判断延迟来自网络还是引擎。

## 7. 待需求方决定

1. **主推引擎**：是否在方案与首选项说明中主推 LLM，RapidOCR 作为离线备选；`ocr-provider` 默认值是否维持 `gradia`（若改默认值需回写方案第 5 节）。
2. **`max_tokens` 默认值**：是否把方案 6.1 的 1024 上调为 2048（或保留 1024，但代码对截断给出明确错误）。
3. **toast 是否显示耗时**：建议显示（方案 16.3）。
4. P0 样本截图是否需要入库（建议不入库，保持本机）。

## 8. 复现方式

```bash
V=~/.local/share/gradia-capture/venv/bin/python

# RapidOCR（扩展将来的调用方式）
$V python/ocr_helper.py --json --lang ch ~/.local/share/gradia-capture/p0-samples/01-zh-ui.png

# 失败路径
$V python/ocr_helper.py --json --lang ch /tmp/nope.png     # IMAGE_NOT_FOUND
/usr/bin/python3 python/ocr_helper.py --json /tmp/x.png    # OCR_ENV_MISSING
```

LLM 评估用任意 OpenAI 兼容网关，请求体按方案 6.1 构造：系统提示词用方案 6.2「仅 OCR」版本，图片为 `data:image/png;base64,...`，`temperature: 0`；对比时分别用默认请求与附加 `{"thinking": {"type": "disabled"}}` 的请求各测一次。
