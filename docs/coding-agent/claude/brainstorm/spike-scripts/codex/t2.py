from wsclient import *
import sys
tid=sys.argv[1]
w=WS(); w.init()
def show(r): print('NOTE',json.dumps(r)[:400])
r=w.call('thread/loaded/list',{}); print(r['result'])
r=w.call('thread/resume',{'threadId':tid,'excludeTurns':True}); print(json.dumps(r)[:700]); res=r.get('result') or {'thread':{}}; print('RESUME keys',list(res.keys())); print({k:res[k] for k in res if k!='thread'}); print('thread status',res['thread'].get('status'))
r=w.call('turn/start',{'threadId':tid,'input':[{'type':'text','text':'Reply with exactly the word CHERRY.'}],'model':'gpt-6-luna','effort':'low'}); print('TURNSTART',json.dumps(r)[:600])
end=time.time()+25
while time.time()<end:
    m=w.recv(2)
    if m: show(m)
