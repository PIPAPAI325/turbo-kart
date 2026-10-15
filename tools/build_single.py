# -*- coding: utf-8 -*-
"""
把多文件 ES module 游戏打包成单个 dist/index.html。

原理：模块源码以 JSON 字符串内联；import 说明符在构建期改写为
`from "%%模块名%%"` 占位符；运行时按拓扑序创建 Blob URL，并把占位符
替换为真实 blob URL（模块的 import 说明符必须是字符串字面量，blob
模块又拿不到外层作用域变量，故必须运行时替换）。
"""
import json
import re
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]

# 拓扑顺序：被依赖者在前
MODULES = [
    ("three", ROOT / "vendor" / "three.module.js"),
    ("sky", ROOT / "vendor" / "addons" / "objects" / "Sky.js"),
    ("track", ROOT / "src" / "track-data.js"),
    ("audio", ROOT / "src" / "audio.js"),
    ("phys", ROOT / "src" / "physics.js"),
    ("ai", ROOT / "src" / "ai.js"),
    ("env", ROOT / "src" / "environment.js"),
    ("main", ROOT / "src" / "main.js"),
]

SPEC_MAP = {
    "three": "three",
    "three/addons/objects/Sky.js": "sky",
    "./track-data.js": "track",
    "./audio.js": "audio",
    "./physics.js": "phys",
    "./ai.js": "ai",
    "./environment.js": "env",
    "./main.js": "main",
}

from_re = re.compile(r"(from\s*)(['\"])([^'\"]+)\2")


def rewrite(spec_src: str) -> str:
    def sub(m):
        spec = m.group(3)
        if spec not in SPEC_MAP:
            raise SystemExit(f"未知 import 说明符: {spec}")
        return f'{m.group(1)}"%%{SPEC_MAP[spec]}%%"'
    return from_re.sub(sub, spec_src)


def main():
    srcs, order = {}, []
    for name, path in MODULES:
        s = path.read_text(encoding="utf-8")
        if name != "three":   # three 自身无 import
            s = rewrite(s)
        order.append(name)
        srcs[name] = json.dumps(s).replace("</", "<\\/")  # 防 HTML 提前闭合

    order_js = json.dumps(order)
    dict_js = "{" + ",".join(f"{n}:{srcs[n]}" for n in order) + "}"
    inline = (
        f'const _order={order_js};\n'
        f'const _src={dict_js};\n'
        'const _u={};\n'
        'for (const _n of _order) {\n'
        '  const _s=_src[_n].replace(/"%%([a-z]+)%%"/g,(m,d)=>\'"\'+_u[d]+\'"\');\n'
        '  _u[_n]=URL.createObjectURL(new Blob([_s],{type:"text/javascript"}));\n'
        '}\n'
        'import(_u.main);\n'
    )

    html = (ROOT / "index.html").read_text(encoding="utf-8")
    head = html.split('<script type="importmap">')[0]
    out = head + '<script type="module">\n' + inline + "\n</script>\n</body>\n</html>\n"

    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    target = dist / "index.html"
    target.write_text(out, encoding="utf-8")
    print(f"OK -> {target}  ({target.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
