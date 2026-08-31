"""Render the submission's one-page vector architecture (not an app dependency).

Requires reportlab and pypdfium2. Run from any directory with Python 3.
"""
from pathlib import Path
import math

from reportlab.graphics.shapes import Drawing, Rect, Line, String, PolyLine, Polygon
from reportlab.graphics import renderPDF, renderSVG
from reportlab.lib.colors import HexColor
from reportlab.pdfbase.pdfmetrics import stringWidth
import pypdfium2 as pdfium

ROOT = Path(__file__).resolve().parents[1]
PDF = ROOT / "output/pdf/agentlens-architecture.pdf"
SVG = ROOT / "docs/assets/agentlens-architecture.svg"
PNG = ROOT / "docs/assets/agentlens-architecture.png"
for target in (PDF, SVG, PNG):
    target.parent.mkdir(parents=True, exist_ok=True)

W, H = 842, 595
d = Drawing(W, H)
INK = HexColor("#202921")
MUTED = HexColor("#556058")
LINE = HexColor("#c4ccc4")
GREEN = HexColor("#356a50")
CREAM = HexColor("#fbfaf7")
PALE = HexColor("#edf3ed")
RUNTIME = HexColor("#f5f0e7")
WHITE = HexColor("#ffffff")


def rect(x, y, w, h, fill, stroke=LINE, radius=6):
    d.add(Rect(x, y, w, h, rx=radius, ry=radius,
               fillColor=fill, strokeColor=stroke, strokeWidth=0.75))


def text(x, y, value, size=9, bold=False, color=INK, anchor="start"):
    font = "Helvetica-Bold" if bold else "Helvetica"
    # Hard fail on horizontal overflow rather than silently clipping a label.
    width = stringWidth(value, font, size)
    left = x if anchor == "start" else x - width if anchor == "end" else x - width / 2
    assert left >= 20 and left + width <= W - 20, value
    d.add(String(x, y, value, fontName=font, fontSize=size,
                 fillColor=color, textAnchor=anchor))


def lines(x, y, values, size=8.5, leading=12, color=MUTED):
    for i, value in enumerate(values):
        text(x, y - i * leading, value, size=size, color=color)


def arrow(points, color=GREEN, dashed=False):
    flat = [coordinate for point in points for coordinate in point]
    d.add(PolyLine(flat, strokeColor=color, strokeWidth=1.15,
                   strokeDashArray=[3, 2] if dashed else None, fillColor=None))
    x, y = points[-1]
    px, py = points[-2]
    angle = math.atan2(y - py, x - px)
    length, half_width = 5, 2.2
    bx, by = x - length * math.cos(angle), y - length * math.sin(angle)
    d.add(Polygon([x, y, bx + half_width * math.sin(angle), by - half_width * math.cos(angle),
                   bx - half_width * math.sin(angle), by + half_width * math.cos(angle)],
                  fillColor=color, strokeColor=None))


rect(0, 0, W, H, CREAM, stroke=None, radius=0)
text(36, 555, "AgentLens", size=26, bold=True)
text(807, 558, "TIKTOK TECHJAM 2026 / AGENT LAUNCHPAD", size=8.5, color=GREEN, anchor="end")
text(36, 534, "From agent execution to inspectable evidence", size=13, color=MUTED)
text(36, 512, "Middleware focus: trace, audit and observability. Existing platform and runtime retained.", size=9, color=MUTED)

# Trust/ownership groupings. The runtime grouping is logical; profiles below
# explicitly state whether it is also a separate container boundary.
rect(36, 215, 150, 278, WHITE)
text(48, 477, "BROWSER", size=10, bold=True)
text(48, 463, "Untrusted client", size=8, color=MUTED)
rect(48, 398, 126, 49, CREAM)
text(60, 429, "Operator + Playground", size=9, bold=True)
lines(60, 414, ["Create / send / stop / start"], size=8)
rect(48, 280, 126, 93, CREAM)
text(60, 355, "Evidence UI", size=10, bold=True)
lines(60, 339, ["Live trace + timeline", "Run filters + comparison", "Usage / estimated cost", "Export audit JSON"], size=8.5, leading=13)
lines(48, 253, ["No provider key in UI config.", "Shared access token when", "configured; not user identity."], size=7.6, leading=11)

