import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import MultipleLocator
import numpy as np

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["DejaVu Serif", "Times New Roman", "Liberation Serif"],
    "font.size": 11, "axes.titlesize": 12, "axes.titleweight": "bold",
    "axes.edgecolor": "#444444", "axes.linewidth": 0.8,
    "figure.dpi": 200, "savefig.dpi": 200, "savefig.bbox": "tight",
})
NAVY="#2F5496"; RED="#C00000"; TEAL="#2E8B7A"; GOLD="#C99A2E"; GREY="#8C8C8C"
OUT="/tmp/report/build/charts"

# ---------- Figure 4.1 : SWE-bench autonomous issue resolution ----------
fig, ax = plt.subplots(figsize=(6.6, 3.9))
labels = ["Best LLM (Claude 2)\nSWE-bench [16]",
          "SWE-agent + GPT-4\nSWE-bench [4]",
          "SWE-agent + GPT-4\nde-leaked (SWE-Bench+) [17]"]
vals = [1.96, 12.47, 3.97]
colors = [GREY, NAVY, RED]
bars = ax.bar(labels, vals, color=colors, width=0.6, edgecolor="black", linewidth=0.6)
for b, v in zip(bars, vals):
    ax.text(b.get_x()+b.get_width()/2, v+0.4, f"{v:.2f}%", ha="center", va="bottom", fontweight="bold")
ax.set_ylabel("Resolved real GitHub issues (%)")
ax.set_ylim(0, 16)
ax.set_title("Autonomous resolution of real-world software issues remains low")
ax.yaxis.set_major_locator(MultipleLocator(2))
ax.grid(axis="y", linestyle=":", color="#bbbbbb", linewidth=0.6, zorder=0)
ax.set_axisbelow(True)
fig.savefig(f"{OUT}/fig_4_1_swebench.png"); plt.close(fig)

# ---------- Figure 4.2 : Intrinsic self-correction degrades accuracy ----------
fig, ax = plt.subplots(figsize=(7.0, 4.0))
groups = ["GPT-3.5\nGSM8K", "GPT-3.5\nCommonSenseQA", "GPT-4\nGSM8K"]
standard = [75.9, 75.8, 95.5]
r1       = [75.1, 38.1, 91.5]
r2       = [74.7, 41.8, 89.0]
x = np.arange(len(groups)); w = 0.26
b1=ax.bar(x-w, standard, w, label="Standard prompting", color=NAVY, edgecolor="black", linewidth=0.5)
b2=ax.bar(x,    r1,       w, label="Self-correct (round 1)", color=GOLD, edgecolor="black", linewidth=0.5)
b3=ax.bar(x+w,  r2,       w, label="Self-correct (round 2)", color=RED,  edgecolor="black", linewidth=0.5)
for bars in (b1,b2,b3):
    for b in bars:
        ax.text(b.get_x()+b.get_width()/2, b.get_height()+0.8, f"{b.get_height():.1f}",
                ha="center", va="bottom", fontsize=8.5)
ax.set_xticks(x); ax.set_xticklabels(groups)
ax.set_ylabel("Reasoning accuracy (%)"); ax.set_ylim(0, 122)
ax.set_title("Intrinsic self-correction does not improve — and can degrade — accuracy")
ax.legend(fontsize=8.5, framealpha=0.95, loc="upper center", ncol=3, columnspacing=1.2, handletextpad=0.5)
ax.grid(axis="y", linestyle=":", color="#bbbbbb", linewidth=0.6); ax.set_axisbelow(True)
fig.savefig(f"{OUT}/fig_4_2_selfcorrect.png"); plt.close(fig)

# ---------- Figure 8.3 : Automated test execution ----------
fig, ax = plt.subplots(figsize=(6.6, 3.6))
comps=["Backend","Frontend","Total"]
passed=[1285,415,1700]
bars=ax.barh(comps, passed, color=[NAVY,TEAL,"#1F3864"], edgecolor="black", linewidth=0.6, height=0.55)
for b,v in zip(bars,passed):
    ax.text(v+15, b.get_y()+b.get_height()/2, f"{v:,}", va="center", ha="left", fontweight="bold")
ax.set_xlabel("Passed automated tests"); ax.set_xlim(0,1950)
ax.invert_yaxis()
ax.set_title("Automated test execution — 100% pass rate")
ax.text(0.99,0.04,"0 failed   ·   5 skipped (env-specific)   ·   100% executed pass rate",
        transform=ax.transAxes, ha="right", va="bottom", fontsize=9, style="italic", color="#333333")
ax.grid(axis="x", linestyle=":", color="#bbbbbb", linewidth=0.6); ax.set_axisbelow(True)
fig.savefig(f"{OUT}/fig_8_3_tests.png"); plt.close(fig)

# ---------- Figure 8.4 : Frontend coverage ----------
fig, ax = plt.subplots(figsize=(6.6, 3.7))
metrics=["Statements","Lines","Branches","Functions"]
cov=[89.95,89.95,86.94,80.51]
bars=ax.bar(metrics, cov, color=[NAVY,NAVY,TEAL,GOLD], edgecolor="black", linewidth=0.6, width=0.6)
for b,v in zip(bars,cov):
    ax.text(b.get_x()+b.get_width()/2, v+0.6, f"{v:.2f}%", ha="center", va="bottom", fontweight="bold", fontsize=9.5)
ax.axhline(80, color=RED, linestyle="--", linewidth=1.1)
ax.text(0.015, 0.74, "80% threshold", transform=ax.transAxes, color=RED, fontsize=8.5, ha="left", va="bottom")
ax.set_ylabel("Coverage (%)"); ax.set_ylim(0,100)
ax.set_title("Frontend code coverage (Vitest, v8 provider)")
ax.grid(axis="y", linestyle=":", color="#bbbbbb", linewidth=0.6); ax.set_axisbelow(True)
fig.savefig(f"{OUT}/fig_8_4_coverage.png"); plt.close(fig)

# ---------- Figure 9.1 : Objectives achievement ----------
fig, ax = plt.subplots(figsize=(5.0, 4.0))
ax.pie([10,0.0001], colors=[TEAL,"#E6E6E6"], startangle=90, counterclock=False,
       wedgeprops=dict(width=0.42, edgecolor="white", linewidth=2))
ax.text(0,0.12,"10 / 10", ha="center", va="center", fontsize=22, fontweight="bold", color="#1F3864")
ax.text(0,-0.20,"objectives\nimplemented", ha="center", va="center", fontsize=10.5, color="#333333")
ax.set_title("Project objectives achieved (100%)")
fig.savefig(f"{OUT}/fig_9_1_objectives.png"); plt.close(fig)

print("charts written:")
import os
for f in sorted(os.listdir(OUT)): print("  ", f, os.path.getsize(f"{OUT}/{f}"), "bytes")
