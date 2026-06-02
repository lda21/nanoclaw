#!/usr/bin/env python3
"""Wire the 7-agent office to Discord: messaging-groups (channels) + wirings + inter-agent destinations.
Idempotent — safe to re-run. Reads .discord-office.json (written by the bot-join watcher)."""
import json, subprocess, sys, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

def ncl(*args):
    r = subprocess.run(["ncl", *args, "--json"], capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"ok": False, "raw": r.stdout + r.stderr}

office = json.load(open(".discord-office.json"))
guild = office["guild_id"]; chans = office["channels"]

# folder -> agent_group_id
groups = {g["folder"]: g["id"] for g in ncl("groups", "list")["data"]}

# channel -> agents wired to it
PLAN = {
    "general":   ["keeper","intel","herald","quill","seneschal","elon","scout"],
    "product":   ["keeper","intel"],
    "marketing": ["herald","quill"],
    "pa":        ["seneschal"],
    "strategy":  ["elon"],
    "research":  ["scout"],
}
def name_pattern(key):  # @keeper / keeper / Keeper  (RegExp has no 'i' flag here)
    return f"@?[{key[0].upper()}{key[0].lower()}]{re.escape(key[1:])}\\b"

# existing messaging-groups by platform_id
existing_mg = {m["platform_id"]: m["id"] for m in ncl("messaging-groups","list")["data"]}
# existing wirings by (mg_id, ag_id)
existing_wire = {(w["messaging_group_id"], w["agent_group_id"]) for w in ncl("wirings","list")["data"]}

chan_mg = {}
for cname, agents in PLAN.items():
    cid = chans[cname]
    pid = f"discord:{guild}:{cid}"
    if pid in existing_mg:
        mg = existing_mg[pid]; print(f"#{cname}: messaging-group exists {mg}")
    else:
        res = ncl("messaging-groups","create","--channel-type","discord","--platform-id",pid,
                  "--name",f"#{cname}","--is-group","1","--unknown-sender-policy","public")
        if not res.get("ok"): print(f"#{cname}: CREATE FAILED", res); sys.exit(1)
        mg = res["data"]["id"]; print(f"#{cname}: created messaging-group {mg}")
    chan_mg[cname] = mg
    for key in agents:
        ag = groups.get(key)
        if not ag: print(f"  ! no group for {key}"); continue
        if (mg, ag) in existing_wire:
            print(f"  ~ wiring exists {key} <- #{cname}"); continue
        w = ncl("wirings","create","--messaging-group-id",mg,"--agent-group-id",ag,
                "--engage-mode","pattern","--engage-pattern",name_pattern(key),
                "--sender-scope","all","--ignored-message-policy","drop","--session-mode","shared")
        print(f"  + wired {key} <- #{cname}: {'ok' if w.get('ok') else w}")

# inter-agent destinations: every agent may address every other by lowercase name
KEYS = ["keeper","intel","herald","quill","seneschal","elon","scout"]
print("destinations (agent->agent):")
for a in KEYS:
    aid = groups.get(a)
    if not aid: continue
    for b in KEYS:
        if a==b: continue
        bid = groups.get(b)
        res = ncl("destinations","add","--agent-group-id",aid,"--local-name",b,
                  "--target-type","agent","--target-id",bid)
        ok = res.get("ok")
        if not ok and "uniqu" not in json.dumps(res).lower() and "exist" not in json.dumps(res).lower():
            print(f"  ! {a}->{b}: {res}")
print(f"  done ({len(KEYS)*(len(KEYS)-1)} pairs)")
print("WIRING COMPLETE")
print(json.dumps({"channels":chan_mg}, indent=1))
