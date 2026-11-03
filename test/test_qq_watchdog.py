import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('watchdog',Path(__file__).resolve().parents[1]/'tools/qq_watchdog.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Backend:
    account='123456789';secret=None
    def __init__(self,states,secret=None,password=None):self.states=iter(states);self.last={'online':False};self.calls=[];self.secret=secret;self.password_result=password or {'accepted':True}
    def probe(self):
        try:self.last=next(self.states)
        except StopIteration:pass
        return self.last
    def quick(self):self.calls.append('quick');return {'accepted':True}
    def restart(self):self.calls.append('restart');return True
    def password(self):self.calls.append('password');return self.password_result
    def wait(self):pass
class Tests(unittest.TestCase):
    def test_healthy_is_quiet_and_does_not_log_in(self):
        backend=Backend([{'online':True}]);state=module.Watchdog(backend).run({},100000)
        self.assertTrue(state['online']);self.assertEqual(backend.calls,[])
    def test_cached_login_first(self):
        backend=Backend([{'online':False},{'online':True}]);state=module.Watchdog(backend).run({},100000)
        self.assertEqual(state['action'],'cached_login');self.assertEqual(backend.calls,['quick'])
        self.assertEqual(state['lastAutomaticRecoveryAt'],100000)
        forced=module.Watchdog(Backend([{'online':False},{'online':True}])).run({'lastAutomaticRecoveryAt':90000},100001,force=True)
        self.assertEqual(forced['lastAutomaticRecoveryAt'],90000)
    def test_stuck_client_restarts_only_once(self):
        backend=Backend([{'online':False}]*6+[{'online':True}]);state=module.Watchdog(backend).run({},100000)
        self.assertTrue(state['online']);self.assertEqual(backend.calls,['quick','restart'])
    def test_verification_is_not_bypassed(self):
        backend=Backend([{'online':False}],secret='hash',password={'reason':'captcha_required'});state=module.Watchdog(backend).run({'lastRestartAt':99999},100000)
        self.assertEqual(state['reason'],'captcha_required');self.assertTrue(state['needsHuman']);self.assertEqual(backend.calls,['quick','password'])
    def test_repeated_recovery_is_throttled(self):
        backend=Backend([{'online':False}]);state=module.Watchdog(backend).run({'lastAutomaticRecoveryAt':99999},100000)
        self.assertEqual(state['reason'],'recovery_cooldown');self.assertEqual(backend.calls,[])
    def test_no_password_is_needed_if_cache_works(self):
        backend=Backend([{'online':False}]);state=module.Watchdog(backend).run({'lastRestartAt':99999},100000)
        self.assertEqual(state['reason'],'cached_login_expired_no_password');self.assertNotIn('password',backend.calls)
    def test_wrong_account_does_not_log_out_or_overwrite(self):
        backend=Backend([{'online':False,'wrongAccount':True}]);state=module.Watchdog(backend).run({},100000)
        self.assertEqual(state['status'],'wrong_account');self.assertEqual(backend.calls,[])
        pending=Backend([{'online':False,'phase':'initializing'},{'online':False,'wrongAccount':True}])
        self.assertEqual(module.Watchdog(pending).run({},100000)['status'],'wrong_account');self.assertEqual(pending.calls,[])
        restarted=Backend([{'online':False}]*6+[{'online':False,'wrongAccount':True}])
        self.assertEqual(module.Watchdog(restarted).run({},100000)['status'],'wrong_account');self.assertEqual(restarted.calls,['quick','restart'])
    def test_probe_only_never_changes_login(self):
        backend=Backend([{'online':False}]);state=module.Watchdog(backend).run({},100000,check_only=True)
        self.assertEqual(state['status'],'offline');self.assertEqual(backend.calls,[])
        state=module.Watchdog(backend).run({'needsHuman':True,'reason':'captcha_required'},100000,check_only=True)
        self.assertTrue(state['needsHuman']);self.assertEqual(state['reason'],'captcha_required');self.assertEqual(backend.calls,[])
if __name__=='__main__':unittest.main()
