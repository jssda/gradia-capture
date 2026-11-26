#!/bin/bash
# 三档 OCR 后端的对比自测脚本: 输出耗时与识别结果预览.
# 用法: ./scripts/ocr-selftest.sh [图片路径]
# 说明: gradia 只检查是否安装; rapidocr 直接调用 python 助手; llm 用 curl 调 OpenAI 兼容接口.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/gradia-integration@alexandervanhee.github.io"
SCHEMA="org.gnome.shell.extensions.gradia-companion"
IMAGE="${1:-${HOME}/.local/share/gradia-capture/p0-samples/03-mixed.png}"
HELPER="${REPO}/python/ocr_helper.py"
VENV_PYTHON="${HOME}/.local/share/gradia-capture/venv/bin/python"

setting() {
    GSETTINGS_SCHEMA_DIR="${EXT_DIR}/schemas" gsettings get "${SCHEMA}" "$1" 2>/dev/null | sed "s/^'//; s/'$//"
}

echo "image: ${IMAGE}"
echo "schema dir: ${EXT_DIR}/schemas"
echo

row() {
    printf '%-10s | %-10s | %-6s | %s\n' "$1" "$2" "$3" "$4"
}

row "engine" "time" "chars" "preview"
row "----------" "----------" "------" "----------------------------------------"

# 1) gradia: 只检查安装状态, 无法在命令行拿到识别结果
if command -v flatpak >/dev/null 2>&1 && flatpak list --app 2>/dev/null | grep -q 'be.alexandervanhee.gradia'; then
    row "gradia" "-" "-" "installed (forwards the screenshot to the app)"
else
    row "gradia" "-" "-" "Gradia app not installed"
fi

# 2) rapidocr: 直接跑 helper
PYTHON="$(setting ocr-rapidocr-python)"
[ -z "${PYTHON}" ] && PYTHON="${VENV_PYTHON}"
LANG_TYPE="$(setting ocr-rapidocr-lang)"
[ -z "${LANG_TYPE}" ] && LANG_TYPE="ch"

if [ -x "${PYTHON}" ] && [ -f "${HELPER}" ]; then
    START=$(date +%s%3N)
    OUT="$("${PYTHON}" "${HELPER}" --json --lang "${LANG_TYPE}" "${IMAGE}" 2>/dev/null)"
    MS=$(( $(date +%s%3N) - START ))
    CHARS=$(printf '%s' "${OUT}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("text","")) if d.get("ok") else 0)' 2>/dev/null)
    PREVIEW=$(printf '%s' "${OUT}" | python3 -c 'import json,sys; d=json.load(sys.stdin); t=d.get("text","") if d.get("ok") else d.get("error",""); print(t.splitlines()[0][:60] if t else "")' 2>/dev/null)
    row "rapidocr" "${MS}ms" "${CHARS:-0}" "${PREVIEW}"
else
    row "rapidocr" "-" "-" "missing venv (${PYTHON}) or helper"
fi

# 3) llm: 用 curl 调 OpenAI 兼容接口
BASE_URL="$(setting ocr-llm-base-url)"
MODEL="$(setting ocr-llm-model)"
ENABLED="$(setting ocr-llm-enabled)"
API_KEY="$(setting ocr-llm-api-key)"
EXTRA_BODY="$(setting ocr-llm-extra-body)"
PROXY_MODE="$(setting ocr-llm-proxy-mode)"
PROXY_URL="$(setting ocr-llm-proxy-url)"

CURL_PROXY=()
case "${PROXY_MODE}" in
    direct) CURL_PROXY=(--noproxy '*') ;;
    custom) CURL_PROXY=(--proxy "${PROXY_URL}") ;;
    *) ;;
esac

if [ "${ENABLED}" = "true" ] && [ -n "${BASE_URL}" ] && [ -n "${MODEL}" ]; then
    BODY="$(python3 - "${IMAGE}" "${MODEL}" "${EXTRA_BODY:-{\}}" <<'PY'
import base64, json, sys
image_path, model, extra = sys.argv[1], sys.argv[2], sys.argv[3]
with open(image_path, 'rb') as fh:
    data = base64.b64encode(fh.read()).decode()
body = {
    "model": model,
    "temperature": 0,
    "max_tokens": 2048,
    "messages": [
        {"role": "system", "content": "只识别图片中的文字，按原始阅读顺序逐行输出，保留换行与标点，不要解释、不要加引号、不要 Markdown 代码块。"},
        {"role": "user", "content": [
            {"type": "text", "text": "识别截图中的全部文字。"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + data}},
        ]},
    ],
}
try:
    extra_obj = json.loads(extra) if extra.strip() else {}
except ValueError:
    extra_obj = {}
if isinstance(extra_obj, dict):
    body.update(extra_obj)
print(json.dumps(body, ensure_ascii=False))
PY
)"
    START=$(date +%s%3N)
    RESP="$(curl -sS -m 120 "${CURL_PROXY[@]}" \
        -H 'Content-Type: application/json' \
        ${API_KEY:+-H "Authorization: Bearer ${API_KEY}"} \
        -d "${BODY}" "${BASE_URL%/}/chat/completions" 2>/dev/null)"
    MS=$(( $(date +%s%3N) - START ))
    CHARS=$(printf '%s' "${RESP}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["choices"][0]["message"]["content"] or ""))' 2>/dev/null)
    PREVIEW=$(printf '%s' "${RESP}" | python3 -c '
import json,sys
d=json.load(sys.stdin)
content=d["choices"][0]["message"].get("content") or ""
print(content.splitlines()[0][:60] if content else "LLM_TRUNCATED_OR_EMPTY")' 2>/dev/null)
    row "llm" "${MS}ms" "${CHARS:-0}" "${PREVIEW}"
else
    row "llm" "-" "-" "LLM OCR disabled or not configured"
fi
