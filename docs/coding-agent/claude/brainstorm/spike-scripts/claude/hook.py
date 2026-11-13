#!/opt/anaconda3/bin/python3
import sys, json, os, time, signal
B = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
C = B + '/ctl/'; L = B + '/logs/events.jsonl'
def log(**k):
    k['ts'] = round(time.time() % 100000, 2)
    with open(L, 'a') as f: f.write(json.dumps(k) + '\n')
def ctl(n, d=None):
    try: return open(C + n).read().strip()
    except Exception: return d
raw = sys.stdin.read()
try: d = json.loads(raw)
except Exception: d = {}
ev = d.get('hook_event_name')
slim = {k: v for k, v in d.items() if k not in ('transcript_path','session_id','cwd','scratchpad_dir')}
log(ev=ev, input=slim)
def out(o):
    sys.stdout.write(json.dumps(o)); sys.stdout.flush()
if ev == 'Stop':
    def term(sig, fr):
        log(ev='STOP_HOOK_KILLED', sig=sig); sys.exit(1)
    signal.signal(signal.SIGTERM, term); signal.signal(signal.SIGINT, term); signal.signal(signal.SIGHUP, term)
    wait = float(ctl('wait_secs', '90')); t0 = time.time(); inbox = C + 'inbox'
    log(ev='STOP_WAIT_START', wait=wait, sid=d.get('session_id'))
    while time.time() - t0 < wait:
        if os.path.exists(inbox):
            txt = open(inbox).read().strip(); os.remove(inbox)
            log(ev='STOP_WAIT_END', why='inbox', waited=round(time.time()-t0,1), text=txt)
            out({"decision": "block", "reason": txt}); sys.exit(0)
        time.sleep(0.25)
    log(ev='STOP_WAIT_END', why='timeout', waited=round(time.time()-t0,1))
elif ev == 'PermissionRequest':
    tn = d.get('tool_name')
    if tn == 'AskUserQuestion' and ctl('ask_mode') == 'permreq':
        t0 = time.time()
        while not os.path.exists(C + 'answer') and time.time() - t0 < 60: time.sleep(0.25)
        ans = open(C + 'answer').read().strip(); ti = d['tool_input']
        out({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow", "updatedInput": {"questions": ti['questions'], "answers": {ti['questions'][0]['question']: ans}}}}})
    else:
        p = ctl('perm')
        if p == 'allow': out({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}})
        elif p == 'allow_accept': out({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow", "updatedPermissions": [{"type": "setMode", "mode": "acceptEdits", "destination": "session"}]}}})
        elif p == 'deny': out({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny", "message": "Denied from glasses (test)"}}})
elif ev == 'PreToolUse' and d.get('tool_name') == 'AskUserQuestion' and ctl('ask_mode') == 'pretool':
    t0 = time.time()
    while not os.path.exists(C + 'answer') and time.time() - t0 < 60: time.sleep(0.25)
    ans = open(C + 'answer').read().strip(); ti = d['tool_input']
    log(ev='ASK_ANSWERED', ans=ans, waited=round(time.time()-t0,1))
    out({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": {"questions": ti['questions'], "answers": {ti['questions'][0]['question']: ans}}}})
