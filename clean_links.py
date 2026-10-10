#!/usr/bin/env python3
"""
把包含 139 分享链接的 Markdown / 文本，清洗成 139dav 的目录树 catalog.json。

规则:
  - "# / ## / ###" 标题行 -> 目录层级
  - 普通行: 行内文字清理后作为标题, 行内所有 139 链接绑定到该挂载
  - 标题自动去掉画质 / 集数等噪音
  - 每个文档内按分享 ID 去重；同一分享要挂到多个目录时，在文档里写成多行
    （跨文件不去重，所以放两个文件里会得到两个挂载）

用法:
    python clean_links.py                # 处理 data/ 下所有 .md / .txt / .docx
    python clean_links.py 某文件.md      # 处理指定文件

输出 catalog.json 后, 用 upload_catalog.py 上传到你的 Worker 即可。
"""

import glob
import html
import json
import os
import re
import sys
from datetime import datetime


try:
    import docx
except ImportError:
    docx = None

URL_PATTERNS = [
    re.compile(r"yun\.139\.com/(?:shareweb|w)/#/w/i/([0-9A-Za-z]+)"),
    re.compile(r"yun\.139\.com/w/#/share/([0-9A-Za-z]+)"),
    re.compile(r"caiyun\.139\.com/[wm]/i[/?]([0-9A-Za-z]+)"),
]
YEAR_RE = re.compile(r"[（(](\d{4})[）)]")
# 画质 / 集数等噪音。只删掉词本身、保留其余内容，
# 否则「4K修复版 某电影」这种前缀会被整条清空
NOISE_RE = re.compile(
    r"(4K|1080[Pp]|720[Pp]|HDR|DV|60[Ff][Pp][Ss]|高码率|高码|杜比|臻彩|内封|内嵌|简中|繁中|中英文字幕|"
    r"官方中字|未删减|纯净版|多版本|SDR|HQ|WEB-?DL|BluRay|REMUX|全\d+集|\d+集全|更新至第?\d+集)"
)
# data/示例合集.md 里的演示 ID，永远不参与清洗（否则会把假挂载推上线，覆盖真实目录）
DEMO_RE = re.compile(r"^ExampleID", re.I)
BAD_CHARS = re.compile(r'[\\/:*?"<>|]')
EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F900-\U0001F9FF\u2B00-\u2BFF\uFE0F]+",
    flags=re.UNICODE,
)


def extract_ids(line):
    """行内所有 139 分享，返回 ['分享ID'] 或 ['分享ID#提取码']（按分享 ID 去重）"""
    out, seen = [], set()
    for pat in URL_PATTERNS:
        for m in pat.finditer(line):
            sid = m.group(1)
            if sid in seen:
                continue
            seen.add(sid)
            # 提取码必须紧跟在 ID 后面（允许前置空格）。不能在整个剩余串里找 "#"：
            # 139 链接本身含 "#"（shareweb/#/w/i/...），同一行后面的另一个链接也带 "#"，
            # markdown 的 [链接](链接) 后半段同样是 URL
            rest = line[m.end():].lstrip()
            pwd = ""
            if rest.startswith("#"):
                cand = re.split(r"[,，;；\s)\]]", rest[1:], maxsplit=1)[0].strip()
                if cand and len(cand) <= 32 and not re.search(r"[/:?]", cand):
                    pwd = cand
            out.append(f"{sid}#{pwd}" if pwd else sid)
    return out


def clean_title(raw):
    """『某标题 4K 全12集：链接』 -> 『某标题』"""
    t = EMOJI_RE.sub("", raw)
    t = re.sub(r"\]\([^)]*\)", "", t)
    t = re.sub(r"https?://\S+", "", t)
    t = re.sub(r"[\\[\]`#*_|]", "", t)
    t = html.unescape(t).strip().strip("｜|").strip()
    no_noise = re.sub(r"\s{2,}", " ", NOISE_RE.sub(" ", t)).strip()
    if no_noise:            # 万一整个标题都是噪音词，就保留原样
        t = no_noise
    while True:
        t2 = re.sub(r"【[^【】]*】\s*$", "", t).strip().strip("：:").strip()
        if t2 == t:
            break
        t = t2
    year = YEAR_RE.search(t)
    base = t[: year.start()] if year else re.split(r"[：:]", t)[0]
    base = BAD_CHARS.sub(" ", base)
    base = re.sub(r"\s{2,}", " ", base).strip(" -_—·。，,")
    if not base:
        return None
    return f"{base} ({year.group(1)})" if year else base


