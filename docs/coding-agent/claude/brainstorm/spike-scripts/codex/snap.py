# crude screen render of pty.log using pyte if present else strip ANSI
import re,sys
d=open('pty.log','rb').read().decode('utf8','replace')
try:
    import pyte
    s=pyte.Screen(160,50); st=pyte.Stream(s); st.feed(d); print('\n'.join(l.rstrip() for l in s.display if l.strip()))
except ImportError:
    d=re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]','',d); print(d[-3000:])
