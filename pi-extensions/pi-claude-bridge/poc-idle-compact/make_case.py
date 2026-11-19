#!/usr/bin/env python3
"""Cut a real Pi session at its idle-return point into a disposable copy.

usage: make_case.py <pi session file> <return time ISO> <out dir>

Keeps the session header and the branch that was active just before the first
user message at or after <return time> (parentId chain from the last entry
before it). `claude-bridge-session` entries are renamed so the bridge cannot
--resume the live Claude transcript they point at; it rebuilds from Pi history
instead (a new transcript in the PoC profile). The source file is only read.
Also writes digest.txt (user and assistant text, tool calls) for writing questions.
"""
import json, os, sys

src, ret, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
lines = [json.loads(l) for l in open(src, errors="ignore") if l.strip()]
header = lines[0]
assert header.get("type") == "session"
entries = lines[1:]
by_id = {e["id"]: e for e in entries if "id" in e}
cut = None
for idx, e in enumerate(entries):
    m = e.get("message") or {}
    if e.get("type") == "message" and m.get("role") == "user" and e.get("timestamp", "") >= ret:
        cut = idx
        break
assert cut is not None, "no user message at or after the return time"
leaf = entries[cut - 1]
chain = []
node = leaf
while node is not None:
    chain.append(node)
    node = by_id.get(node.get("parentId"))
chain.reverse()
renamed = 0
for e in chain:
    if e.get("type") == "custom" and e.get("customType") == "claude-bridge-session":
        e["customType"] = "poc-disabled-claude-bridge-session"
        renamed += 1
with open(os.path.join(out, "session.jsonl"), "w") as f:
    f.write(json.dumps(header) + "\n")
    for e in chain:
        f.write(json.dumps(e, ensure_ascii=False) + "\n")

def text_of(content):
    if isinstance(content, str):
        return content
    parts = []
    for b in content or []:
        if b.get("type") == "text":
            parts.append(b.get("text", ""))
        elif b.get("type") == "toolCall":
            args = b.get("arguments") or {}
            short = {k: (v[:160] if isinstance(v, str) else v) for k, v in args.items()}
            parts.append(f"<tool {b.get('name')} {json.dumps(short, ensure_ascii=False)[:300]}>")
    return "\n".join(parts)

last_usage = None
with open(os.path.join(out, "digest.txt"), "w") as f:
    for n, e in enumerate(chain):
        m = e.get("message") or {}
        if e.get("type") == "compaction":
            f.write(f"\n#{n} [{e.get('timestamp','')[:16]}] COMPACTION SUMMARY:\n{e.get('summary','')[:6000]}\n")
        if e.get("type") != "message":
            continue
        role = m.get("role")
        if role == "assistant" and m.get("usage"):
            u = m["usage"]
            last_usage = (u.get("input", 0) + u.get("cacheRead", 0) + u.get("cacheWrite", 0) + u.get("output", 0), m.get("model"))
        if role not in ("user", "assistant"):
            continue
        t = text_of(m.get("content")).strip()
        if not t:
            continue
        limit = 2500 if role == "user" else 1800
        f.write(f"\n#{n} [{e.get('timestamp','')[:16]}] {role.upper()}: {t[:limit]}\n")
print(json.dumps({"entries": len(chain), "renamedBridgeEntries": renamed, "lastContext": last_usage, "leafTime": leaf.get("timestamp"), "cwd": header.get("cwd")}))
