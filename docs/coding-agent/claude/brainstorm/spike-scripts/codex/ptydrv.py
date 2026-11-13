"""Run a command under a pty; raw output -> pty.log; bytes (python literal per line) read from FIFO 'ctl' are written to the pty."""
import os, pty, sys, struct, fcntl, termios, select, signal, ast, time
here=os.path.dirname(os.path.abspath(__file__))
cmd=sys.argv[1:]
env=dict(os.environ, TERM='xterm-256color')
pid,fd=pty.fork()
if pid==0:
    os.execvpe(cmd[0],cmd,env)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',50,160,0,0))
ctl=os.path.join(here,'ctl')
if os.path.exists(ctl): os.remove(ctl)
os.mkfifo(ctl); cfd=os.open(ctl,os.O_RDONLY|os.O_NONBLOCK)
log=open(os.path.join(here,'pty.log'),'wb',buffering=0); buf=b''
open(os.path.join(here,'pty.pid'),'w').write(str(pid))
while True:
    r,_,_=select.select([fd,cfd],[],[],1)
    if fd in r:
        try: d=os.read(fd,65536)
        except OSError: break
        if not d: break
        log.write(d)
    if cfd in r:
        d=os.read(cfd,65536)
        buf+=d
        while b'\n' in buf:
            line,buf=buf.split(b'\n',1)
            if line.strip(): os.write(fd,ast.literal_eval(line.decode()))
    try:
        p,_=os.waitpid(pid,os.WNOHANG)
        if p: break
    except ChildProcessError: break
