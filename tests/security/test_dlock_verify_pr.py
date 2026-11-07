#!/usr/bin/env python3
"""Deterministic offline falsification of trusted base-branch check."""
import base64
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import tempfile
import unittest
from contextlib import redirect_stdout

BASE = pathlib.Path(__file__).resolve().parents[2]
MODULE = BASE / 'scripts' / 'dlock-verify-pr.py'
spec = importlib.util.spec_from_file_location('dlock_verifier', MODULE)
dlock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dlock)

HEAD_SHA = 'b' * 40
REPO = 'jrxid09-design/Damar'
VALID_LOCK = b'{"lockfileVersion":3,"packages":{"":{}}}\n'

def event(**overrides):
    e = {'repository': {'full_name': REPO}, 'pull_request': {'base': {'ref': 'develop', 'repo': {'full_name': REPO}}, 'head': {'sha': HEAD_SHA, 'repo': {'full_name': REPO}}}}
    for k, v in overrides.items(): e[k] = v
    return e

def env(**overrides):
    e = {'GITHUB_EVENT_NAME': 'pull_request_target', 'GITHUB_REPOSITORY': REPO, 'GITHUB_TOKEN': 'synthetic-test-token', 'DLOCK_APPROVED_LOCK_SHA256': hashlib.sha256(VALID_LOCK).hexdigest()}
    e.update(overrides)
    return e

class StubResponse:
    status = 200
    def __init__(self, raw): self.raw = raw
    def __enter__(self): return self
    def __exit__(self, exc_type, exc, tb): return False
    def read(self, n): return self.raw[:n]

class StubOpener:
    def __init__(self, lock=VALID_LOCK, tamper=None):
        sha = hashlib.sha1(b'blob '+str(len(lock)).encode()+b'\0'+lock).hexdigest()
        self.record = {'type': 'file', 'encoding':'base64', 'content':base64.b64encode(lock).decode(), 'sha':sha}
        self.lock = lock
        self.tamper = tamper
        self.requests=[]
    def open(self, req, timeout):
        self.requests.append(req.full_url)
        assert timeout == 15
        assert req.full_url.startswith('https://api.github.com/repos/')
        record = dict(self.record)
        if self.tamper: record.update(self.tamper)
        return StubResponse(json.dumps(record).encode())

class SecureDLockTests(unittest.TestCase):
    def assertDenied(self, ev=None, en=None, opener=None):
        with self.assertRaisesRegex(ValueError, '^DLOCK_DENY:'):
            dlock.verify(ev if ev is not None else event(), en if en is not None else env(), opener=opener or StubOpener())

    def test_approved_base_job_accepts_current_pr_lock_as_data(self):
        o = StubOpener()
        with redirect_stdout(io.StringIO()) as out:
            result=dlock.verify(event(), env(), opener=o)
        self.assertEqual(result, hashlib.sha256(VALID_LOCK).hexdigest())
        self.assertIn('DLOCK_TRUST_OK',out.getvalue())
        self.assertEqual(len(o.requests),1)
        self.assertTrue(o.requests[0].endswith('ref='+HEAD_SHA))

    def test_attacker_pr_with_injected_g25_is_denied(self):
        self.assertDenied(opener=StubOpener(VALID_LOCK+b'evil-lock-injection'))

    def test_attacker_pr_with_g26_and_forged_local_digest_denied(self):
        self.assertDenied(opener=StubOpener(VALID_LOCK+b'evil-dependency'))

    def test_attacker_controls_pin_is_not_resisted_without_external_protection(self):
        poisoned=VALID_LOCK+b'attacker-payload'
        with redirect_stdout(io.StringIO()):
            self.assertEqual(dlock.verify(event(),env(DLOCK_APPROVED_LOCK_SHA256=hashlib.sha256(poisoned).hexdigest()),opener=StubOpener(poisoned)),hashlib.sha256(poisoned).hexdigest())

    def test_empty_pin_denied(self):
        self.assertDenied(en=env(DLOCK_APPROVED_LOCK_SHA256=''))

    def test_malformed_pin_denied(self):
        self.assertDenied(en=env(DLOCK_APPROVED_LOCK_SHA256='0'*63+'!'))

    def test_missing_token_denied(self):
        self.assertDenied(en=env(GITHUB_TOKEN=''))

    def test_wrong_event_type_denied(self):
        self.assertDenied(en=env(GITHUB_EVENT_NAME='pull_request'))

    def test_foreign_repository_denied(self):
        e=event();e['repository']['full_name']='evil/repo';self.assertDenied(ev=e)

    def test_wrong_base_ref_denied(self):
        e=event();e['pull_request']['base']['ref']='main';self.assertDenied(ev=e)

    def test_malicious_head_repo_denied(self):
        e=event();e['pull_request']['head']['repo']['full_name']='evil/repo?x=y';self.assertDenied(ev=e)

    def test_head_sha_must_be_exact_commit_sha1(self):
        e=event();e['pull_request']['head']['sha']='refs/heads/main';self.assertDenied(ev=e)

    def test_blob_sha_mismatch_denied(self):
        self.assertDenied(opener=StubOpener(tamper={'sha':'0'*40}))

    def test_bad_base64_denied(self):
        self.assertDenied(opener=StubOpener(tamper={'content':'@@@'}))

    def test_unexpected_api_encoding_denied(self):
        self.assertDenied(opener=StubOpener(tamper={'encoding':'none'}))

    def test_api_response_too_large_denied(self):
        class Huge(StubOpener):
            def open(self,req,timeout):return StubResponse(b'x'*(dlock.MAX_API_BYTES+3))
        self.assertDenied(opener=Huge())

    def test_empty_lock_denied(self):
        self.assertDenied(opener=StubOpener(b''))

    def test_lock_exceeding_limit_denied(self):
        self.assertDenied(opener=StubOpener(b'a'*(dlock.MAX_LOCK_BYTES+1)))

    def test_workflow_uses_only_base_sha_and_no_pr_head_checkout(self):
        content=(BASE/'.github/workflows/dlock-policy-gate.yml').read_text()
        self.assertIn('pull_request_target:',content)
        self.assertIn('ref: ${{ github.event.pull_request.base.sha }}',content)
        self.assertNotIn('checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}',content)
        self.assertIn('contents: read',content)
        self.assertIn('persist-credentials: false',content)
        self.assertIn('python3 scripts/dlock-verify-pr.py',content)

    def test_codeowners_rules_cover_trusted_components(self):
        content=(BASE/'.github/CODEOWNERS').read_text()
        for target in ('.github/CODEOWNERS','.github/workflows/*','scripts/dlock-verify-pr.py','scripts/check-dep-policy.js','scripts/dependency-policy.json','package-lock.json'):
            self.assertIn('/'+target+' @jrxid09-design',content)

if __name__=='__main__':unittest.main()
