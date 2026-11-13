"""Minimal WebSocket-over-unix-socket JSON-RPC client for the Codex shared app-server daemon (stdlib only)."""
import socket, os, base64, struct, json, time, threading, queue
SOCK=os.path.expanduser('~/.codex/app-server-control/app-server-control.sock')
class WS:
    def __init__(s, path=SOCK):
        s.sock=socket.socket(socket.AF_UNIX); s.sock.connect(path)
        key=base64.b64encode(os.urandom(16)).decode()
        s.sock.sendall(f"GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode())
        buf=b''
        while b'\r\n\r\n' not in buf: buf+=s.sock.recv(4096)
        head,s.buf=buf.split(b'\r\n\r\n',1)
        s.handshake=head.decode()
        s.nid=0
    def send(s, obj):
        data=json.dumps(obj).encode(); mask=os.urandom(4)
        n=len(data); hdr=bytes([0x81])
        if n<126: hdr+=bytes([0x80|n])
        elif n<65536: hdr+=bytes([0x80|126])+struct.pack('>H',n)
        else: hdr+=bytes([0x80|127])+struct.pack('>Q',n)
        s.sock.sendall(hdr+mask+bytes(b^mask[i%4] for i,b in enumerate(data)))
    def _read(s,n):
        while len(s.buf)<n:
            c=s.sock.recv(65536)
            if not c: raise EOFError
            s.buf+=c
        r,s.buf=s.buf[:n],s.buf[n:]; return r
    def recv(s, timeout=None):
        s.sock.settimeout(timeout)
        try:
            msg=b''
            while True:
                b1,b2=s._read(2); op=b1&15; n=b2&127
                if n==126: n=struct.unpack('>H',s._read(2))[0]
                elif n==127: n=struct.unpack('>Q',s._read(8))[0]
                p=s._read(n)
                if op==9: s.sock.sendall(bytes([0x8A,0x80])+os.urandom(4)); continue
                if op==8: raise EOFError('closed')
                msg+=p
                if b1&0x80: return json.loads(msg)
        except socket.timeout: return None
    def call(s, method, params=None, timeout=15, log=None):
        s.nid+=1; i=s.nid
        m={'jsonrpc':'2.0','id':i,'method':method}
        if params is not None: m['params']=params
        s.send(m); end=time.time()+timeout; notes=[]
        while time.time()<end:
            r=s.recv(max(0.1,end-time.time()))
            if r is None: continue
            if r.get('id')==i and 'method' not in r: 
                r['_notes']=notes; return r
            notes.append(r)
            if log: log(r)
        raise TimeoutError(method)
    def init(s, name='rokid-coder-spike', experimental=True):
        r=s.call('initialize',{'clientInfo':{'name':name,'title':name,'version':'0.0.1'},'capabilities':{'experimentalApi':experimental}})
        s.send({'jsonrpc':'2.0','method':'initialized'}); return r
