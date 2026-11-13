import sys,json
from wsclient import *
w=WS(); w.init()
r=w.call(sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv)>2 else {}, timeout=int(sys.argv[3]) if len(sys.argv)>3 else 15)
print(json.dumps(r,indent=None)[:int(sys.argv[4]) if len(sys.argv)>4 else 3000])