def iter_lines(path):
    if path.lower().endswith(".docx"):
        if docx is None:
            raise RuntimeError("处理 .docx 需要: pip install python-docx")
        for p in docx.Document(path).paragraphs:
            yield p.text
    else:
        raw = open(path, "rb").read()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            # 网上扒下来的老文档常见 GBK/GB18030, 别直接崩
            text = raw.decode("gb18030", errors="replace")
        for line in text.splitlines():
            yield line


def parse_file(path):
    """返回按文档顺序的 {路径段, 标题, 链接ID列表} 列表（按分享 ID 在本文件内去重）"""
    items, seen = [], {}   # 分享ID -> 提取码(""): 去重先到先得, 但"无提取码"可被"带提取码"升级
    headings = []   # [(级别, 标题)] —— 用栈处理跳级标题
    for line in iter_lines(path):
        h = re.match(r"^(#{1,6})\s+(.*)", line)
        if h:
            level, text = len(h.group(1)), h.group(2).strip()
            # 弹掉同级或更深的标题: "# A → ### B → ### C" 应该是 A/C, 不是 A/B/C
            headings = [x for x in headings if x[0] < level] + [(level, text)]
            continue
        ids = [i for i in extract_ids(line) if not DEMO_RE.match(i)]
        if not ids:
            continue
        new_ids = []
        for i in ids:
            sid, _, pwd = i.partition("#")
            if sid not in seen:
                seen[sid] = pwd
                new_ids.append(i)
            elif pwd and not seen[sid]:
                # 同一分享先以"裸 ID"登记过、这行带提取码: 升级旧条目,
                # 否则去重会静默丢掉提取码, 生成一个需要提取码却拿不到的失效挂载
                seen[sid] = pwd
                for it in items:
                    for k, old in enumerate(it["ids"]):
                        if old.split("#")[0] == sid:
                            it["ids"][k] = i
        if not new_ids:
            continue
        raw = re.sub(r"https?://\S+", "", line)
        raw = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", raw).strip()
        title = clean_title(re.sub(r"^\d+[.、]\s*", "", raw)) or new_ids[0]
        items.append({"path": [t for _, t in headings], "title": title, "ids": new_ids})
    return items


def clean(files):
    mounts, used, total = {}, set(), 0
    for f in files:
        for item in parse_file(f):
            total += len(item["ids"])
            segs = [re.sub(r'[\\/:*?"<>|]', " ", s).strip() for s in item["path"]]
            segs = [s for s in segs if s]
            path = "/".join(segs + [item["title"]])
            key, n = path, 1
            while key in used:
                n += 1
                key = f"{path} ({n})"
            used.add(key)
            mounts[key] = {"id": ",".join(item["ids"])}

    if not mounts:
        # 关键: 宁可什么都不做, 也不能拿"示例数据 / 空目录"去覆盖线上真实目录
        # (POST /admin/catalog 是全量覆盖)
        if os.path.exists("catalog.json"):
            os.remove("catalog.json")
        print("没有解析到有效分享链接 —— 未生成 catalog.json, 线上目录不会被改动。")
        print("  · 只用 /admin 网页管目录: 可以删掉 .github/workflows/clean-upload.yml, 或忽略这一步")
        print("  · 要批量导入: 把链接文档放进 data/, 格式参考 data/示例合集.md")
        return 0

    # generated 必须带明确时区偏移。不带时区的话, Worker 端 Date.parse 会按 UTC 解析,
    # 目录的"最后修改时间"就会差 8 小时(北京时区下显示成未来时间), 而且 Actions(UTC)
    # 与本地(北京)跑出来的含义还不一致。
    catalog = {"version": 1, "generated": datetime.now().astimezone().isoformat(timespec="seconds"),
               "mounts": mounts}
    with open("catalog.json", "w", encoding="utf-8") as fp:
        json.dump(catalog, fp, ensure_ascii=False, indent=1)

    print(f"提取 {total} 条链接, 去重后 {len(mounts)} 个挂载 -> catalog.json")
    print("下一步: python upload_catalog.py --url <Worker地址> --user <账号> --pass <密码>")
    return 0


if __name__ == "__main__":
    files = sys.argv[1:] or sorted(glob.glob("data/*.md") + glob.glob("data/*.txt") + glob.glob("data/*.docx"))
    if not files:
        print("data/ 目录下没有找到链接文档, 格式参考 data/示例合集.md")
        sys.exit(1)
    sys.exit(clean(files))
