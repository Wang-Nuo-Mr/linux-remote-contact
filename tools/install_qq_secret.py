"""Root-only provisioning helper. Reads a precomputed login hash from stdin."""
import json,os,re,sys
from pathlib import Path
def main():
    if os.geteuid()!=0:raise PermissionError('Root required')
    raw=sys.stdin.buffer.read(4097)
    if len(raw)>4096:raise ValueError('Input too large')
    value=json.loads(raw);config=json.loads(Path('/etc/linux-contact/qq-watchdog.json').read_text())
    if str(value.get('account'))!=str(config['account'])or not re.fullmatch(r'[0-9a-f]{32}',str(value.get('passwordMd5',''))):raise ValueError('Invalid credential input')
    path=Path('/etc/linux-contact/qq-login.secret.json');temporary=path.with_suffix('.new')
    fd=os.open(temporary,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w')as stream:os.fchmod(stream.fileno(),0o600);json.dump({'account':str(config['account']),'passwordMd5':value['passwordMd5']},stream)
    os.chown(temporary,0,0);os.replace(temporary,path);print('qq_login_secret_installed=true')
if __name__=='__main__':
    try:main()
    except Exception as error:print('credential_install_failed='+type(error).__name__);sys.exit(1)
