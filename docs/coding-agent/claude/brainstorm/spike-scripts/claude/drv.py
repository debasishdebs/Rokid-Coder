import os, pty, fcntl, termios, struct, re, time, signal, threading, select, sys

class Screen:
    def __init__(s, rows=50, cols=140):
        s.r, s.c = rows, cols; s.reset()
    def reset(s):
        s.g = [[' ']*s.c for _ in range(s.r)]; s.y = s.x = 0
    def feed(s, t):
        i = 0; n = len(t)
        while i < n:
            ch = t[i]
            if ch == '\x1b':
                if i+1 < n and t[i+1] == '[':
                    m = re.compile(r'\x1b\[([0-9;?<>=! ]*)([@-~])').match(t, i)
                    if not m: i += 1; continue
                    s.csi(m.group(1), m.group(2)); i = m.end(); continue
                if i+1 < n and t[i+1] == ']':
                    m = re.compile(r'\x1b\].*?(\x07|\x1b\\)', re.S).match(t, i)
                    i = m.end() if m else i+2; continue
                i += 2; continue
            if ch == '\r': s.x = 0
            elif ch == '\n':
                s.y += 1
                if s.y >= s.r: s.g.pop(0); s.g.append([' ']*s.c); s.y = s.r-1
            elif ch == '\b': s.x = max(0, s.x-1)
            elif ch >= ' ':
                if s.x >= s.c: s.x = 0; s.y = min(s.y+1, s.r-1)
                s.g[s.y][s.x] = ch; s.x += 1
            i += 1
    def csi(s, p, f):
        if p.startswith('?') or p.startswith('>') or p.startswith('<') or p.startswith('='): return
        a = [int(x) if x.isdigit() else 0 for x in p.split(';')] if p else []
        g = lambda k, d=1: (a[k] if len(a) > k and a[k] else d)
        if f == 'A': s.y = max(0, s.y-g(0))
        elif f == 'B': s.y = min(s.r-1, s.y+g(0))
        elif f == 'C': s.x = min(s.c-1, s.x+g(0))
        elif f == 'D': s.x = max(0, s.x-g(0))
        elif f == 'G': s.x = g(0)-1
        elif f == 'd': s.y = g(0)-1
        elif f in 'Hf': s.y = min(s.r-1, g(0)-1); s.x = min(s.c-1, g(1)-1)
        elif f == 'J':
            m = a[0] if a else 0
            if m == 0:
                for x in range(s.x, s.c): s.g[s.y][x] = ' '
                for y in range(s.y+1, s.r): s.g[y] = [' ']*s.c
            elif m in (2, 3): s.g = [[' ']*s.c for _ in range(s.r)]
            elif m == 1:
                for y in range(0, s.y): s.g[y] = [' ']*s.c
                for x in range(0, s.x+1): s.g[s.y][x] = ' '
        elif f == 'K':
            m = a[0] if a else 0
            rng = range(s.x, s.c) if m == 0 else range(0, s.x+1) if m == 1 else range(s.c)
            for x in rng: s.g[s.y][x] = ' '
        elif f == 'X':
            for x in range(s.x, min(s.c, s.x+g(0))): s.g[s.y][x] = ' '
        elif f == 'L':
            for _ in range(g(0)): s.g.insert(s.y, [' ']*s.c); s.g.pop()
        elif f == 'M':
            for _ in range(g(0)): s.g.pop(s.y); s.g.append([' ']*s.c)
    def text(s):
        lines = [''.join(r).rstrip() for r in s.g]
        while lines and not lines[-1]: lines.pop()
        return '\n'.join(lines)

class Sess:
    def __init__(s, args, cwd, env=None, rows=50, cols=140, log=None):
        s.scr = Screen(rows, cols); s.raw = b''; s.lock = threading.Lock()
        e = {k: v for k, v in os.environ.items() if not k.startswith('CLAUDE')}; e['CLAUDE_CODE_FORCE_SESSION_PERSISTENCE'] = '1'; e['TERM'] = 'xterm-256color'; e['COLUMNS'] = str(cols); e['LINES'] = str(rows)
        e.update(env or {})
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            os.execvpe('claude', ['claude'] + args, e)
        s.pid, s.fd = pid, fd
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        s.alive = True; s.logf = open(log, 'ab') if log else None
        s.t = threading.Thread(target=s._rd, daemon=True); s.t.start()
    def _rd(s):
        dec = __import__('codecs').getincrementaldecoder('utf-8')('replace')
        while True:
            try:
                r, _, _ = select.select([s.fd], [], [], 0.2)
                if not r:
                    if not s._alive(): break
                    continue
                d = os.read(s.fd, 65536)
            except OSError: break
            if not d: break
            if s.logf: s.logf.write(d); s.logf.flush()
            with s.lock:
                s.raw += d; s.scr.feed(dec.decode(d))
        s.alive = False
    def _alive(s):
        try:
            p, _ = os.waitpid(s.pid, os.WNOHANG); return p == 0
        except ChildProcessError: return False
    def send(s, t):
        os.write(s.fd, t.encode() if isinstance(t, str) else t)
    def type(s, t, delay=0.02):
        for ch in t: s.send(ch); time.sleep(delay)
    def screen(s):
        with s.lock: return s.scr.text()
    def wait(s, pat, timeout=30, poll=0.3):
        end = time.time()+timeout; rx = re.compile(pat)
        while time.time() < end:
            if rx.search(s.screen()): return True
            time.sleep(poll)
        return False
    def kill(s):
        try: os.kill(s.pid, signal.SIGTERM)
        except OSError: pass
        time.sleep(1)
        try: os.kill(s.pid, signal.SIGKILL)
        except OSError: pass
        try: os.waitpid(s.pid, 0)
        except Exception: pass

ENTER = '\r'; ESC = '\x1b'; CTRLC = '\x03'; SHIFT_TAB = '\x1b[Z'
def snap(s, label, out=sys.stdout):
    txt = s.screen(); lines = txt.split('\n')
    lines = [l for l in lines if not l.startswith('▎') and 'Update available' not in l and not l.startswith('▗') and not l.startswith(' ▘▘') and not l.startswith('           Haiku')]
    txt = re.sub(r'\n{2,}', '\n', '\n'.join(lines))
    out.write(f"\n===== [{time.strftime('%H:%M:%S')}] {label} =====\n{txt}\n"); out.flush()
def evlog(): 
    try: return open('logs/events.jsonl').read()
    except Exception: return ''
def waitev(pat, since=0, timeout=60):
    end = time.time()+timeout
    while time.time() < end:
        if re.search(pat, evlog()[since:]): return True
        time.sleep(0.3)
    return False

def startup(s, out):
    time.sleep(5)
    if re.search('Yes, I trust', s.screen()):
        s.send('\x1b[B'); time.sleep(0.5); s.send(ENTER); time.sleep(3); snap(s, 'after trust answered', out)
    for _ in range(20):
        if re.search(r'❯\s*$|\? for shortcuts|Try "', s.screen(), re.M): break
        time.sleep(1)
    time.sleep(1); snap(s, 'ready', out)
