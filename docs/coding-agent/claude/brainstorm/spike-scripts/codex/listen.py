"""Subscribe to a (TUI-owned) thread on the shared daemon; log every message to listen.log; answer server requests per mode.txt (log|approve|decline|session). usage: listen.py THREAD_ID [seconds]"""
import sys,os
from wsclient import *
tid=sys.argv[1]; secs=int(sys.argv[2]) if len(sys.argv)>2 else 120
here=os.path.dirname(os.path.abspath(__file__))
w=WS(); w.init()
r=w.call('thread/resume',{'threadId':tid,'excludeTurns':True}); print('resumed', 'error' not in r, flush=True)
log=open(os.path.join(here,'listen.log'),'a')
end=time.time()+secs; pending=[]
def mode():
    p=os.path.join(here,'mode.txt'); return open(p).read().strip() if os.path.exists(p) else 'log'
def answer(m,md):
    meth=m['method']; res=None
    if meth in ('item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'):
        res={'decision':{'approve':'accept','decline':'decline','session':'acceptForSession'}[md]}
    elif meth=='item/tool/requestUserInput':
        qs=m['params']['questions']; res={'answers':{q['id']:{'answers':[(q['options'] or [{'label':'x'}])[0]['label']]} for q in qs}}
    if res is not None:
        w.send({'jsonrpc':'2.0','id':m['id'],'result':res}); log.write(json.dumps({'t':time.time(),'answered':res,'req':m['method']})+'\n'); log.flush()
while time.time()<end:
    md=mode()
    if md!='log':
        for m in pending: answer(m,md)
        pending=[]
    m=w.recv(1)
    if not m: continue
    log.write(json.dumps({'t':time.time(),'m':m})+'\n'); log.flush()
    if 'method' in m and 'id' in m: pending.append(m)
