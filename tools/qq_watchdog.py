"""Daily QQ session check/recovery. Uses cached login first; never bypasses MFA."""
import argparse,hashlib,json,os,re,subprocess,time,urllib.request
try:import fcntl
except ImportError:fcntl=None # Pure recovery-policy tests can also run on Windows.
from datetime import datetime,timezone
from pathlib import Path

def stamp(now):return datetime.fromtimestamp(now,timezone.utc).isoformat()
def read_env(path):
    return dict(line.split('=',1) for line in Path(path).read_text().splitlines() if line and not line.startswith('#') and '=' in line)
def manual_reason(error):
    value=str(error).lower()
    if any(x in value for x in ['captcha','验证码']):return 'captcha_required'
    if any(x in value for x in ['new device','新设备','device verification']):return 'device_verification_required'
    if any(x in value for x in ['安全风险','恢复账号使用','account restricted','servererrorcode":168']):return 'account_restricted'
    return None

class QQBackend:
    def __init__(self,config):
        self.config=config;self.env=read_env(config['runtimeEnv']);self.credential=None
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.account=str(config['account']);self.secret=None
        try:
            secret=Path(config['secretFile'])
            if secret.stat().st_mode&0o077:raise ValueError('Secret file must be root-only')
            data=json.loads(secret.read_text())
            if str(data.get('account'))!=self.account or not re.fullmatch(r'[a-fA-F0-9]{32}',str(data.get('passwordMd5',''))):raise ValueError('Invalid QQ secret')
            self.secret=data['passwordMd5']
        except FileNotFoundError:pass
    def request(self,base,path,body,token,timeout=5):
        headers={'Content-Type':'application/json'}
        if token:headers['Authorization']='Bearer '+token
        result=self.opener.open(urllib.request.Request(base+path,data=json.dumps(body).encode(),headers=headers),timeout=timeout)
        raw=result.read(65537)
        if len(raw)>65536:raise ValueError('Control response too large')
        return json.loads(raw)
    def web(self,path,body,timeout=5):
        if not self.credential:
            login=self.request('http://127.0.0.1:6099/api/','auth/login',{'hash':hashlib.sha256((self.env['WEBUI_TOKEN']+'.napcat').encode()).hexdigest()},None)
            self.credential=(login.get('data')or{}).get('Credential')
            if not self.credential:raise RuntimeError('WebUI auth failed')
        return self.request('http://127.0.0.1:6099/api/',path,body,self.credential,timeout)
    def probe(self):
        reachable=False
        try:
            result=self.request('http://127.0.0.1:3000/','get_status',{},self.env['ONEBOT_TOKEN'],3)
            reachable=result.get('status')=='ok'
            if reachable and (result.get('data')or{}).get('online'):
                login=self.request('http://127.0.0.1:3000/','get_login_info',{},self.env['ONEBOT_TOKEN'],3)
                actual=str((login.get('data')or{}).get('user_id',''))
                return {'online':actual==self.account,'wrongAccount':actual!=self.account,'phase':'ready','reachable':True}
        except Exception:pass
        try:
            state=self.web('QQLogin/CheckLoginStatus',{}).get('data')or{}
            return {'online':False,'phase':str(state.get('loginPhase')or'unknown'),'reachable':True,'verification':manual_reason(state.get('loginError',''))}
        except Exception:return {'online':False,'phase':'unreachable','reachable':reachable}
    def quick(self):
        try:
            result=self.web('QQLogin/SetQuickLogin',{'uin':self.account},35)
            return {'accepted':result.get('code')in[0,200]}
        except Exception:return {'accepted':False,'timeout':True}
    def restart(self):
        # Fixed existing container; never recreate it, change account, or remove volumes.
        if self.config.get('container')!='contact-ecs-napcat-1':raise ValueError('Unexpected QQ container')
        result=subprocess.run(['/usr/bin/docker','restart',self.config['container']],capture_output=True,timeout=60)
        self.credential=None
        return result.returncode==0
    def password(self):
        if not self.secret:return {'reason':'password_not_configured'}
        try:
            result=self.web('QQLogin/PasswordLogin',{'uin':self.account,'passwordMd5':self.secret},40)
            data=result.get('data')or{}
            if data.get('needCaptcha'):return {'reason':'captcha_required'}
            if data.get('needNewDevice'):return {'reason':'device_verification_required'}
            if result.get('code')not in[0,200]:return {'reason':manual_reason(result.get('message')or result.get('msg'))or'password_login_failed'}
            return {'accepted':True}
        except Exception:return {'reason':'password_login_unavailable'}
    def wait(self):time.sleep(3)
    def close(self):
        if self.credential:
            try:self.web('auth/logout',{})
            except Exception:pass
            self.credential=None

