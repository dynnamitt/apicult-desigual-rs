#!/usr/bin/env python3
"""Generates docs/guide.html: fills the {{name}} slots of guide.tmpl.html with
inline SVG figures computed from the same rules as the Rust crate (hexx 0.24's
flat-top layout and direction tables, quad_corner_indices, the even-edge and
canonical-vertex ownership rules, the entangled bridging rule).

    python3 docs/guide/gen.py                       # writes docs/guide.html
    python3 docs/guide/gen.py --logo docs/logo.svg  # also writes the stand-alone logo

No dependencies beyond the Python 3 standard library. Output is deterministic,
so regenerating without changes leaves docs/guide.html byte-identical.
"""
import argparse, math
from pathlib import Path

HERE = Path(__file__).resolve().parent
ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
ap.add_argument("--template", type=Path, default=HERE / "guide.tmpl.html")
ap.add_argument("--out", type=Path, default=HERE.parent / "guide.html")
ap.add_argument("--logo", type=Path, help="also write the stand-alone logo SVG here")
args = ap.parse_args()
SQ3 = math.sqrt(3)

def center(q, r):  # flat-top axial -> world (x, z), unit spacing radius 1
    return (1.5*q, SQ3*(r + q/2))
def corner(q, r, i, ratio=1.0):
    cx, cz = center(q, r); a = math.radians(60*i)
    return (cx + ratio*math.cos(a), cz + ratio*math.sin(a))
EDGE = [(1,0),(0,1),(-1,1),(-1,0),(0,-1),(1,-1)]
QCI = {0:(0,1,4,3), 2:(2,3,0,5), 4:(4,5,2,1)}
def dist(q, r): return (abs(q)+abs(r)+abs(q+r))//2

# hexx 0.24 Hex::to_lower_res / to_higher_res, ported constant for constant.
def to_lower_res(q, r, R):
    x, y, z = q, r, -q-r; area = 3*R*(R+1)+1; sh = 3*R+2
    X = math.floor((y+sh*x)/area); Y = math.floor((z+sh*y)/area); Z = math.floor((x+sh*z)/area)
    return math.floor((1+X-Y)/3), math.floor((1+Y-Z)/3)
def to_higher_res(q, r, R):
    x, y, z = q, r, -q-r
    return x*(R+1) - R*z, y*(R+1) - R*x
# Known hexx outputs (taken from hexx itself), so a port mistake fails loudly.
assert to_lower_res(4, 0, 2) == (1, 0) and to_lower_res(-7, 5, 2) == (-2, 1) and to_lower_res(0, -4, 1) == (1, -2)
assert to_higher_res(1, 0, 1) == (3, -1) and to_higher_res(0, 1, 2) == (2, 3) and to_higher_res(1, 0, 2) == (5, -2)

# Cells of a radius-7 grid in hexx's shapes::hexagon order, with their radius-2 chunk.
TILES = [(q, r, *to_lower_res(q, r, 2)) for q in range(-7, 8) for r in range(max(-7, -q - 7), min(7, -q + 7) + 1)]

class View:
    def __init__(s, S, ox, oy): s.S, s.ox, s.oy = S, ox, oy
    def p(s, xz): return (s.ox + xz[0]*s.S, s.oy - xz[1]*s.S)
    def pts(s, l): return " ".join(f"{x:.1f},{y:.1f}" for x, y in map(s.p, l))

def poly(v, l, cls, extra=""): return f'<polygon class="{cls}" points="{v.pts(l)}" {extra}/>'
def hexpoly(v, q, r, ratio, cls): return poly(v, [corner(q, r, i, ratio) for i in range(6)], cls)
def text(x, y, t, cls="lbl", anchor="middle"): return f'<text class="{cls}" x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}">{t}</text>'
def line(a, b, cls): return f'<line class="{cls}" x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" y2="{b[1]:.1f}"/>'
def fig(svg_body, w, h, label, cap, wide=False):
    return f'''<figure{' class="wide"' if wide else ''}><div class="svgwrap"><svg viewBox="0 0 {w} {h}" role="img" aria-label="{label}">
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>
{svg_body}</svg></div><figcaption>{cap}</figcaption></figure>'''

