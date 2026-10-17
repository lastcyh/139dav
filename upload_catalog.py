#!/usr/bin/env python3
"""
把 clean_links.py 生成的 catalog.json 上传到你的 139dav Worker。

用法:
    python upload_catalog.py --url https://xxx.workers.dev --user admin --pass 密码
    python upload_catalog.py            # 也可用环境变量 WORKER_URL / DAV_USER / DAV_PASS

若设置过管理口令, 上传需要使用它。目录更新在其他节点可能有短暂延迟。
"""

import argparse
import base64
import json
import os
import sys

import requests


def fail(msg):
    print(msg, file=sys.stderr)
    return 1


def main():
    ap = argparse.ArgumentParser(description="上传 catalog.json 到 139dav Worker")
    ap.add_argument("--url", default=os.environ.get("WORKER_URL", ""),
                    help="Worker 地址，如 https://xxx.workers.dev（默认取环境变量 WORKER_URL）")
    ap.add_argument("--user", default=os.environ.get("DAV_USER", ""),
                    help="WebDAV 账号（默认取环境变量 DAV_USER）")
    ap.add_argument("--pass", dest="dav_pass", default=os.environ.get("DAV_PASS", ""),
                    help="WebDAV 密码（默认取环境变量 DAV_PASS）")
    ap.add_argument("--admin-token", dest="admin_token", default=os.environ.get("ADMIN_TOKEN", ""),
                    help="管理口令（Worker 里设过才需要; 默认取环境变量 ADMIN_TOKEN，未设则用 --pass）")
    ap.add_argument("--file", default="catalog.json", help="catalog 文件路径，默认 catalog.json")
    ap.add_argument("--source-hash", default="", help="本次源文档指纹，成功上传后保存在 Worker")
    ap.add_argument("--if-changed", action="store_true", help="源指纹与最近成功上传相同时跳过")
    args = ap.parse_args()
    if args.if_changed and not args.source_hash:
        return fail("--if-changed 需要同时提供 --source-hash")

    url = (args.url or "").strip().rstrip("/")
    if not url:
        return fail("缺少 --url（或环境变量 WORKER_URL）")
    if not args.user or not (args.admin_token or args.dav_pass):
        return fail("缺少 --user 以及 --pass / --admin-token（或环境变量 DAV_USER / DAV_PASS / ADMIN_TOKEN）")
    # 上传是"写操作": Worker 设了管理口令就得用它, 没设才退回 WebDAV 密码
    admin_token = args.admin_token or args.dav_pass
    if not url.startswith("http"):
        url = "https://" + url

    try:
        with open(args.file, "r", encoding="utf-8") as f:
            catalog = json.load(f)
    except FileNotFoundError:
        return fail(f"找不到 {args.file}，请先运行: python clean_links.py")
    except json.JSONDecodeError as e:
        return fail(f"{args.file} 不是合法 JSON: {e}")

    if not isinstance(catalog, dict):
        return fail(f"{args.file} 顶层必须是 JSON 对象（形如 {{\"mounts\": {{...}}}}）")

    mounts = catalog.get("mounts") or {}
    if not mounts:
        return fail(f"{args.file} 里没有 mounts，检查清洗结果")

    target = f"{url}/admin/catalog"
    # 账号密码可能是中文: requests 的 auth= 元组按 latin-1 编码会直接抛 UnicodeEncodeError,
    # 而 Worker 端是支持 UTF-8 的 —— 手动 base64(utf-8) 设头, 两端行为对齐
    token = base64.b64encode(f"{args.user}:{admin_token}".encode("utf-8")).decode("ascii")
    headers = {"Authorization": f"Basic {token}"}
    if args.if_changed:
        try:
            state = requests.get(f"{url}/admin/sync-state", headers=headers, timeout=30)
            if state.status_code == 404:
                return fail("Worker 不支持同步状态，请先更新 Worker；明确全量上传时可去掉 --if-changed。未上传目录。")
            if state.status_code == 401:
                return fail("读取同步状态失败 (401)，未上传目录：请检查用户名和管理口令；旧版 Worker 的此接口也可能返回 401，请先升级 Worker 后重试。")
            if not state.ok:
                return fail(f"读取同步状态失败 HTTP {state.status_code}，未上传目录")
            info = state.json()
            if not isinstance(info, dict) or not isinstance(info.get("source_hash"), str):
                return fail("同步状态格式不合法，未上传目录")
            if info["source_hash"] == args.source_hash:
                print("data/ 与最近成功上传的版本一致，跳过上传（保留管理页手工修改）。")
                return 0
        except (requests.RequestException, ValueError) as e:
            return fail(f"读取同步状态失败，未上传目录: {e}")
    if args.source_hash:
        catalog["source_hash"] = args.source_hash
    try:
        r = requests.post(target, json=catalog,
                          headers=headers, timeout=30)
    except requests.RequestException as e:
        return fail(f"请求 {target} 失败: {e}")

    if r.status_code == 401:
        return fail("认证失败 (401)：Worker 若设了管理口令, 请用 --admin-token / ADMIN_TOKEN；否则 --user / --pass 要和配置里一致")
    if not r.ok:
        return fail(f"上传失败 HTTP {r.status_code}: {r.text[:200]}")

    try:
        info = r.json()
    except ValueError:
        return fail(f"上传返回了非 JSON 内容 (HTTP {r.status_code}): {r.text[:200]}")
    if not isinstance(info, dict) or info.get("ok") is not True:
        return fail("上传响应未确认成功，请检查 Worker 返回内容")
    print(f"上传成功: {info.get('mounts', len(mounts))} 个挂载 -> {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