class Watchdog:
    def __init__(self,backend,save=lambda state:None):self.backend=backend;self.save=save
    def run(self,previous,now,force=False,check_only=False):
        state={**previous,'checkedAt':stamp(now),'account':self.backend.account,'online':False,'needsHuman':False}
        def finish(status,reason=None,action='none'):
            if reason=='account_restricted':state['recoveryBlocked']=True
            state.update(status=status,reason=reason,action=action,online=status in ['online','recovered'],needsHuman=status in ['needs_human','wrong_account'])
            if state['online']:state['lastGoodAt']=stamp(now)
            self.save(state);return state
        def ready(probe):return probe.get('online')and not probe.get('wrongAccount')
        def poll(count):
            probe={}
            for _ in range(count):
                self.backend.wait();probe=self.backend.probe()
                if ready(probe)or probe.get('wrongAccount')or probe.get('verification'):break
            return probe
        probe=self.backend.probe()
        if probe.get('wrongAccount'):return finish('wrong_account','unexpected_account')
        if ready(probe):
            state.pop('recoveryBlocked',None)
            return finish('online')
        if probe.get('verification'):return finish('needs_human',probe['verification'])
        if previous.get('recoveryBlocked'):return finish('needs_human','account_restricted','awaiting_user')
        if check_only:
            if previous.get('needsHuman'):return finish('needs_human',previous.get('reason'),'awaiting_user')
            return finish('offline','check_only')
        last=float(previous.get('lastAutomaticRecoveryAt',0))
        if not force and now-last<86400:
            if previous.get('needsHuman'):return finish('needs_human',previous.get('reason'),'awaiting_user')
            return finish('offline','recovery_cooldown')
        state['lastRecoveryAt']=now
        if not force:state['lastAutomaticRecoveryAt']=now
        self.save(state)
        if probe.get('phase')in['initializing','qrcode_scanned']:
            probe=poll(10)
            if ready(probe):return finish('recovered',action='pending_login_completed')
            if probe.get('wrongAccount'):return finish('wrong_account','unexpected_account')
            if probe.get('verification'):return finish('needs_human',probe['verification'])
        self.backend.quick();probe=poll(5)
        if ready(probe):return finish('recovered',action='cached_login')
        if probe.get('wrongAccount'):return finish('wrong_account','unexpected_account')
        if probe.get('verification'):return finish('needs_human',probe['verification'],'cached_login')
        # One controlled restart can repair a stuck login service. Throttle even
        # when --force is used; no repeated restarts and no volume deletion.
        if now-float(previous.get('lastRestartAt',0))>=86400:
            state['lastRestartAt']=now;self.save(state)
            try:restarted=self.backend.restart()
            except Exception:restarted=False
            if restarted:
                probe=poll(12)
                if ready(probe):return finish('recovered',action='client_restart')
                if probe.get('wrongAccount'):return finish('wrong_account','unexpected_account')
                if probe.get('verification'):return finish('needs_human',probe['verification'],'client_restart')
                self.backend.quick();probe=poll(5)
                if ready(probe):return finish('recovered',action='restart_then_cached_login')
        if probe.get('wrongAccount'):return finish('wrong_account','unexpected_account')
        if probe.get('verification'):return finish('needs_human',probe['verification'])
        if not self.backend.secret:return finish('needs_human','cached_login_expired_no_password','cached_recovery_exhausted')
        attempted=self.backend.password()
        if attempted.get('reason'):return finish('needs_human',attempted['reason'],'password_login')
        probe=poll(10)
        if ready(probe):return finish('recovered',action='password_login')
        return finish('needs_human',probe.get('verification')or'password_login_not_completed','password_login')

def save_status(path,state):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix('.tmp')
    descriptor=os.open(temporary,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o640)
    try:
        os.fchmod(descriptor,0o640)
        with os.fdopen(descriptor,'w')as stream:json.dump(state,stream,ensure_ascii=False)
        os.replace(temporary,path)
    except Exception:
        try:os.close(descriptor)
        except OSError:pass
        raise
def main():
    if fcntl is None:raise OSError('Watchdog runtime requires Linux')
    parser=argparse.ArgumentParser();parser.add_argument('--config',default='/etc/linux-contact/qq-watchdog.json');parser.add_argument('--force',action='store_true');parser.add_argument('--check-only',action='store_true');args=parser.parse_args()
    config=json.loads(Path(args.config).read_text())
    if not re.fullmatch(r'[1-9][0-9]{4,15}',str(config.get('account',''))):raise ValueError('Invalid account')
    lock=Path('/run/linux-contact-qq-watchdog/lock');lock.parent.mkdir(mode=0o750,exist_ok=True)
    with lock.open('a')as handle:
        try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return
        previous={}
        try:previous=json.loads(Path(config['statusFile']).read_text())
        except FileNotFoundError:pass
        backend=QQBackend(config)
        try:state=Watchdog(backend,lambda value:save_status(config['statusFile'],value)).run(previous,time.time(),args.force,args.check_only)
        finally:backend.close()
        if (previous.get('status'),previous.get('reason'),previous.get('action'))!=(state['status'],state['reason'],state['action']):
            print(json.dumps({key:state.get(key)for key in ['checkedAt','status','reason','action','needsHuman']}),flush=True)
if __name__=='__main__':
    try:main()
    except Exception as error:
        # No remote response body, credential, hash or challenge URL in journals.
        print(json.dumps({'status':'watchdog_error','errorType':type(error).__name__}),flush=True);raise SystemExit(1)