def quad_pts(q, r, e, ratio):
    v0, v1, n0, n1 = QCI[e]; dq, dr = EDGE[e]
    return [corner(q, r, v0, ratio), corner(q+dq, r+dr, n0, ratio), corner(q+dq, r+dr, n1, ratio), corner(q, r, v1, ratio)]
def junc_pts(q, r, vi, ratio):
    if vi == 0: return [corner(q, r, 0, ratio), corner(q+1, r-1, 2, ratio), corner(q+1, r, 4, ratio)], [(q,r),(q+1,r-1),(q+1,r)]
    return [corner(q, r, 1, ratio), corner(q+1, r, 3, ratio), corner(q, r+1, 5, ratio)], [(q,r),(q+1,r),(q,r+1)]

figs = {}

# ---- F1 map_noise_to_range
b = []
x0, x1 = 60, 560
b.append(line((x0, 50), (x1, 50), "axis")); b.append(line((x0, 150), (x1, 150), "axis"))
b.append(text(x0-12, 54, "noise", "lbl dim", "end")); b.append(text(x0-12, 154, "height", "lbl dim", "end"))
for k in range(5):
    n = -1 + k*0.5; h = 20*(n+1)/2; x = x0 + (x1-x0)*k/4
    b.append(line((x, 50), (x, 150), "map"))
    b.append(f'<circle class="dot" cx="{x}" cy="50" r="4"/><circle class="dot acc" cx="{x}" cy="150" r="4"/>')
    b.append(text(x, 36, f"{n:g}")); b.append(text(x, 174, f"{h:g}"))
b.append(text((x0+x1)/2, 196, "min + (n + 1) / 2 · (max − min)   with min = 0, max = max_height = 20", "lbl mono"))
figs["f1"] = fig("\n".join(b), 620, 210, "Noise values from -1 to 1 map linearly onto heights 0 to 20",
  "<code>map_noise_to_range(n, 0.0, 20.0)</code>: a straight line from the noise axis to the output axis. Nothing clamps, so a noise value past ±1 lands past the ends.")

# ---- F2 edge_cuboid_transform
b = []
O = (70, 230); F = (200, 200); T = (430, 80)
b.append(f'<line class="axis" x1="{O[0]}" y1="{O[1]}" x2="{O[0]+90}" y2="{O[1]}" marker-end="url(#arr)"/>'); b.append(text(O[0]+100, O[1]+4, "+X", "lbl dim", "start"))
ang = math.atan2(T[1]-F[1], T[0]-F[0]); L = math.dist(F, T); M = ((F[0]+T[0])/2, (F[1]+T[1])/2)
ux, uy = math.cos(ang), math.sin(ang); nx, ny = -uy, ux; hw = 16
box = [(F[0]+nx*hw, F[1]+ny*hw), (T[0]+nx*hw, T[1]+ny*hw), (T[0]-nx*hw, T[1]-ny*hw), (F[0]-nx*hw, F[1]-ny*hw)]
b.append('<polygon class="quad soft" points="' + " ".join(f"{x:.1f},{y:.1f}" for x, y in box) + '"/>')
b.append(line(F, T, "edge"))
b.append(f'<circle class="dot" cx="{F[0]}" cy="{F[1]}" r="5"/><circle class="dot" cx="{T[0]}" cy="{T[1]}" r="5"/><circle class="dot acc" cx="{M[0]:.1f}" cy="{M[1]:.1f}" r="6"/>')
b.append(text(F[0]-6, F[1]+24, "from")); b.append(text(T[0]+10, T[1]-14, "to", "lbl", "start")); b.append(text(M[0]+18, M[1]+30, "midpoint", "lbl acc", "start"))
b.append(text((F[0]+T[0])/2-30, (F[1]+T[1])/2-28, "length = |to − from|", "lbl mono", "end"))
r_ = 60; a_end = ang
b.append(f'<path class="arc" d="M{O[0]+r_},{O[1]} A{r_},{r_} 0 0 0 {O[0]+r_*math.cos(a_end):.1f},{O[1]+r_*math.sin(a_end):.1f}" marker-end="url(#arr)"/>')
b.append(f'<line class="axis dash" x1="{O[0]}" y1="{O[1]}" x2="{O[0]+120*ux:.1f}" y2="{O[1]+120*uy:.1f}"/>')
b.append(text(O[0]+58, O[1]-12, "rotation", "lbl acc", "start"))
figs["f2"] = fig("\n".join(b), 520, 260, "A unit cuboid along X is rotated, stretched and moved onto an edge",
  "<code>edge_cuboid_transform(from, to)</code> returns where to put a beam: its centre, its length, and the shortest rotation that turns +X onto the edge direction (<code>Quat::from_rotation_arc</code>). A zero-length edge gets no rotation.")

