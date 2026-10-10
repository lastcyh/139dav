#!/usr/bin/env python3
"""
对 139dav Worker 跑一遍死链体检，失效或空白的分享会被自动从目录里移除。

用法:
    python check_links.py --url https://xxx.workers.dev --user admin --pass 密码
    python check_links.py            # 也可用环境变量 WORKER_URL / DAV_USER / DAV_PASS

Worker 设过管理口令的话要传 --admin-token（或环境变量 ADMIN_TOKEN），否则用 WebDAV 密码。
不用 GitHub Actions 的，直接在管理页点「检查链接」按钮就行，不用跑这个脚本。
"""

import argparse
import base64
import os
import sys

import requests


def fail(msg):
    print(msg, file=sys.stderr)
    return 1


def main():
    ap = argparse.ArgumentParser(description="对 139dav Worker 跑死链体检")
    ap.add_argument("--url", default=os.environ.get("WORKER_URL", ""),
                    help="Worker 地址，如 https://xxx.workers.dev（默认取环境变量 WORKER_URL）")
    ap.add_argument("--user", default=os.environ.get("DAV_USER", ""),
                    help="WebDAV 账号（默认取环境变量 DAV_USER）")
    ap.add_argument("--pass", dest="dav_pass", default=os.environ.get("DAV_PASS", ""),
                    help="WebDAV 密码（默认取环境变量 DAV_PASS）")
    ap.add_argument("--admin-token", dest="admin_token", default=os.environ.get("ADMIN_TOKEN", ""),
                    help="管理口令（Worker 里设过才需要；默认取环境变量 ADMIN_TOKEN，未设则用 --pass）")
    ap.add_argument("--max-rounds", type=int, default=2000,
                    help="最多请求多少轮，防止意外死循环，默认 2000")
    args = ap.parse_args()

    url = (args.url or "").strip().rstrip("/")
    if not url:
        return fail("缺少 --url（或环境变量 WORKER_URL）")
    if not args.user or not (args.admin_token or args.dav_pass):
        return fail("缺少 --user / --pass（或环境变量 DAV_USER / DAV_PASS）")
    if not url.startswith("http"):
        url = "https://" + url
    # 体检是写操作: Worker 设了管理口令就得用它, 没设才退回 WebDAV 密码
    admin_token = args.admin_token or args.dav_pass

    target = f"{url}/admin/check"
    token = base64.b64encode(f"{args.user}:{admin_token}".encode("utf-8")).decode("ascii")
    headers = {"Authorization": f"Basic {token}", "Content-Type": "application/json"}

    frm, removed, total = "", [], 0
    for _ in range(args.max_rounds):
        try:
            r = requests.post(target, json={"from": frm}, headers=headers, timeout=60)
        except requests.RequestException as e:
            return fail(f"请求 {target} 失败: {e}")
        if r.status_code == 401:
            return fail("认证失败 (401)：Worker 若设了管理口令, 请用 --admin-token / ADMIN_TOKEN；"
                        "否则 --user / --pass 要和配置里一致")
        if not r.ok:
            return fail(f"体检失败 HTTP {r.status_code}: {r.text[:200]}")
        try:
            j = r.json()
        except ValueError:
            return fail(f"返回了非 JSON 内容 (HTTP {r.status_code}): {r.text[:200]}")
        if not j.get("ok"):
            return fail(f"体检失败: {j.get('error') or r.status_code}")

        total = j.get("total", 0)
        removed += j.get("removed") or []
        frm = j.get("nextFrom") or ""
        if j.get("done") or not frm:
            break
    else:
        return fail(f"体检轮次超过上限 {args.max_rounds}, 可能哪里不对")

    print(f"体检完成：共 {total} 个挂载，清理 {len(removed)} 项")
    for x in removed:
        print(f"  - {x.get('path')}  {x.get('reason') or ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