rect(226, 215, 330, 278, PALE, stroke=HexColor("#9bb6a1"))
text(240, 477, "CONTROL PLANE", size=10, bold=True, color=GREEN)
text(240, 463, "Fastify / trusted owner of Run state and trace", size=8, color=MUTED)
rect(240, 415, 302, 36, WHITE)
text(252, 436, "1  API boundary", size=10, bold=True)
text(252, 423, "Validation + shared-token gate when configured", size=8)
rect(240, 336, 302, 59, WHITE)
text(252, 377, "2  AgentService + runner adapter", size=10, bold=True)
lines(252, 361, ["Persist root first; queue live writes; finalize Run + trace.", "Observed command policy records allow/deny and requests cancellation."], size=7.8, leading=12)
rect(240, 245, 145, 70, WHITE)
text(252, 297, "4  Trace pipeline", size=10, bold=True)
lines(252, 280, ["Pair events + attach identity", "Redact payloads + cap history", "Close unfinished steps"], size=8, leading=12)
rect(397, 245, 145, 70, WHITE)
text(409, 297, "Persist + summarize", size=9.5, bold=True)
lines(409, 280, ["JSON store / audit.ts", "Redacted trace records", "Raw chat records also present*"], size=7.8, leading=12)
text(240, 229, "5  Authenticated trace/audit routes; export re-applies redaction", size=8)

rect(588, 329, 218, 164, RUNTIME)
text(602, 477, "AGENT RUNTIME", size=10, bold=True)
text(602, 463, "Model-authored execution; treat as untrusted", size=7.8, color=MUTED)
rect(602, 390, 190, 57, WHITE)
text(614, 428, "3  Codex CLI", size=11, bold=True)
lines(614, 411, ["Model calls, commands and file edits", "Observed JSON events on stdout"], size=8, leading=12)
rect(602, 341, 190, 33, WHITE)
text(614, 361, "Workspace + persistent session", size=8.6, bold=True)
text(614, 349, "Mount / process access depends on profile", size=7.5, color=MUTED)

rect(588, 215, 218, 76, WHITE)
text(602, 271, "EXTERNAL MODEL SERVICE", size=9, bold=True)
lines(602, 253, ["Ark Responses-compatible endpoint", "Operator-supplied model / endpoint", "Provider key supplied via runtime environment"], size=7.8, leading=12)

# Requests and event/data flow. Orthogonal connectors avoid crossing labels.
arrow([(174, 432), (240, 432)])
text(205, 444, "request", size=7, anchor="middle")
arrow([(391, 415), (391, 395)])
arrow([(542, 379), (571, 379), (571, 433), (602, 433)])
text(573, 441, "run", size=7, anchor="middle")
arrow([(602, 399), (579, 399), (579, 349), (542, 349)], dashed=True)
text(577, 335, "events", size=7, anchor="middle")
arrow([(312, 336), (312, 315)])
arrow([(385, 273), (397, 273)])
arrow([(470, 245), (470, 239)])
arrow([(226, 234), (203, 234), (203, 306), (174, 306)])
text(206, 320, "read", size=7, anchor="middle")
arrow([(697, 390), (697, 374)])
arrow([(792, 390), (815, 390), (815, 306), (697, 306), (697, 291)])
text(721, 313, "Responses API", size=8)

# Explicitly disclose the physical deployment alternatives.
d.add(Line(36, 195, 806, 195, strokeColor=LINE, strokeWidth=0.75))
text(36, 177, "RUNTIME PROFILES / DO NOT CONFUSE LOGICAL AND PHYSICAL BOUNDARIES", size=8.5, bold=True, color=GREEN)
text(36, 154, "Local POC - independent Runtime", size=10, bold=True)
lines(36, 138, ["Host API launches one disposable container per turn. Workspace bind mount,",
                "configured UID, dropped capabilities, and CPU / memory / PID limits.",
                "Landlock is probed; any fallback is inside that container, not on the host."], size=8.1, leading=12)
text(432, 154, "Windows Compose - shared application container", size=10, bold=True)
lines(432, 138, ["API and Codex processes share one container; runtime=local-process.",
                 "No independent per-Agent container boundary. Shared state and credentials",
                 "must not be treated as protected from a hostile Agent in this profile."], size=8.1, leading=12)

d.add(Line(36, 87, 806, 87, strokeColor=LINE, strokeWidth=0.75))
text(36, 72, "Recovery", size=8.5, bold=True)
text(84, 72, "Restart reconciles active Runs; terminal steps close; legacy identity backfills record provenance.", size=8)
text(36, 57, "* Redaction applies to trace/audit payloads, not every stored chat or workspace file. Unknown secrets can escape detection.", size=7.8, color=MUTED)
text(36, 43, "Single-user POC. Policy is observational, not pre-execution approval. Health and auth-discovery routes remain public.", size=7.8, color=MUTED)
text(36, 27, "Source: gaoze24/agentlens + reviewed audit fixes (4aa5e7b). Baseline: RrankPyramid/CodeJam.", size=7, color=MUTED)
text(806, 27, "31 AUG 2026  /  1 PAGE", size=7, color=MUTED, anchor="end")

renderPDF.drawToFile(d, str(PDF), title="AgentLens - one-page architecture", author="AgentLens team")
renderSVG.drawToFile(d, str(SVG))
document = pdfium.PdfDocument(str(PDF))
assert len(document) == 1
document[0].render(scale=2.5).to_pil().save(PNG)
print("Rendered one-page PDF, editable SVG, and PNG preview.")