# ---- F3 gap_vertex_data (oblique sketch)
def obl(p, ox, oy):  # (x, y, z) -> svg, oblique
    x, y, z = p; return (ox + x*60 + z*28, oy - y*60 - z*18)
b = []
quadw = [(1.0, 1.6, 0.0), (3.0, 1.2, 0.0), (3.0, 0.9, 1.8), (1.0, 1.3, 1.8)]
def draw_quad(pts, ox, oy, cls):
    s = [obl(p, ox, oy) for p in pts]
    return '<polygon class="%s" points="%s"/>' % (cls, " ".join(f"{x:.1f},{y:.1f}" for x, y in s)), s
pq, s1 = draw_quad(quadw, 40, 210, "quad soft"); b.append(pq)
b.append(f'<circle class="dot acc" cx="{s1[0][0]:.1f}" cy="{s1[0][1]:.1f}" r="5"/>'); b.append(text(s1[0][0]-8, s1[0][1]+18, "v0 (origin)", "lbl acc", "end"))
b.append(text(140, 240, "world space", "lbl dim"))
o0 = quadw[0]; loc = [(p[0]-o0[0], p[1]-o0[1], p[2]-o0[2]) for p in quadw]
pq, s2 = draw_quad(loc, 380, 170, "quad"); b.append(pq)
b.append(f'<circle class="dot acc" cx="{s2[0][0]:.1f}" cy="{s2[0][1]:.1f}" r="5"/>'); b.append(text(s2[0][0]-8, s2[0][1]+18, "0,0,0", "lbl mono", "end"))
for i, nm in [(1, "e1 = v1 − v0"), (2, "e2 = v2 − v0")]:
    b.append(f'<line class="edge" x1="{s2[0][0]:.1f}" y1="{s2[0][1]:.1f}" x2="{s2[i][0]:.1f}" y2="{s2[i][1]:.1f}" marker-end="url(#arr)"/>')
b.append(text(s2[1][0]+8, s2[1][1]+16, "e1", "lbl mono", "start")); b.append(text(s2[2][0]+8, s2[2][1], "e2", "lbl mono", "start"))
cx_, cy_ = s2[0][0]+40, s2[0][1]-12
b.append(f'<line class="axis dash" x1="{cx_}" y1="{cy_}" x2="{cx_}" y2="{cy_+60}" marker-end="url(#arr)"/>'); b.append(text(cx_+8, cy_+66, "e1 × e2 (down)", "lbl dim", "start"))
b.append(f'<line class="edge acc" x1="{cx_}" y1="{cy_}" x2="{cx_}" y2="{cy_-80}" marker-end="url(#arr)"/>'); b.append(text(cx_+8, cy_-80, "normal = −(e1 × e2)", "lbl acc", "start"))
b.append(f'<line class="map" x1="260" y1="150" x2="330" y2="150" marker-end="url(#arr)"/>'); b.append(text(295, 140, "− v0", "lbl mono"))
b.append(text(470, 240, "origin-local", "lbl dim"))
figs["f3"] = fig("\n".join(b), 640, 260, "Gap vertices are shifted so the first is at the origin, and a normal is taken from a cross product",
  "<code>gap_vertex_data(verts, flat)</code>: subtract <code>v0</code> from every vertex, then take the normal from the first two edges. The winding makes the raw cross product point down, so it is negated. With <code>flat = true</code> it skips this and returns <code>+Y</code>, which matches the flat hex faces.")

# ---- F4 IDW
b = []
v = View(70, 300, 170)
Q = (0.35, 0.25)
verts = []
for i in range(6):
    c = corner(0, 0, i, 1.0); verts.append((c[0], [4.0, 6.0, 9.0, 7.0, 3.0, 2.0][i], c[1]))
