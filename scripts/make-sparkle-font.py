# 状态栏星形图标字体 assets/trae-sparkle-final.ttf 的生成脚本（设计期原名 _final.py）。
# 依赖：pip install fonttools pathops；末尾的对照渲染需要本机 Edge，跑不通可以忽略那几行。
# 产物一律写到 build/，与 assets/ 里那份 diff 过再手动替换，避免覆盖已定稿资产。
import os, re, subprocess
from fontTools.svgLib.path import parse_path
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.misc.transform import Transform
from fontTools.fontBuilder import FontBuilder
from pathops import Path, FillType

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根
OUT = os.path.join(BASE, "build")
os.makedirs(OUT, exist_ok=True)
src = open(os.path.join(BASE, "assets", "source", "sparkle-filled.codicon.svg"), encoding="utf-8").read()
d_all = re.search(r'<path[^>]*d="([^"]+)"', src).group(1)
subs = [x for x in re.split(r'(?=[Mm])', d_all) if x.strip()]

def scale_about(s, cx, cy):
    return Transform(s, 0, 0, s, cx - cx * s, cy - cy * s)

def xform(d, *ts):
    sp = SVGPathPen(None); pen = sp
    for t in reversed(ts):
        pen = TransformPen(pen, t)
    parse_path(d, pen)
    return sp.getCommands()

def bbox(d):
    bp = BoundsPen(None); parse_path(d, bp); return bp.bounds

# --- opt3：大星 8->9，小星 6->5.5，整体平移居中 ---
T_BIG3   = scale_about(9.0 / 8.0, 6, 6)
T_SMALL3 = scale_about(5.5 / 6.0, 11, 11)
T_SHIFT3 = Transform(1, 0, 0, 1, 0.375, 0.375)

# --- 最终：把 12.25 的内容放大到 14，bbox 落在 (1,1)-(15,15) ---
S_FINAL = 14.0 / 12.25
T_FINAL = scale_about(S_FINAL, 8, 8)

big_final   = xform(subs[0], T_BIG3, T_SHIFT3, T_FINAL)
small_final = xform(subs[1], T_SMALL3, T_SHIFT3, T_FINAL)
d_final = big_final + small_final
print("final bbox:", tuple(round(v, 3) for v in bbox(d_final)))

# 中间参照
d_opt3 = xform(subs[0], T_BIG3, T_SHIFT3) + xform(subs[1], T_SMALL3, T_SHIFT3)
d_orig = d_all

def make_svg(d):
    return ('<svg width="16" height="16" viewBox="0 0 16 16" '
            'xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="%s"/></svg>' % d)

open(os.path.join(OUT, "sparkle-final.svg"), "w", encoding="utf-8").write(make_svg(d_final))
open(os.path.join(OUT, "sparkle-opt3.svg"), "w", encoding="utf-8").write(make_svg(d_opt3))

# ---- 字体：只含最终一个字形，尽量小 ----
UPM = 1000
TF = Transform(900.0 / 16.0, 0, 0, -900.0 / 16.0, 50.0, 950.0)
p = Path(); p.fillType = FillType.EVEN_ODD
parse_path(d_final, p.getPen()); p.simplify(fix_winding=True)

tt = TTGlyphPen(None)
p.draw(TransformPen(Cu2QuPen(tt, 0.6), TF))
glyf = {".notdef": TTGlyphPen(None).glyph(), "sparkle": tt.glyph()}

fb = FontBuilder(UPM, isTTF=True)
fb.setupGlyphOrder([".notdef", "sparkle"])
fb.setupCharacterMap({0xE001: "sparkle"})
fb.setupGlyf(glyf)
fb.setupHorizontalMetrics({".notdef": (500, 0), "sparkle": (UPM, 0)})
fb.setupHorizontalHeader(ascent=850, descent=-150)
fb.setupNameTable({"familyName": "TraeSparkle", "styleName": "Regular",
                   "psName": "TraeSparkle-Regular", "fullName": "TraeSparkle", "version": "1.0"})
fb.setupOS2(sTypoAscender=850, sTypoDescender=-150, usWinAscent=900, usWinDescent=100)
fb.setupPost()
ttf = os.path.join(OUT, "trae-sparkle-final.ttf")
fb.save(ttf)
print("TTF", os.path.getsize(ttf), "bytes")

# 顺便出一个 woff（更小）
try:
    from fontTools.ttLib import TTFont
    f = TTFont(ttf); f.flavor = "woff"
    woff = os.path.join(OUT, "trae-sparkle-final.woff")
    f.save(woff)
    print("WOFF", os.path.getsize(woff), "bytes")
except Exception as e:
    print("woff skip:", e)

# ---- 对照渲染 ----
rows = [("原版 sparkle-filled", d_orig),
        ("opt3（上一版）", d_opt3),
        ("最终版 放大到 14×14", d_final)]
cells = []
for label, d in rows:
    svg = make_svg(d)
    cells.append('<div class="row"><span class="big">%s</span><span class="small">%s</span>'
                 '<span class="nm">%s</span></div>' % (svg, svg, label))
cells.append('<div class="row"><span class="fbig">&#xe001;</span><span class="fsm">&#xe001;</span>'
             '<span class="nm">最终字体字形 U+E001</span></div>')

html = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@font-face{font-family:'SF';src:url('trae-sparkle-final.ttf') format('truetype')}
html,body{margin:0;padding:0}
.wrap{background:#1E1E1E;color:#E6E6E6;padding:24px 30px;font-family:Segoe UI,Arial,sans-serif}
.row{display:flex;align-items:center;gap:18px;padding:15px 0;border-bottom:1px solid #2C2C2C}
.row:last-child{border-bottom:none}
.big,.fbig{width:34px;height:34px;flex:0 0 34px;color:#E6E6E6}
.big svg{width:34px;height:34px}
.fbig{font-family:'SF';font-size:34px;line-height:34px}
.small,.fsm{width:18px;height:18px;flex:0 0 18px;padding-left:16px;border-left:1px solid #3A3A3A}
.small svg{width:16px;height:16px}
.fsm{font-family:'SF';font-size:16px;line-height:18px}
.nm{font-size:14px;margin-left:12px}
</style></head><body><div class="wrap">%s</div></body></html>""" % "".join(cells)

page = os.path.join(OUT, "_final.html")
open(page, "w", encoding="utf-8").write(html)
exe = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
out = os.path.join(OUT, "_final.png")
cmd = [exe, "--headless=new", "--disable-gpu", "--hide-scrollbars",
       "--force-device-scale-factor=3", "--window-size=560,340",
       "--user-data-dir=" + os.path.join(OUT, "_edge_profile"),
       "--screenshot=" + out, "file:///" + page.replace("\\", "/")]
r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
print("render rc", r.returncode, os.path.getsize(out) if os.path.exists(out) else 0)
