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
import time

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
        return fail("缺少 --user 以及 --pass / --admin-token（或环境变量 DAV_USER / DAV_PASS / ADMIN_TOKEN）")
    if not url.startswith("http"):
        url = "https://" + url
    # 体检是写操作: Worker 设了管理口令就得用它, 没设才退回 WebDAV 密码
    admin_token = args.admin_token or args.dav_pass

    target = f"{url}/admin/check"
    token = base64.b64encode(f"{args.user}:{admin_token}".encode("utf-8")).decode("ascii")
    headers = {"Authorization": f"Basic {token}", "Content-Type": "application/json"}

    frm, removed, flagged, total, unverified = "", [], [], 0, 0
    log_warning = False
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
        if not isinstance(j, dict):
            return fail("体检响应不是 JSON 对象，尚未完成")
        if j.get("ok") is not True:
            return fail(f"体检失败: {j.get('error') or r.status_code}")
        if not isinstance(j.get("done"), bool):
            return fail("体检响应缺少完成状态，尚未完成")

        total = j.get("total", 0)
        log_warning = log_warning or j.get("logWarning") is True
        uncertain = j.get("unverified", 0)
        if isinstance(uncertain, int) and uncertain > 0:
            unverified += uncertain
        rem = j.get("removed")
        if isinstance(rem, list):
            removed += rem
        flg = j.get("flagged")
        if isinstance(flg, list):
            flagged += flg
        frm = j.get("nextFrom") or ""
        if j["done"]:
            break
        if not isinstance(frm, str) or not frm:
            return fail("体检响应缺少续查游标，尚未完成")
        if isinstance(rem, list) and rem:
            # 清理会写同一个 catalog/check_log 键, 两批之间避开 KV 的每秒写入限制。
            time.sleep(1.1)
    else:
        return fail(f"体检轮次超过上限 {args.max_rounds}, 可能哪里不对")

    print(f"体检完成：共 {total} 个挂载，清理 {len(removed)} 项")
    if log_warning:
        print("部分清理记录未保存，目录清理已生效；请保留下面的原分享ID及原始链接文档。")
    if unverified:
        print(f"本轮有 {unverified} 条分享未能确认，已保留，可稍后重试。")
    for x in removed:
        print(f"  - {x.get('path')}  {x.get('reason') or ''}  原分享ID: {x.get('id') or '-'}")
    if flagged:
        print(f"\n另有 {len(flagged)} 条分享需人工核对，已保留未删除：")
        for x in flagged:
            print(f"  - {x.get('path')}  {x.get('reason') or ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