ws = [1/((Q[0]-x)**2 + (Q[1]-z)**2) for x, _, z in verts]
hq = sum(w*y for w, (_, y, _) in zip(ws, verts)) / sum(ws)
b.append(hexpoly(v, 0, 0, 1.0, "face soft"))
tot = sum(ws)
for (x, y, z), w in zip(verts, ws):
    sp = v.p((x, z)); qp = v.p(Q)
    b.append(f'<line class="map" x1="{qp[0]:.1f}" y1="{qp[1]:.1f}" x2="{sp[0]:.1f}" y2="{sp[1]:.1f}" style="stroke-width:{0.6+7*w/tot:.2f}"/>')
    b.append(f'<circle class="dot" cx="{sp[0]:.1f}" cy="{sp[1]:.1f}" r="5"/>')
    dx = (x)*26; dz = (z)*26
    b.append(text(sp[0]+dx, sp[1]-dz+4, f"h={y:g}", "lbl mono"))
    b.append(text(sp[0]+dx, sp[1]-dz+18, f"{100*w/tot:.0f}%", "lbl dim"))
qp = v.p(Q); b.append(f'<circle class="dot acc" cx="{qp[0]:.1f}" cy="{qp[1]:.1f}" r="6"/>'); b.append(text(qp[0]-8, qp[1]+30, f"Q → {hq:.2f}", "lbl acc", "end"))
figs["f4"] = fig("\n".join(b), 600, 330, "Inverse distance weighting: nearer vertices pull the height harder",
  f"<code>idw_interpolate_height(Q, verts)</code> with six example corners. Each weight is <code>1 / d²</code> (line thickness, share in %), so the answer is a weighted mean, here {hq:.2f}. A query within √0.001 of a vertex snaps to that vertex's height. <code>HGridLayout::interpolate_height</code> feeds it the corners of the hex under Q and its six neighbours.")

# ---- F5 directions + quad_corner_indices
b = []
v = View(78, 230, 230)
for e in range(6):
    dq, dr = EDGE[e]; b.append(hexpoly(v, dq, dr, 0.8, "face ghost"))
    cx, cz = center(dq, dr); sp = v.p((cx, cz)); b.append(text(sp[0], sp[1]+4, f"({dq},{dr})", "lbl mono dim"))
b.append(hexpoly(v, 0, 0, 0.8, "face"))
for e in range(6):
    a = corner(0, 0, e, 0.8); c = corner(0, 0, (e+1) % 6, 0.8)
    b.append(line(v.p(a), v.p(c), "edge own" if e % 2 == 0 else "edge thin"))
    m = ((a[0]+c[0])/2*0.72, (a[1]+c[1])/2*0.72); sp = v.p(m)
    b.append(text(sp[0], sp[1]+4, f"e{e}", "lbl acc" if e % 2 == 0 else "lbl dim"))
for i in range(6):
    sp = v.p(corner(0, 0, i, 0.8)); own = i in (0, 1)
    b.append(f'<circle class="dot{" junc" if own else ""}" cx="{sp[0]:.1f}" cy="{sp[1]:.1f}" r="{6 if own else 4}"/>')
    lp = v.p(corner(0, 0, i, 1.02)); b.append(text(lp[0], lp[1]+4, str(i), "lbl mono"))
sp = v.p((0, 0)); b.append(text(sp[0], sp[1]+4, "(0,0)", "lbl mono"))
# right panel: quad for edge 0
v2 = View(78, 560, 250)
b.append(hexpoly(v2, 0, 0, 0.75, "face")); b.append(hexpoly(v2, 1, 0, 0.75, "face"))
qp_ = quad_pts(0, 0, 0, 0.75); b.append(poly(v2, qp_, "quad"))
b.append(line(v2.p(qp_[0]), v2.p(qp_[2]), "diag"))
for nm, p, off in zip(["v0 = 0", "n0 = 4", "n1 = 3", "v1 = 1"], qp_, [(-10, 18), (10, 18), (10, -8), (-10, -8)]):
    sp = v2.p(p); b.append(f'<circle class="dot" cx="{sp[0]:.1f}" cy="{sp[1]:.1f}" r="4"/>')
    b.append(text(sp[0]+off[0], sp[1]+off[1], nm, "lbl mono", "end" if off[0] < 0 else "start"))
