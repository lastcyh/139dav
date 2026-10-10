#!/usr/bin/env python3
"""
P0 探测：直连 139 分享接口验证（不经 OpenList）。

验证两件事，决定"合并挂载 + Alias 视图层"架构是否可行：
  1. 分享列表接口 getOutLinkInfoV6 能否直连调用（拿每个分享的根目录内容 -> 精确映射/失效检测）
  2. 下载直链 dlFromOutLinkV3 返回的 URL 是否绑定解析时的出口 IP（302 给客户端能否直接下）

用法（在本地，国内网络环境运行）:
    pip install pycryptodome
    python probe_share.py --auth "Basic后面那串" --account 13800138000 --link 2xG3sveZXXr7z
    python probe_share.py --auth ... --account ... --link "2xG3sveZXXr7z#abcd" --download
"""

import argparse
import base64
import json
import os
import re
import sys

import requests
from Crypto.Cipher import AES

AES_KEY = b"PVGDwmcvfs1uV3d1"          # OpenList 139 驱动内置的分享接口密钥
LIST_URL = "https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6"
DL_URL = "https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/dlFromOutLinkV3"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    "X-Deviceinfo": "||9|12.27.0|firefox|140.0|||linux unknown|1920X526|zh-CN|||",
    "hcy-cool-flag": "1",
    "CMS-DEVICE": "default",
    "x-m4c-caller": "PC",
    "X-Yun-Api-Version": "v1",
    "Origin": "https://yun.139.com",
    "Referer": "https://yun.139.com/",
}


def pkcs7_pad(data):
    n = 16 - len(data) % 16
    return data + bytes([n]) * n


def encrypt_payload(obj):
    """排序键 -> 紧凑 JSON -> AES-CBC -> base64(iv+密文)，与 OpenList 实现一致"""
    plain = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    iv = os.urandom(16)
    cipher = AES.new(AES_KEY, AES.MODE_CBC, iv)
    return base64.b64encode(iv + cipher.encrypt(pkcs7_pad(plain))).decode()


def decrypt_payload(text):
    if text.lstrip().startswith("{"):
        return json.loads(text)
    raw = base64.b64decode(text)
    cipher = AES.new(AES_KEY, AES.MODE_CBC, raw[:16])
    data = cipher.decrypt(raw[16:])
    pad = data[-1]
    # pad 为 0 时 data[:-0] 会变成空 bytes(合法的 PKCS7 不会是 0, 这里只是防御)
    return json.loads((data[:-pad] if pad else data).decode("utf-8", "replace"))


ID_RE = re.compile(
    r"(?:shareweb|w)/#/(?:w/i|share)/([0-9A-Za-z]+)"          # yun.139.com/shareweb/#/w/i/ID, /w/#/share/ID
    r"|caiyun\.139\.com/[wm]/i[/?]([0-9A-Za-z]+)"             # caiyun.139.com/m/i?ID
)


def parse_link(link):
    """完整链接 / 裸 ID / ID#提取码 都支持；完整链接尾部跟 #提取码 也认"""
    s = link.strip()
    m = ID_RE.search(s)
    if m:
        lid = m.group(1) or m.group(2)
        rest = s[m.end():].lstrip()
        pwd = ""
        if rest.startswith("#"):
            pwd = re.split(r"[,，;；\s]", rest[1:], maxsplit=1)[0].strip()
        return lid, pwd
    if "#" in s:                      # 裸 ID#提取码
        lid, pwd = s.split("#", 1)
        return lid.strip(), pwd.strip()
    return s, ""


def post(url, body, auth):
    r = requests.post(url, data=encrypt_payload(body),
                      headers={**HEADERS, "Authorization": f"Basic {auth}"}, timeout=30)
    r.raise_for_status()
    return decrypt_payload(r.text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--auth", required=True, help="Authorization，Basic 后面的串")
    ap.add_argument("--account", required=True, help="139 账号（手机号）")
    ap.add_argument("--link", required=True, help="分享 ID / 完整链接 / ID#提取码")
    ap.add_argument("--download", action="store_true", help="同时请求下载直链")
    args = ap.parse_args()

    lid, pwd = parse_link(args.link)
    print(f"分享ID: {lid}  提取码: {pwd or '(无)'}\n")

    # 1) 列分享根目录（分页拉全量：单页最多 200，不翻页只会拿到前 100）
    folders, files = [], []
    for page in range(100):
        b = page * 200 + 1
        resp = post(LIST_URL, {"getOutLinkInfoReq": {
            "account": args.account, "linkID": lid, "passwd": pwd, "pCaID": "root",
            "caSrt": 1, "coSrt": 1, "srtDr": 0, "bNum": b, "eNum": b + 199}}, args.auth)
        data = resp.get("data") or {}
        ca = data.get("caLst") or []
        co = data.get("coLst") or []
        folders += ca
        files += co
        if len(ca) + len(co) < 200:
            break
    print(f"[列表接口] 成功: 根目录 {len(folders)} 个文件夹, {len(files)} 个文件")
    for f in folders[:10]:
        print(f"    [目录] {f.get('caName')}  (caID={f.get('caID')})")
    for f in files[:10]:
        print(f"    [文件] {f.get('coName')}  {int(f.get('coSize', 0)) / 1e6:.1f}MB")
    if len(folders) > 10 or len(files) > 10:
        print("    ...")

    # 2) 下载直链（可选）
    if args.download and files:
        coid = files[0]["coID"]
        dl = post(DL_URL, {"dlFromOutLinkReqV3": {
            "account": args.account, "linkID": lid, "passwd": pwd,
            "coIDLst": {"item": [coid]}}}, args.auth)
        d = dl.get("data") or {}
        url = d.get("extInfo", {}).get("cdnDownloadURL") or d.get("redrURL") or d.get("downloadURL")
        print(f"\n[下载接口] 直链: {url[:120] if url else '(未返回)'}")
        if url:
            print("请验证: 1) 把这个 URL 换台设备/换个网络直接打开能否下载")
            print("         2) 能下载 => 直链不绑出口 IP，方案可行")
    elif args.download:
        print("\n[下载接口] 根目录没有文件（可能内容在子文件夹），跳过")


if __name__ == "__main__":
    sys.exit(main())
