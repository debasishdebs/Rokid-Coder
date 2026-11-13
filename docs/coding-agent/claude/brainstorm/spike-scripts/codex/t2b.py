from wsclient import *
import sys
tid=sys.argv[1]; prompt=sys.argv[2]
w=WS(); w.init()
r=w.call('thread/resume',{'threadId':tid,'excludeTurns':True}); print('RESUME',json.dumps(r)[:900])
r=w.call('turn/start',{'threadId':tid,'input':[{'type':'text','text':prompt}],'model':'gpt-6-luna','effort':'low'}); print('TURNSTART',json.dumps(r)[:300])
end=time.time()+25
while time.time()<end:
    m=w.recv(2)
    if m: print('NOTE',json.dumps(m)[:500])