sp = v2.p(center(0, 0)); b.append(text(sp[0], sp[1]+4, "owner", "lbl"))
sp = v2.p(center(1, 0)); b.append(text(sp[0], sp[1]+4, "neighbour", "lbl"))
b.append(text(560, 430, "quad_corner_indices(0) = (0, 1, 4, 3)", "lbl mono"))
figs["f5"] = fig("\n".join(b), 760, 450, "Hex corner and edge indices; each hex owns even edges and vertices 0 and 1",
  "Left: the flat-top hex at <code>(0,0)</code> with corner indices 0–5 (<code>VertexDirection</code>) and edge indices e0–e5 (<code>EdgeDirection</code>, labelled with the neighbour each edge faces). Thick edges e0, e2, e4 are the ones it owns. The two larger dots are its owned junction corners, 0 and 1. Right: <code>quad_corner_indices(0)</code> pairs owner corners 0 and 1 with neighbour corners 4 and 3. The dashed line is the <code>a–c</code> diagonal the quad is split along. Drawn with x to the right and z up.", wide=True)

# ---- F6 gap_filler r=2 grid
def ownership_svg(v, cells, ratio, cls_face="face"):
    s = set(cells); out = []
    for q, r in cells: out.append(hexpoly(v, q, r, ratio, cls_face))
    nq = nj = 0
    for q, r in cells:
        for e in (0, 2, 4):
            dq, dr = EDGE[e]
            if (q+dq, r+dr) in s: out.append(poly(v, quad_pts(q, r, e, ratio), "quad")); nq += 1
        for vi in (0, 1):
            pts, co = junc_pts(q, r, vi, ratio)
            if all(c in s for c in co): out.append(poly(v, pts, "junc")); nj += 1
    return out, nq, nj
cells2 = [(q, r) for q in range(-2, 3) for r in range(-2, 3) if dist(q, r) <= 2]
v = View(46, 260, 230)
body, nq, nj = ownership_svg(v, cells2, 0.74)
for q in range(-3, 4):
    for r in range(-3, 4):
        if dist(q, r) == 3: body.insert(0, hexpoly(v, q, r, 0.74, "face missing"))
body.append(text(260, 460, f"19 cells → {nq} quads, {nj} junction tris", "lbl mono"))
figs["f6"] = fig("\n".join(body), 520, 480, "A radius 2 grid: every interior gap is filled exactly once",
  f"<code>gap_filler</code> on the 19 cells of a radius-2 grid returns <code>({nq}, {nj})</code>. Blue are the gap quads, amber the 3-hex junction triangles. Each is drawn once, by its owner. The dashed ring would be radius 3: those cells don't exist, so the outer cells' gaps toward them are simply skipped. This is the rim the real map has too.")

# ---- F7 one cell's owned stream
b = []
v = View(92, 300, 250)
R = 0.72
for e in range(6):
    dq, dr = EDGE[e]; b.append(hexpoly(v, dq, dr, R, "face ghost"))
for e in (1, 3, 5):
    dq, dr = EDGE[e]
    # quad on odd edge belongs to neighbour on its even edge (e+3)%6
    b.append(poly(v, quad_pts(dq, dr, (e+3) % 6, R), "quad ghost"))
for vi in range(2, 6):
    pass
c0 = center(0, 0)
for i in range(6):
    a = corner(0, 0, i, R); c = corner(0, 0, (i+1) % 6, R)
    b.append(poly(v, [c0, a, c], "face fan"))
    m = ((c0[0]+a[0]+c[0])/3, (c0[1]+a[1]+c[1])/3); sp = v.p(m); b.append(text(sp[0], sp[1]+4, str(i), "lbl mono"))
for k, e in enumerate((0, 2, 4)):
    qp_ = quad_pts(0, 0, e, R); b.append(poly(v, qp_, "quad")); b.append(line(v.p(qp_[0]), v.p(qp_[2]), "diag"))
    t1 = [qp_[0], qp_[1], qp_[2]]; t2 = [qp_[0], qp_[2], qp_[3]]
    for j, t in enumerate((t1, t2)):
        m = (sum(p[0] for p in t)/3, sum(p[1] for p in t)/3); sp = v.p(m); b.append(text(sp[0], sp[1]+4, str(6+2*k+j), "lbl mono"))
