#!/usr/bin/env python3
"""Fix: OneCLI rejects agent identifiers that don't start with a letter.
ncl auto-generates UUIDs; some start with digits. Delete+recreate those groups
until the UUID starts with a-f, then rebuild names, destinations, and wirings."""
import json, subprocess, re, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def ncl(*a):
    r=subprocess.run(["ncl",*a,"--json"],capture_output=True,text=True)
    try: return json.loads(r.stdout)
    except: return {"ok":False,"raw":(r.stdout+r.stderr)[:200]}

NAMES={"keeper":"Keeper","intel":"Intel","herald":"Herald","quill":"Quill","seneschal":"Seneschal","elon":"Elon","scout":"Scout"}
PLAN={"general":list(NAMES),"product":["keeper","intel"],"marketing":["herald","quill"],
      "pa":["seneschal"],"strategy":["elon"],"research":["scout"]}
def name_pattern(k): return f"@[{k[0].upper()}{k[0].lower()}]{re.escape(k[1:])}\\b"
def gmap(): return {g["folder"]:g["id"] for g in ncl("groups","list")["data"]}

# 0. clean stray probe groups
for g in ncl("groups","list")["data"]:
    if g["folder"] in ("_probe_del","_ping-test"):
        ncl("groups","delete","--id",g["id"]); print("deleted stray",g["folder"])

# 1. recreate digit-starting groups with a letter-start id
cur=gmap()
for k in NAMES:
    gid=cur.get(k)
    if gid and gid[0].lower() in "abcdef":
        print(f"keep {k} {gid} (letter-start ok)"); continue
    if gid:
        ncl("groups","delete","--id",gid); print(f"delete {k} {gid} (digit-start)")
    for attempt in range(30):
        res=ncl("groups","create","--name",NAMES[k],"--folder",k)
        nid=res.get("data",{}).get("id")
        if not nid: print(f"  create {k} FAILED {res}"); break
        if nid[0].lower() in "abcdef":
            print(f"recreated {k} -> {nid} (try {attempt+1})"); break
        ncl("groups","delete","--id",nid)

g=gmap()
# 2. assistant_name
for k,name in NAMES.items():
    ncl("groups","config","update","--id",g[k],"--assistant-name",name)
print("assistant_names set")

# 3. destinations: clean reset (remove all, add all 42)
for a in NAMES:
    for b in NAMES:
        if a!=b: ncl("destinations","remove","--agent-group-id",g[a],"--local-name",b)
for a in NAMES:
    for b in NAMES:
        if a!=b: ncl("destinations","add","--agent-group-id",g[a],"--local-name",b,"--target-type","agent","--target-id",g[b])
print("destinations reset (42 pairs)")

# 4. wirings: ensure each agent is wired to its channels (pattern, require @)
office=json.load(open(".discord-office.json")); guild=office["guild_id"]; chans=office["channels"]
mg={m["platform_id"]:m["id"] for m in ncl("messaging-groups","list")["data"]}
existing={(w["messaging_group_id"],w["agent_group_id"]) for w in ncl("wirings","list")["data"]}
for cname,agents in PLAN.items():
    pid=f"discord:{guild}:{chans[cname]}"; mgid=mg.get(pid)
    if not mgid:
        r=ncl("messaging-groups","create","--channel-type","discord","--platform-id",pid,"--name",f"#{cname}","--is-group","1","--unknown-sender-policy","public")
        mgid=r["data"]["id"]
    for k in agents:
        if (mgid,g[k]) in existing: continue
        ncl("wirings","create","--messaging-group-id",mgid,"--agent-group-id",g[k],
            "--engage-mode","pattern","--engage-pattern",name_pattern(k),
            "--sender-scope","all","--ignored-message-policy","drop","--session-mode","shared")
        print(f"wired {k} <- #{cname}")
print("WIRINGS ENSURED")
print("FINAL IDS:", json.dumps({k:g[k] for k in NAMES}, indent=1))
