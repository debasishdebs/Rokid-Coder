import sys, time, os
sys.path.insert(0, '.'); from drv import *
B = os.getcwd(); out = open('logs/s2_screens.txt', 'w')
for f in os.listdir('ctl'): os.remove('ctl/' + f)
open('ctl/wait_secs', 'w').write('90')
s = Sess(['--model', 'claude-haiku-4-5-20251001', '--settings', f'{B}/s2.json', '--strict-mcp-config'], f'{B}/work', log='logs/s2.raw')
startup(s, out)
def rnd(word):
    n = len(evlog()); s.type(f'Reply with exactly the word {word}.'); s.send(ENTER)
    ok = waitev('STOP_WAIT_START', n, 60); time.sleep(3); return n, ok
# R1: Ctrl+C
n, ok = rnd('ONE'); print('R1 wait started', ok); snap(s, 'R1 hook waiting', out)
s.send(CTRLC); time.sleep(3); snap(s, 'R1 after Ctrl+C x1', out)
print('alive', s.alive, 'killed logged', 'STOP_HOOK_KILLED' in evlog()[n:])
time.sleep(3); snap(s, 'R1 +3s', out)
# R2: queue message then ctrl+x ctrl+s
if s.alive:
    n, ok = rnd('TWO'); print('R2 wait started', ok)
    s.type('Reply with exactly the word QUEUED.'); s.send(ENTER); time.sleep(2); snap(s, 'R2 queued msg', out)
    s.send('\x18'); time.sleep(0.3); s.send('\x13'); time.sleep(6); snap(s, 'R2 after ctrl+x ctrl+s', out)
    print('R2 killed:', 'STOP_HOOK_KILLED' in evlog()[n:])
# R3: timeout enforcement (settings timeout 25)
if s.alive:
    open('ctl/wait_secs', 'w').write('90')
    time.sleep(15); snap(s, 'pre-R3', out)
    n, ok = rnd('THREE'); print('R3 wait started', ok); t0 = time.time()
    time.sleep(30); snap(s, 'R3 +33s (timeout 25)', out)
    print('R3 events:', [l[:140] for l in evlog()[n:].splitlines() if 'STOP' in l])
s.kill()