for k, vi in enumerate((0, 1)):
    pts, _ = junc_pts(0, 0, vi, R); b.append(poly(v, pts, "junc"))
    m = (sum(p[0] for p in pts)/3, sum(p[1] for p in pts)/3); sp = v.p(m)
    b.append(text(sp[0]+(28 if vi == 0 else 14), sp[1]+(4 if vi == 0 else -14), str(12+k), "lbl mono acc2"))
qp_ = quad_pts(0, 0, 0, R)
for nm, p, off in zip("abcd", qp_, [(-6, 16), (8, 16), (8, -6), (-6, -6)]):
    sp = v.p(p); b.append(text(sp[0]+off[0], sp[1]+off[1], nm, "lbl mono acc", "end" if off[0] < 0 else "start"))
figs["f7"] = fig("\n".join(b), 600, 500, "One cell owns six face triangles, three gap quads and two junction triangles",
  "For cell <code>(0,0)</code>, <code>all_tris(false)</code> appends 14 triangles, numbered here in append order. 0–5 are the face fan. 6–11 are the quads on e0, e2, e4, each split into <code>[a,b,c]</code> then <code>[a,c,d]</code>. 12 and 13 are the junctions at corners 0 and 1. The faint quads on e1, e3, e5 belong to the neighbours and get appended when those cells run. The other four junctions are owned by neighbours too.")

# ---- F8 chunk tiling
b = []
v = View(22, 330, 300)
counts = {}
for q, r, cq, cr in TILES: counts[(cq, cr)] = counts.get((cq, cr), 0) + 1
for q, r, cq, cr in TILES:
    col = (cq - cr) % 3; part = counts[(cq, cr)] < 19
    b.append(hexpoly(v, q, r, 0.93, f"tile t{col}{' part' if part else ''}"))
for (cq, cr), n in counts.items():
    hq, hr = 5*cq + 2*cr, -2*cq + 3*cr
    if dist(hq, hr) <= 7:
        sp = v.p(center(hq, hr)); b.append(text(sp[0], sp[1]+4, f"{cq},{cr}", "lbl mono tiny"))
outline = [corner(0, 0, i, 1) for i in range(6)]
figs["f8"] = fig("\n".join(b), 660, 600, "A radius 7 grid split into radius 2 chunks; outer chunks are partial",
  f"A radius-7 grid (169 cells) grouped by <code>hex.to_lower_res(2)</code>. That makes {len(counts)} chunks, each labelled with its chunk coordinate at its centre cell. A full chunk holds 19 cells. The paler ones are cut off by the grid's hexagonal rim, because the chunk hexagons don't line up with it. Three colours are enough to keep neighbouring chunks apart.")

# ---- resolution figures
def arrow(a, c, cls="edge acc"):
    return f'<line class="{cls}" x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{c[0]:.1f}" y2="{c[1]:.1f}" marker-end="url(#arr)"/>'

# F12: to_higher_res basis
b = []
v = View(22, 330, 300)
cells = [(q, r) for q in range(-8, 9) for r in range(-8, 9) if dist(q, r) <= 7]
for q, r in cells:
    cq, cr = to_lower_res(q, r, 2)
    b.append(hexpoly(v, q, r, 0.93, f"tile t{(cq-cr) % 3}"))
for (cq, cr), lab in [((1, 0), "(1,0) → (5,−2)"), ((0, 1), "(0,1) → (2,3)"), ((-1, 1), "(−1,1) → (−3,5)")]:
    hq, hr = to_higher_res(cq, cr, 2)
    a = v.p(center(0, 0)); c = v.p(center(hq, hr))
    b.append(arrow(a, c))
    b.append(f'<circle class="dot acc" cx="{c[0]:.1f}" cy="{c[1]:.1f}" r="4"/>')
    b.append(text(c[0], c[1]-12, lab, "lbl mono tiny"))
