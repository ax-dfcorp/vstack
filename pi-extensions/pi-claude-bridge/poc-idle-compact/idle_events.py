#!/usr/bin/env python3
"""PoC part 1a: idle-return events in real Claude transcripts, paid vs. compact-first.

Reads ~/.claude-profiles/*/projects/*/*.jsonl (top-level sessions only; read-only),
finds requests that come >= 60 minutes after the previous request of the same
session and model with the cache gone (cache read < half the previous context),
and prices what was paid against what compacting first would have cost:

  paid  = the return request + every later request of that session until the
          next idle return, compaction or rebuild (context drop), model change,
          or the end of the transcript.
  new   = one summary request (written by Opus for Fable sessions, by the model
          itself for Opus) + the return request on the compacted context S +
          the same later requests with their context shrunk by C - S.

Weekly-limit units = weight x (input + cache write x1.25 + output x5 + cache read x0.025),
weights Fable 7.5, Opus 2.2. Summary input share, summary output, and S come
from real compactions in Pi session files (pi-compactions.json, measured).
"""
import json, glob, os, sys, statistics as st, collections
from datetime import datetime

W = {"fable": 7.5, "opus": 2.2}
SINCE = sys.argv[1] if len(sys.argv) > 1 else "2026-11-12"
UNTIL = sys.argv[2] if len(sys.argv) > 2 else "2026-11-20"
HERE = os.path.dirname(os.path.abspath(__file__))

comp = json.load(open(os.path.join(HERE, "pi-compactions.json")))
def med(xs): return st.median(xs) if xs else None
def summary_params(fam):
    rows = [r for r in comp if fam in (r["model"] or "") and r["C"] > 100_000 and (r["ui"] + r["ucw"]) > 0]
    share = med([(r["ui"] + r["ucw"] + r["ucr"]) / r["C"] for r in rows])
    out = med([r["uo"] for r in rows])
    S = med([r["S"] for r in rows if r["S"] and r["C"] > 200_000])
    return share, out, S
PARAMS = {f: summary_params(f) for f in ("fable", "opus")}

def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()

def fam_of(model):
    return "fable" if "fable" in model else "opus" if "opus" in model else None

def units(fam, i, cr, cw, o):
    return W[fam] * (i + cw * 1.25 + o * 5 + cr * 0.025)

def load(f):
    reqs, order = {}, []
    first_user = None
    for line in open(f, errors="ignore"):
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("isSidechain"):
            continue
        if first_user is None and d.get("type") == "user":
            c = d.get("message", {}).get("content")
            first_user = c if isinstance(c, str) else " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text") if isinstance(c, list) else ""
        if d.get("type") != "assistant":
            continue
        m = d.get("message", {})
        u = m.get("usage")
        if not u or not m.get("id"):
            continue
        mid = m["id"]
        if mid not in reqs:
            order.append(mid)
        prev = reqs.get(mid)
        out = max(u.get("output_tokens", 0), prev[4] if prev else 0)
        reqs[mid] = (m.get("model", ""), u.get("input_tokens", 0), u.get("cache_read_input_tokens", 0), u.get("cache_creation_input_tokens", 0), out, d.get("timestamp", ""))
    rows = []
    for mid in order:
        model, i, cr, cw, o, t = reqs[mid]
        try:
            tt = ts(t)
        except Exception:
            continue
        rows.append(dict(model=model, fam=fam_of(model), i=i, cr=cr, cw=cw, o=o, t=tt, ts=t, ctx=i + cr + cw))
    return rows, (first_user or "")

def role_of(first_user):
    head = first_user.lstrip()
    if head.startswith("#nomem"):
        head = head[len("#nomem"):].lstrip()
    if head.startswith(("Implement", 'Run "Lane', "You are the implementer")) and ".pi/agent/plans/" in head:
        return "implementer"
    if "research worker" in head[:200]:
        return "worker"
    return "lead"

