#!/usr/bin/env python3
"""PoC part 2 grading and part 1b cost tally for one case.

usage: grade.py <case dir> [--judge]

Reads <case>/full/result.json and <case>/compact/result.json (run_arm.mjs),
splits each arm's answers by question number, and with --judge sends every
(question, key, answer) item of both arms, shuffled under random ids, to one
blind judge call (Opus 5.5 via `claude -p`, CLAUDE_CONFIG_DIR=$POC_CLAUDE_CONFIG_DIR).
The judge never sees which arm wrote an answer. Writes <case>/grades.json and
prints per-question scores (2 correct, 1 partial, 0 wrong or "모름") and the
weekly-limit units of each arm (Fable 7.5, Opus 2.2; input + cache write x1.25
+ output x5 + cache read x0.025).
"""
import json, os, random, re, subprocess, sys

case = sys.argv[1]
judge = "--judge" in sys.argv
W = {"fable": 7.5, "opus": 2.2, "sonnet": 1.5, "haiku": 1.0}

def weight(model):
    for k, v in W.items():
        if k in (model or ""):
            return v
    return 0

def units(u, model):
    return weight(model) * (u.get("input", 0) + u.get("cacheWrite", 0) * 1.25 + u.get("output", 0) * 5 + u.get("cacheRead", 0) * 0.025)

prompts = json.load(open(os.path.join(case, "prompts.json")))
keys = json.load(open(os.path.join(case, "keys.json")))
questions = [re.sub(r"^\d+\.\s*", "", l) for l in prompts[0].split("\n") if re.match(r"^\d+\.\s", l)]
questions.append("이 세션에서 아직 끝나지 않은 일 (한 줄씩)")
assert len(questions) == len(keys), (len(questions), len(keys))

def arm_data(arm):
    r = json.load(open(os.path.join(case, arm, "result.json")))
    segs, cur = [], {"texts": [], "requests": [], "tools": []}
    compactions = []
    for e in r["events"]:
        if e["type"] == "compaction_end":
            compactions.append(e)
        if e["type"] == "message_end" and e.get("role") == "assistant":
            if e.get("text"):
                cur["texts"].append(e["text"])
            cur["tools"] += e.get("toolCalls") or []
            if e.get("usage"):
                cur["requests"].append((e.get("model"), e["usage"]))
        if e["type"] == "agent_end":
            segs.append(cur)
            cur = {"texts": [], "requests": [], "tools": []}
    return r, segs, compactions

def split_numbered(text, n):
    out = {}
    parts = re.split(r"(?m)^\s*(?:\*\*)?(\d{1,2})[.)](?:\*\*)?\s+", text)
    for i in range(1, len(parts) - 1, 2):
        k = int(parts[i])
        if 1 <= k <= n and k not in out:
            out[k] = parts[i + 1].strip()
    return out

arms = {}
for arm in ("full", "compact"):
    r, segs, comps = arm_data(arm)
    nq = len(questions) - 1
    ans = split_numbered("\n".join(segs[0]["texts"]) if segs else "", nq)
    answers = [ans.get(i + 1, "(no answer)") for i in range(nq)] + ["\n".join(segs[1]["texts"]) if len(segs) > 1 else "(no answer)"]
    cost = {"requests": [], "summary": None}
    for si, seg in enumerate(segs):
        for model, u in seg["requests"]:
            cost["requests"].append({"prompt": si, "model": model, **{k: u.get(k, 0) for k in ("input", "cacheRead", "cacheWrite", "output")}, "units": units(u, model)})
    for c in comps:
        if c.get("usage"):
            cost["summary"] = {"usage": c["usage"], "tokensBefore": c.get("tokensBefore"), "estimatedTokensAfter": c.get("estimatedTokensAfter"), "summaryChars": c.get("summaryChars")}
    arms[arm] = {"answers": answers, "cost": cost, "tools": [s["tools"] for s in segs], "prompts": r["prompts"], "error": r.get("error"), "compactions": comps}

