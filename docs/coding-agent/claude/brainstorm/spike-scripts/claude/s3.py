import sys, time, os, re
sys.path.insert(0, '.'); from drv import *
B = os.getcwd(); out = open('logs/s3_screens.txt', 'w')
for f in os.listdir('ctl'): os.remove('ctl/' + f)
open('ctl/wait_secs', 'w').write('0')
s = Sess(['--model', 'claude-haiku-4-5-20251001', '--settings', f'{B}/s1.json', '--strict-mcp-config'], f'{B}/work', log='logs/s3.raw')
startup(s, out)
def P(txt, label, perm=None, settle=6):
    if perm is None:
        if os.path.exists('ctl/perm'): os.remove('ctl/perm')
    else: open('ctl/perm', 'w').write(perm)
    n = len(evlog()); s.type(txt); s.send(ENTER); return n
# P1: no hook decision -> dialog
n = P('Use the Bash tool to run `ls` and then run `echo hi1 > x1.txt`. Nothing else.', 'P1')
print('P1 PermissionRequest fired:', waitev('"PermissionRequest"', n, 60))
time.sleep(2); snap(s, 'P1 dialog +2s', out)
time.sleep(7); snap(s, 'P1 dialog +9s (Notification?)', out)
print('P1 notif:', [l[:200] for l in evlog()[n:].splitlines() if '"Notification"' in l])
s.send(ENTER); time.sleep(8); snap(s, 'P1 after answering dialog Enter', out)
print('P1 events:', [(json.loads(l)['ev'], json.loads(l).get('input',{}).get('tool_name')) for l in evlog()[n:].splitlines()] if False else '')
# P2: hook allow
n = P('Use the Bash tool to run `echo hi2 > x2.txt`. Nothing else.', 'P2', 'allow'); time.sleep(12); snap(s, 'P2 hook=allow', out)
# P3: hook deny
n = P('Use the Bash tool to run `echo hi3 > x3.txt`. Nothing else.', 'P3', 'deny'); time.sleep(12); snap(s, 'P3 hook=deny', out)
# P4: allow + setMode acceptEdits
n = P('Use the Bash tool to run `echo hi4 > x4.txt`. Nothing else.', 'P4', 'allow_accept'); time.sleep(12); snap(s, 'P4 hook=allow+setMode acceptEdits', out)
# P5: no hook decision; Write tool should not prompt if mode switched
n = P('Use the Write tool to create x5.txt containing hi5. Nothing else.', 'P5'); time.sleep(12); snap(s, 'P5 Write after setMode', out)
# model switch
s.type('/model sonnet'); s.send(ENTER); time.sleep(3); snap(s, '/model sonnet', out)
s.send(ENTER); time.sleep(3); snap(s, '/model sonnet after Enter', out)
print('statusline model:', json.loads(open('logs/statusline_last.json').read())['model'] if os.path.exists('logs/statusline_last.json') else None)
s.kill()
