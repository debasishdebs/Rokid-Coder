import sys, time, os, json
sys.path.insert(0, '.'); from drv import *
mode = sys.argv[1]; B = os.getcwd(); out = open(f'logs/s4_{mode}{len(sys.argv)}_screens.txt', 'w')
for f in os.listdir('ctl'): os.remove('ctl/' + f)
open('ctl/wait_secs', 'w').write('0'); open('ctl/ask_mode', 'w').write(mode)
s = Sess(['--model', 'claude-haiku-4-5-20251001', '--settings', f'{B}/s1.json', '--strict-mcp-config'], f'{B}/work', log=f'logs/s4_{mode}{len(sys.argv)}.raw')
startup(s, out)
n = len(evlog())
s.type('Use your AskUserQuestion tool to ask me one multiple-choice question: "Favorite color?" with options Red and Blue. After I answer, state my answer in one short sentence.'); s.send(ENTER)
pat = 'PreToolUse.*AskUserQuestion' if mode == 'pretool' else 'PermissionRequest.*AskUserQuestion'
print('ask hook fired:', waitev(pat, n, 60))
time.sleep(3); snap(s, f'{mode}: hook waiting for answer (+3s)', out)
open('ctl/answer', 'w').write(sys.argv[2] if len(sys.argv)>2 else 'Blue')
time.sleep(10); snap(s, f'{mode}: after answer=Blue (+10s)', out)
time.sleep(4); snap(s, f'{mode}: +14s', out)
s.kill()
