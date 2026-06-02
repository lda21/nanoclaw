#!/usr/bin/env python3
"""Drop+recreate the 4 poisoned groups so group-init creates their container_config
through the HOST connection (not q.ts). Do NOT touch configs via SQL. Then rebuild
destinations + channel wirings. group-init makes the config on first spawn."""
import json, subprocess, re, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
def ncl(*a):
    r=subprocess.run(["ncl",*a,"--json"],capture_output=True,text=True)
    try: return json.loads(r.stdout)
    except: return {"ok":False,"raw":(r.stdout+r.stderr)[:200]}
NAMES={"keeper":"Keeper","intel":"Intel","herald":"Herald","quill":"Quill","seneschal":"Seneschal","elon":"Elon","scout":"Scout"}
POISONED=["intel","herald","seneschal","scout"]
PLAN={"general":list(NAMES),"product":["keeper","intel"],"marketing":["herald","quill"],
      "pa":["seneschal"],"strategy":["elon"],"research":["scout"]}
def pat(k): return f"@[{k[0].upper()}{k[0].lower()}]{re.escape(k[1:])}\\b"
def gmap(): return {g["folder"]:g["id"] for g in ncl("groups","list")["data"]}

cur=gmap()
for k in POISONED:
    if cur.get(k):
        ncl("groups","delete","--id",cur[k]); print(f"deleted poisoned {k} {cur[k]}")
    for _ in range(40):
        res=ncl("groups","create","--name",NAMES[k],"--folder",k)
        nid=res.get("data",{}).get("id")
        if not nid: print(f"  create {k} FAIL {res}"); break
        if nid[0].lower() in "abcdef":
            print(f"recreated {k} -> {nid} (letter-start)"); break
        ncl("groups","delete","--id",nid)

g=gmap()
# destinations: full reset with current ids
for a in NAMES:
    for b in NAMES:
        if a!=b: ncl("destinations","remove","--agent-group-id",g[a],"--local-name",b)
for a in NAMES:
    for b in NAMES:
        if a!=b: ncl("destinations","add","--agent-group-id",g[a],"--local-name",b,"--target-type","agent","--target-id",g[b])
print("destinations reset (42)")
# wirings: ensure (channels require @-pattern)
office=json.load(open(".discord-office.json")); guild=office["guild_id"]; chans=office["channels"]
mg={m["platform_id"]:m["id"] for m in ncl("messaging-groups","list")["data"]}
existing={(w["messaging_group_id"],w["agent_group_id"]) for w in ncl("wirings","list")["data"]}
for cname,agents in PLAN.items():
    pid=f"discord:{guild}:{chans[cname]}"; mgid=mg[pid]
    for k in agents:
        if (mgid,g[k]) in existing: continue
        ncl("wirings","create","--messaging-group-id",mgid,"--agent-group-id",g[k],
            "--engage-mode","pattern","--engage-pattern",pat(k),
            "--sender-scope","all","--ignored-message-policy","drop","--session-mode","shared")
        print(f"wired {k} <- #{cname}")
print("DONE. IDS:", json.dumps({k:g[k] for k in NAMES}))
