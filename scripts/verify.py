# -*- coding: utf-8 -*-
"""校验：文件是否存在、大小是否正常、图片头是否合法。

用法（在仓库根目录）: python3 scripts/verify.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JPEG = b"\xff\xd8\xff"
PNG = b"\x89PNG\r\n\x1a\n"

with open(os.path.join(ROOT, "data", "pose.json"), encoding="utf-8") as f:
    data = json.load(f)

bad = []
total = 0
size_thumbs = size_img = 0
for item in data:
    for key, magic in (("サムネ", JPEG), ("原寸", PNG)):
        p = os.path.join(ROOT, item[key])
        total += 1
        if not os.path.exists(p):
            bad.append((p, "MISSING"))
            continue
        sz = os.path.getsize(p)
        if sz < 2048:
            bad.append((p, f"TOO_SMALL {sz}"))
            continue
        with open(p, "rb") as fh:
            head = fh.read(8)
        if not head.startswith(magic):
            bad.append((p, f"BAD_HEADER {head[:4]!r}"))
            continue
        if key == "サムネ":
            size_thumbs += sz
        else:
            size_img += sz

print(f"期望文件数 {total}，异常 {len(bad)}")
print(f"thumbs 合计 {size_thumbs/1048576:.1f} MB，img 合计 {size_img/1048576:.1f} MB，"
      f"总计 {(size_thumbs+size_img)/1048576:.1f} MB")
if bad:
    for p, why in bad[:40]:
        print(" ", p, why)
    with open(os.path.join(ROOT, "verify_failed.txt"), "w", encoding="utf-8") as f:
        for p, why in bad:
            f.write(f"{p}\t{why}\n")
    print("完整清单 -> verify_failed.txt")
    sys.exit(1)
print("全部通过 ✅")