a = v.p(center(0, 0)); b.append(f'<circle class="dot" cx="{a[0]:.1f}" cy="{a[1]:.1f}" r="4"/>')
figs["f12"] = fig("\n".join(b), 660, 600, "to_higher_res maps chunk coordinates onto the centres of chunk hexagons",
  "<code>to_higher_res(chunk, 2)</code> for three neighbouring chunks of <code>(0,0)</code>. It is a linear map: chunk <code>(1,0)</code> lands on cell <code>(5,−2)</code> and chunk <code>(0,1)</code> on <code>(2,3)</code>, so every chunk centre is an integer mix of those two vectors. The coarse grid is the fine grid scaled by about √19 and rotated by about 23°, which is why chunk rows don't follow cell rows.")

# F13: to_local and wrap_in_range
b = []
v = View(34, 150, 200)
cells = [(q, r) for q in range(-6, 8) for r in range(-6, 6) if to_lower_res(q, r, 2) in [(0, 0), (1, 0)]]
for q, r in cells:
    cq, cr = to_lower_res(q, r, 2)
    b.append(hexpoly(v, q, r, 0.9, f"tile t{(cq-cr) % 3}"))
H = (4, 0); C = to_higher_res(1, 0, 2); L = (H[0]-C[0], H[1]-C[1])
b.append(hexpoly(v, H[0], H[1], 0.9, "quad"))
b.append(hexpoly(v, L[0], L[1], 0.9, "junc"))
pc = v.p(center(*C)); ph = v.p(center(*H)); p0 = v.p(center(0, 0)); pl = v.p(center(*L))
b.append(f'<circle class="dot" cx="{pc[0]:.1f}" cy="{pc[1]:.1f}" r="4"/><circle class="dot" cx="{p0[0]:.1f}" cy="{p0[1]:.1f}" r="4"/>')
b.append(arrow(pc, ph)); b.append(arrow(p0, pl, "edge"))
b.append(f'<line class="map dash" x1="{ph[0]:.1f}" y1="{ph[1]:.1f}" x2="{pl[0]:.1f}" y2="{pl[1]:.1f}"/>')
b.append(text(ph[0]+30, ph[1]-22, "h = (4,0)", "lbl mono", "start"))
b.append(text(pc[0]+12, pc[1]+16, "centre (5,−2)", "lbl mono tiny", "start"))
b.append(text(pl[0]-30, pl[1]-22, "(−1,2)", "lbl mono", "end"))
b.append(text(p0[0], p0[1]+18, "(0,0)", "lbl mono tiny"))
figs["f13"] = fig("\n".join(b), 560, 380, "to_local gives a cell's offset from its chunk centre; wrap_in_range is the same map",
  "Cell <code>h = (4,0)</code> (blue) is in chunk (1,0), whose centre is <code>(5,−2)</code>. <code>to_local(h, 2)</code> = <code>h − to_higher_res(to_lower_res(h, 2), 2)</code> = <code>(−1,2)</code>. That offset is the same for every chunk, so it can index a cell's slot in a fixed 19-cell layout. Read from the origin instead, the same offset is the amber cell. That is <code>wrap_in_range(2)</code>: it folds the whole plane onto one radius-2 hexagon, which gives a wraparound world.")

# ---- F10g: one layout with its outer ring entangled (guide)
b = []
v = View(36, 250, 243)
R = 0.74
own = [(q, r) for q in range(-2, 3) for r in range(-2, 3) if dist(q, r) <= 2]
ring = [(q, r) for q in range(-3, 4) for r in range(-3, 4) if dist(q, r) == 3]
for q, r in ring: b.append(hexpoly(v, q, r, R, "face entring"))
for q, r in own: b.append(hexpoly(v, q, r, R, "face"))
so = set(own); full = so | set(ring)
for q, r in own:
    for e in (0, 2, 4):
        dq, dr = EDGE[e]
        if (q+dq, r+dr) in full: b.append(poly(v, quad_pts(q, r, e, R), "quad"))
    for vi in (0, 1):
        pts, co = junc_pts(q, r, vi, R)
        if all(c in full for c in co): b.append(poly(v, pts, "junc"))
for q, r in ring:
    for e in (0, 2, 4):
        dq, dr = EDGE[e]
        if (q+dq, r+dr) in so: b.append(poly(v, quad_pts(q, r, e, R), "quad"))
    for vi in (0, 1):
        pts, co = junc_pts(q, r, vi, R)
        if all(c in full for c in co) and any(c in so for c in co): b.append(poly(v, pts, "junc"))
