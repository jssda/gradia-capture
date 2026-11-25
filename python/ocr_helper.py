#!/usr/bin/env python3
"""RapidOCR 命令行助手: 读取图片, 把识别结果以 JSON 打到 stdout.

扩展侧通过 Gio.Subprocess 调用本脚本, 只解析 stdout 的 JSON; 日志一律走 stderr.
"""

import argparse
import json
import os
import sys
import time


def fail(error, detail="", exit_code=1):
    payload = {"ok": False, "error": error}
    if detail:
        payload["detail"] = str(detail)[:500]
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return exit_code


def build_engine(lang):
    from rapidocr import RapidOCR

    params = {
        "Global.log_level": "warning",
        "Rec.lang_type": lang,
    }
    return RapidOCR(params=params)


def recognize(engine, image_path):
    result = engine(image_path)
    txts = _to_list(getattr(result, "txts", None))
    scores = _to_list(getattr(result, "scores", None))
    elapse = getattr(result, "elapse", None)

    lines = []
    for idx, text in enumerate(txts):
        if not text:
            continue
        score = float(scores[idx]) if idx < len(scores) else 0.0
        lines.append({"text": text, "score": round(score, 4)})

    return lines, elapse


def _to_list(value):
    return [] if value is None else list(value)


def main():
    parser = argparse.ArgumentParser(description="RapidOCR helper")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument("--lang", default="ch", help="RapidOCR 语言类型, 默认 ch")
    parser.add_argument("image", help="图片路径")
    args = parser.parse_args()

    started = time.monotonic()

    if not os.path.isfile(args.image):
        if args.json:
            return fail("IMAGE_NOT_FOUND", args.image)
        sys.stderr.write("图片不存在: %s\n" % args.image)
        return 1

    try:
        import rapidocr  # noqa: F401
    except Exception as exc:  # pragma: no cover - 环境问题
        if args.json:
            return fail("OCR_ENV_MISSING", exc)
        sys.stderr.write("rapidocr 不可用: %s\n" % exc)
        return 1

    try:
        engine = build_engine(args.lang)
    except Exception as exc:
        if args.json:
            return fail("MODEL_LOAD_FAILED", exc)
        sys.stderr.write("模型加载失败: %s\n" % exc)
        return 1

    try:
        lines, elapse = recognize(engine, args.image)
    except Exception as exc:
        if args.json:
            return fail("OCR_FAILED", exc)
        sys.stderr.write("识别失败: %s\n" % exc)
        return 1

    ms = int(round((time.monotonic() - started) * 1000))
    text = "\n".join(line["text"] for line in lines)

    if args.json:
        payload = {
            "ok": True,
            "engine": "rapidocr",
            "ms": ms,
            "lines": lines,
            "text": text,
        }
        json.dump(payload, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        sys.stdout.flush()
        if elapse is not None:
            sys.stderr.write("elapse %.3fs\n" % elapse)
        return 0

    sys.stdout.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
