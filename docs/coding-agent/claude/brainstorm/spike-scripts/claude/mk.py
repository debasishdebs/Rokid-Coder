import json, sys
B = '/private/tmp/claude-501/-Users-debasishkanhar/1fc7a898-3766-43a3-956c-0aefb8f170ab/scratchpad/claude-compat'
def make(name, stop_timeout=3600):
    cmd = f'/opt/anaconda3/bin/python3 {B}/bin/hook.py'
    h = lambda t=None: [{"hooks": [dict(type="command", command=cmd, **({"timeout": t} if t else {}))]}]
    evs = {"Stop": h(stop_timeout)}
    for e in ["PreToolUse","PostToolUse","PermissionRequest","Notification","UserPromptSubmit","PreCompact","PostCompact","PreModelSwitch","PostModelSwitch","SessionStart"]:
        evs[e] = h(120)
    s = {"hooks": evs, "statusLine": {"type": "command", "command": f"{B}/bin/sl.sh"}}
    p = f'{B}/{name}.json'; json.dump(s, open(p, 'w'), indent=1); return p
if __name__ == '__main__':
    print(make(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 3600))
