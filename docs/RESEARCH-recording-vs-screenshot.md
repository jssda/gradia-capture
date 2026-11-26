# 调研：录屏进行中为什么不能截图 / OCR

> 日期：2026-11-26。结论基于本机 GNOME Shell 48.7 的实际安装代码（`/usr/lib/gnome-shell/libshell-16.so` 内嵌的 `js/ui/screenshot.js`），不是猜测。

## 1. 结论

**是 GNOME Shell 原生行为，不是本 fork 或本扩展引入的限制。**

GNOME Shell 的截图界面 `ScreenshotUI.open()` 在录屏进行中会**直接返回、什么都不做**：

```js
async open(mode = UIMode.SCREENSHOT) {
    if (this._openingCoroutineInProgress)
        return;

    if (this._screencastInProgress)      // ← 录屏中直接退出
        return;

    if (mode === UIMode.SCREENCAST && !this._screencastSupported)
        return;
    ...
}
```

因此录屏期间：

- 系统截图快捷键（PrintScreen 等，走截图 UI）无任何反应；
- 本扩展的标注工具、保存、复制、OCR（Ctrl+E）全部不可用，因为它们都建立在 `Main.screenshotUI` 之上；
- `Ctrl+E` 无反应是预期现象：截图 UI 没有打开，扩展注册在 `Main.screenshotUI` 上的按键处理根本不会挂载。

## 2. 录屏状态从哪来

`ScreenshotUI._screencastInProgress` 只在截图 UI 自带的「录屏」按钮路径里被置位：

- `_startScreencast()`（截图 UI 录屏按钮触发）→ `_setScreencastInProgress(true)`；
- `stopScreencast()` → `_setScreencastInProgress(false)`。

所以被阻止的是**「截图 UI 自己发起的录屏」**。用第三方工具录屏（OBS、Kooha、ffmpeg）或直接经 `org.gnome.Shell.Screencast` D-Bus 发起录屏时，`_screencastInProgress` 不会被设置，按源码推断截图 UI 仍然可用。这一条在嵌套 shell 中实测时因嵌套环境的 screencast 服务崩溃（SIGSEGV）无法完成验证，属于待实机确认的推断。

## 3. 可选做法

1. **需要边录屏边截图/OCR**：改用第三方录屏工具（OBS / Kooha / ffmpeg + xdg-desktop-portal），不要用截图 UI 右上角的录屏按钮，然后正常截图。
2. **只用系统录屏**：录屏期间不接受截图，这是上游设计（避免截图 UI 出现在录制画面里），当前没有系统级开关可以绕过。
3. **后续可选增强（不在本期范围）**：扩展可绕过 `ScreenshotUI`，用 `Shell.Screenshot.screenshot_stage_to_content()` 直接截取整个 stage 再交给 OCR/翻译引擎。代价是没有选区/标注交互，需要新的触发方式（如托盘菜单或快捷键），且录屏画面里会出现结果 toast。

## 4. 顺带修复

上游的 `Main.screenshotUI.open` 包装器在 shell 静默拒绝打开（录屏中）时仍会调用扩展的 `_ensureUI()`，把工具栏挂到未显示的截图 UI 上。已在 `src/extension.js` 增加可见性检查，拒绝打开时不再挂 UI。