figs["f10g"] = fig("\n".join(b), 500, 490, "A radius 3 layout with its outer ring entangled: all_tris(false) closes the outline of the inner cells",
  "<code>HGridLayout::new</code> with <code>radius: 3</code> and every cell of ring 3 in <code>entangle</code>. <code>all_tris(false)</code> draws the 19 inner faces (solid) and every gap touching an inner cell, whichever cell owns it. It skips the entangled cells' faces (dashed) and the gaps between two entangled cells. Ownership doesn't matter for the outline: it is closed on all six sides. Counted on <code>main</code>: 312 triangles, the same as 19 faces plus every gap touching them.")

tmpl = args.template.read_text()
for k, svg in figs.items(): tmpl = tmpl.replace("{{" + k + "}}", svg)

# ---- logo: the owned-cell picture without labels
def logo_shapes(v, R=0.72, fixed=False):
    C = dict(face='fill="#c3cad3" stroke="#4a5360" stroke-width="1" stroke-opacity="0.55"',
             ghost='fill="none" stroke="#7d8794" stroke-width="1.2" stroke-opacity="0.7"',
             quad='fill="#3b63c9" fill-opacity="0.6" stroke="#3b63c9" stroke-width="1"',
             qghost='fill="none" stroke="#3b63c9" stroke-opacity="0.6" stroke-dasharray="2 2" stroke-width="1"',
             junc='fill="#d08a1e" fill-opacity="0.85" stroke="#d08a1e" stroke-width="1"',
             diag='stroke="#2a3038" stroke-width="1" stroke-dasharray="3 2" stroke-opacity="0.6"')
    def P(pts, kind):
        if fixed: return f'<polygon points="{v.pts(pts)}" {C[kind]}/>'
        cls = {"face": "face fan", "ghost": "face ghost", "quad": "quad", "qghost": "quad ghost", "junc": "junc"}[kind]
        return f'<polygon class="{cls}" points="{v.pts(pts)}"/>'
    def Ln(a, c):
        a, c = v.p(a), v.p(c)
        attrs = C["diag"] if fixed else 'class="diag"'
        return f'<line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{c[0]:.1f}" y2="{c[1]:.1f}" {attrs}/>'
    out = []
    for e in range(6):
        dq, dr = EDGE[e]; out.append(P([corner(dq, dr, i, R) for i in range(6)], "ghost"))
    for e in (1, 3, 5):
        dq, dr = EDGE[e]; out.append(P(quad_pts(dq, dr, (e+3) % 6, R), "qghost"))
    c0 = center(0, 0)
    for i in range(6): out.append(P([c0, corner(0, 0, i, R), corner(0, 0, (i+1) % 6, R)], "face"))
    for e in (0, 2, 4):
        q_ = quad_pts(0, 0, e, R); out.append(P(q_, "quad")); out.append(Ln(q_[0], q_[2]))
    for vi in (0, 1): out.append(P(junc_pts(0, 0, vi, R)[0], "junc"))
    return out
# extent: x ±(1.5+R), z ±(sqrt3 + R*sqrt3/2)
LS = 60; LW = 2*(1.5+0.72)*LS + 8; LH = 2*(SQ3+0.72*SQ3/2)*LS + 8
lv = View(LS, LW/2, LH/2)
logo_file = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {LW:.0f} {LH:.0f}" role="img" aria-label="apicult-desigual logo: one hex cell with the gaps it owns">\n'
             + "\n".join(logo_shapes(lv, fixed=True)) + "\n</svg>\n")
if args.logo: args.logo.write_text(logo_file)
logo_inline = (f'<svg class="logo" viewBox="0 0 {LW:.0f} {LH:.0f}" role="img" aria-label="apicult-desigual logo">'
               + "".join(logo_shapes(lv)) + '</svg>')
html = tmpl.replace("{{logo}}", logo_inline)
assert "{{" not in html, "unfilled template slot"
args.out.write_text(html)
print(f"wrote {args.out}" + (f" and {args.logo}" if args.logo else ""))