events = []
for f in glob.glob(os.path.expanduser("~/.claude-profiles/*/projects/*/*.jsonl")):
    if os.path.getmtime(f) < ts(SINCE + "T00:00:00Z"):
        continue
    rows, first_user = load(f)
    role = role_of(first_user)
    starts = []
    for k in range(1, len(rows)):
        a, b = rows[k - 1], rows[k]
        if not b["fam"] or b["model"] != a["model"]:
            continue
        if not (SINCE <= b["ts"][:10] < UNTIL):
            continue
        gap = (b["t"] - a["t"]) / 60
        if gap < 60 or a["ctx"] < 100_000:
            continue
        if b["cr"] >= 0.5 * a["ctx"]:
            continue  # cache survived (keep-warm or a request not in this transcript)
        if b["ctx"] < 0.6 * a["ctx"]:
            continue  # compacted/rebuilt before the return
        starts.append(k)
    for n, k in enumerate(starts):
        a = rows[k - 1]
        fam = rows[k]["fam"]
        C = a["ctx"] + a["o"]
        end = len(rows)
        for j in range(k + 1, len(rows)):
            if (n + 1 < len(starts) and j >= starts[n + 1]) or rows[j]["model"] != rows[k]["model"] or rows[j]["ctx"] < 0.6 * rows[j - 1]["ctx"]:
                end = j
                break
        window = rows[k:end]
        paid = sum(units(r["fam"], r["i"], r["cr"], r["cw"], r["o"]) for r in window)
        share, sout, S = PARAMS[fam]
        sum_fam = "opus"  # Fable summaries go to Opus (summaryModelOverrides); Opus summarizes itself
        summary = units(sum_fam, 0, 0, share * C, sout)
        delta = max(0, C - S)
        new = summary
        for idx, r in enumerate(window):
            if idx == 0:
                prefix = min(r["cr"], S)  # shared prefix still cached (tools/system), if any
                new_ctx = max(S, r["ctx"] - delta)
                new += units(fam, r["i"], prefix, new_ctx - prefix - r["i"], r["o"])
            else:
                new += units(fam, r["i"], max(0, r["cr"] - delta), r["cw"], r["o"])
        events.append(dict(file=f, role=role, model=rows[k]["model"], fam=fam, at=rows[k]["ts"], gapMin=round((rows[k]["t"] - a["t"]) / 60), C=C, followUps=len(window) - 1, paid=paid, new=new, summary=summary, saving=paid - new))

json.dump(events, open(os.path.join(HERE, "idle-events.json"), "w"), indent=1)
print(f"params (summary input share, summary output, S after): {PARAMS}")
for fam in ("fable", "opus"):
    for role in ("lead", "implementer", "worker"):
        ev = [e for e in events if e["fam"] == fam and e["role"] == role]
        if not ev:
            continue
        print(f"\n{fam} {role}: {len(ev)} events, paid {sum(e['paid'] for e in ev)/1e6:.1f}M, new {sum(e['new'] for e in ev)/1e6:.1f}M, saving {sum(e['saving'] for e in ev)/1e6:.1f}M")
        for lo, hi in ((100e3, 150e3), (150e3, 200e3), (200e3, 250e3), (250e3, 300e3), (300e3, 400e3), (400e3, 600e3), (600e3, 2e6)):
            b = [e for e in ev if lo <= e["C"] < hi]
            if b:
                print(f"  C {lo/1e3:.0f}-{hi/1e3:.0f}k: n={len(b):3d} saving {sum(e['saving'] for e in b)/1e6:7.2f}M  losers {sum(1 for e in b if e['saving']<0)}  median follow-ups {med([e['followUps'] for e in b])}")
        for thr in (150e3, 200e3, 250e3, 300e3, 350e3, 400e3):
            b = [e for e in ev if e["C"] >= thr]
            print(f"  threshold {thr/1e3:.0f}k: triggers {len(b)}, net saving {sum(e['saving'] for e in b)/1e6:.2f}M, losers {sum(1 for e in b if e['saving']<0)}")