grades = {}
if judge:
    items = []
    for arm in arms:
        for qi, q in enumerate(questions):
            items.append({"id": f"{random.randrange(16**6):06x}", "arm": arm, "qi": qi, "question": q, "key": keys[qi], "answer": arms[arm]["answers"][qi]})
    random.shuffle(items)
    rubric = (
        "You grade answers to questions about an earlier work conversation. For each item you get the question, the answer key "
        "(written from the original conversation), and one answer. Grade only factual agreement with the key:\n"
        "2 = every fact in the key that the question asks for is present and correct (extra correct detail is fine);\n"
        "1 = partly correct: some asked-for facts right, others missing or wrong;\n"
        "0 = wrong, contradicts the key, or says it does not know.\n"
        "For the open-items question, 2 = names most key items and adds nothing false, 1 = some, 0 = none or invented.\n"
        "Reply with JSON only: {\"<id>\": {\"score\": 0|1|2, \"why\": \"<short reason>\"}, ...}.\n\nITEMS:\n"
    )
    body = "\n\n".join(f"[{it['id']}]\nQUESTION: {it['question']}\nKEY: {it['key']}\nANSWER: {it['answer']}" for it in items)
    env = {**os.environ, "CLAUDE_CONFIG_DIR": os.environ["POC_CLAUDE_CONFIG_DIR"]}
    out = subprocess.run(["claude", "-p", "--model", "claude-opus-5-5", "--output-format", "text"], input=rubric + body, capture_output=True, text=True, env=env, timeout=900, cwd="/tmp")
    raw = out.stdout.strip()
    m = re.search(r"\{.*\}", raw, re.S)
    parsed = json.loads(m.group(0))
    for it in items:
        g = parsed.get(it["id"], {"score": None, "why": "missing"})
        grades.setdefault(it["arm"], {})[it["qi"]] = g
    json.dump({"items": items, "grades": grades, "raw": raw}, open(os.path.join(case, "grades.json"), "w"), ensure_ascii=False, indent=1)
elif os.path.exists(os.path.join(case, "grades.json")):
    saved = json.load(open(os.path.join(case, "grades.json")))
    grades = {arm: {int(k): v for k, v in g.items()} for arm, g in saved["grades"].items()}

for qi, q in enumerate(questions):
    row = [f"Q{qi+1:02d}"]
    for arm in ("full", "compact"):
        g = grades.get(arm, {}).get(qi)
        row.append(f"{arm}={g['score'] if g else '-'}")
    print(" ".join(row), "|", q[:70])
    for arm in ("full", "compact"):
        g = grades.get(arm, {}).get(qi)
        if g and g.get("score") != 2:
            print(f"     {arm}: {g.get('why','')[:160]} || answer: {arms[arm]['answers'][qi][:160]!r}")
for arm in ("full", "compact"):
    tot = sum((g or {}).get("score") or 0 for g in grades.get(arm, {}).values())
    c = arms[arm]["cost"]
    req_units = sum(x["units"] for x in c["requests"])
    s = c["summary"]
    sum_units = units(s["usage"], "opus") if s else 0
    print(f"\n{arm}: score {tot}/{2*len(questions)}  tools used {arms[arm]['tools']}  error {arms[arm]['error']}")
    for x in c["requests"]:
        print(f"   prompt{x['prompt']} {x['model']} in={x['input']} cr={x['cacheRead']} cw={x['cacheWrite']} out={x['output']} units={x['units']/1e6:.2f}M")
    if s:
        print(f"   summary usage {s['usage']} tokensBefore={s['tokensBefore']} after~{s['estimatedTokensAfter']} chars={s['summaryChars']} units(Opus)={sum_units/1e6:.2f}M")
    print(f"   total units {(req_units+sum_units)/1e6:.2f}M  prompt timings {[(p['n'], p['ms']) for p in arms[arm]['prompts']]}")
