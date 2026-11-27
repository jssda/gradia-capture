# Changelog / 本地 fork 说明

本仓库是 [Alexander Vanhee 的 gradia-capture](https://github.com/AlexanderVanhee/gradia-capture)
的个人 fork（GPLv3），给自己在 Debian 13 + GNOME 48（Wayland）上长期使用。

目标只有一个：**保证这台机器上能用、界面是简体中文**，不打算与上游在功能上竞争。
因此本地改动刻意保持小而独立，每一条都尽量能作为上游 PR 提交；上游合并后就删掉对应提交，
让分叉保持"薄"。

## 基线

| 项目 | 值 |
|---|---|
| 上游仓库 | https://github.com/AlexanderVanhee/gradia-capture |
| 分叉基线 | `0b7e47e` (2026-10-16, Merge PR #33 "gnome-51") |
| 上游远程名 | `upstream` |
| 分支模型 | `master` = 上游镜像（只 fast-forward）；`local` = master + 本地提交 |

## 相对上游的改动

### 1. 支持 GNOME 48

- `src/metadata.json`：`shell-version` 增加 `"48"`。
- `src/prefs.js`：libadwaita 1.7（Debian 13 / GNOME 48）里没有 `Adw.ShortcutLabel`，
  该控件是 libadwaita 1.8（GNOME 49+）才迁到 Adw 的。改为运行时择一：
  有 `Adw.ShortcutLabel` 就用它，否则回退 `Gtk.ShortcutLabel`。
  没有这处改动，首选项窗口在 GNOME 48 上会直接报错打不开。

### 2. gettext 框架 + 简体中文翻译

上游没有翻译基础设施，所有界面字符串都是硬编码英文。本 fork 补上：

- 新增 `po/gradia-capture.pot`（字符串模板）与 `po/zh_CN.po`（76 条译文，全部已翻译）；
- 新增 `src/i18n.js`，提供 `_()` / `N_()` 两个简单包装；
- 各 UI 文件（`extension.js`、`prefs.js`、`topBar.js`、`tools.js`、
  `screenshotStore.js`、`screenshotToast.js`、`gradiaIntegration.js`）的可见字符串包上 `_()`；
- `build.sh` 增加 `--podir` 与 `--gettext-domain`，让编译后的 `.mo` 打进扩展包；
- `src/metadata.json` 增加 `gettext-domain`。

翻译是新 i18n 框架下的产物，不是上游内容的改写。

### 3. fork 维护说明

- 新增本文件，并把"这是 fork、改了什么、怎么升级"写进 README；
- `src/metadata.json` 增加 `license` 字段（见下方许可说明）。

### 4. OCR 与翻译（fork 专属，不进上游 PR）

截图界面新增「提取文字」按钮（`Ctrl+E`）：把选区截图交给 OCR 引擎，可选翻译，结果写入剪贴板并弹出结果面板。

- OCR 三档引擎：`gradia`（转发给 Gradia 应用）/ `rapidocr`（本地，离线）/ `llm`（OpenAI 兼容多模态模型）；
- 翻译：Google 免 key / LLM，可继承 OCR 的 LLM 配置（此时一体化请求，只发一次）；
- 结果面板：原文与译文左右对照，超长可滚动；面板内可直接切换 OCR 引擎、翻译引擎与目标语言后重新识别；点复制按钮后面板自动关闭；
- 三组独立代理：OCR LLM / 翻译 LLM / Google；
- 新增文件：`src/net.js`、`src/translate.js`、`src/ocr/*.js`、`src/prefs/ocrPage.js`、`python/ocr_helper.py`、`scripts/ocr-selftest.sh`；
- 方案与决策记录：`docs/PLAN-ocr-translate.md`；P0 基线数据：`docs/P0-ocr-baseline.md`；录屏限制调研：`docs/RESEARCH-recording-vs-screenshot.md`；
- 本地 RapidOCR 环境（不进仓库）：`uv venv --python 3.13 ~/.local/share/gradia-capture/venv`，再装 `rapidocr onnxruntime`。
- 交付后复核修复（issue #1）：
  - OCR 临时截图改写到 `$XDG_CACHE_HOME/gradia-capture/`，面板关闭/识别失败时自动删除，不再往`~/图片/截图`里留 PNG；
  - RapidOCR 子进程通过 `Gio.SubprocessLauncher` 隔离 `PYTHONPATH`/`PYTHONHOME`/`PYTHONSTARTUP`，并设置 `PYTHONNOUSERSITE=1`；
  - 结果面板支持 `Esc` 关闭（`Main.pushModal` 抓取键盘，销毁时释放）；
  - 面板销毁时清理选择器菜单与信号，异步回调统一加存活判断，消除 `already disposed` 警告。


## 升级上游的做法

```bash
git fetch upstream
git checkout master && git merge --ff-only upstream/master   # 只快进，永不本地提交
git checkout local && git rebase master
./build.sh -i                                                # 重新打包安装
# 注销重新登录后验证（见"每次升级后的验收清单"）
```

**冲突热点**：`src/extension.js`（单文件约 46 KB，私有 API 密集）。
上游正在推进 `save-as`、`selection-tool-disable`、`custom-toast` 等分支，
这些都会落在同一个文件里，rebase 时大概率需要手工解决。
所以本地改动尽量"新增文件 + 少量挂接点"，不重写上游代码。

## 每次升级后的验收清单

这扩展靠运行时替换 GNOME Shell 的内部成员（`_saveScreenshot`、`_primaryMonitorBin`、
`_areaSelector`、`_showPointerButtonContainer` 等），**上游改名就静默失效**，
不会有报错。升级 GNOME 或 rebase 之后必须手动过一遍：

1. 按 `PrtSc` → 截图界面是否正常出现；
2. 工具栏是否出现（画笔、颜色、撤销、清除）；
3. 画一笔 → 点保存 → 保存出来的图里是否带标注；
4. 工具栏文字是否仍是中文（`gnome-extensions info` 里能看到 enabled，但不代表脚本没抛错）；
5. 若界面异常，先看 `journalctl --user -b -o cat /usr/bin/gnome-shell | grep -i gradia`。

## 已知限制 / 注意事项

- **Wayland 下改 JS 必须注销重登**才生效，`gnome-extensions disable/enable` 不会重新加载代码。
- **OCR 按钮**由 `ocr-enabled`（默认开）控制，与是否安装 Gradia 无关；
  未配置后端或未安装对应运行环境时，触发后会给出一条可操作的通知。
- 与其它往 `_showPointerButtonContainer` 插按钮的扩展（如
  "Native Screenshot UI OCR Extended"）会抢同一个位置，可能互相干扰或触发 Shell 布局 bug。
- 扩展只针对 GNOME 48 验证过；49–51 保留在 `shell-version` 里是沿用上游，未实测。

## 许可

上游仓库只有根目录的 GPL v3 全文（`LICENSE`），源码文件**没有**逐文件版权头或
SPDX 标识，也没有 "or later" 字样，因此按 **GPLv3** 保守处理；本 fork 沿用同一许可，
并在 `metadata.json` 声明 `GPL-3.0-only`。GPLv3 不授予商标权，本仓库名称与上游同名仅作
来源标识，不代表上游官方版本。

另外说明：上游 `metadata.json` 的 `donations` 与首选项 About 页里的 Ko-fi 打赏链接
**仍指向原作者**，本 fork 未改动，也不代表本仓库收款。

## 本地构建

```bash
./build.sh      # 只打包
./build.sh -i   # 打包并安装到 ~/.local/share/gnome-shell/extensions/
```

安装后注销重新登录，再用 `gnome-extensions info gradia-integration@alexandervanhee.github.io`
确认状态。
