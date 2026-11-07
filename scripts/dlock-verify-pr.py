#!/usr/bin/env python3
"""Trusted pull_request_target-only lock-pin verifier. Never execute PR code.

The workflow running this file MUST be sourced from the protected base branch.
This script is evidence for A+D only after GitHub branch/ruleset protection is verified.
"""
import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_API_BYTES = 4_000_000
MAX_LOCK_BYTES = 2_000_000
HEX_SHA256 = re.compile(r"[a-fA-F0-9]{64}\Z")
HEX_SHA1 = re.compile(r"[a-f0-9]{40}\Z")
REPO_NAME = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
API_HOST = "https://api.github.com"


def violation(reason):
    raise ValueError("DLOCK_DENY: " + reason)


def fetch_content(repo, commit_sha, token, *, opener=None):
    if not REPO_NAME.fullmatch(repo):
        violation("invalid PR head repository")
    if not HEX_SHA1.fullmatch(commit_sha):
        violation("invalid PR head SHA")
    url = API_HOST + "/repos/" + repo + "/contents/package-lock.json?ref=" + urllib.parse.quote(commit_sha, safe="")
    request = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "damar-dlock-readonly-trusted-checker",
    })
    if opener is None:
        # Do not follow redirections to a different host with the GITHUB_TOKEN.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=15) as response:
            if response.status != 200:
                violation("GitHub API status != 200")
            payload = response.read(MAX_API_BYTES + 1)
    except (OSError, urllib.error.HTTPError) as exc:
        violation("GitHub contents API unreadable: " + type(exc).__name__)
    if len(payload) > MAX_API_BYTES:
        violation("GitHub API response exceeds limit")
    try:
        record = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        violation("malformed contents API JSON")
    if not isinstance(record, dict) or record.get("type") != "file" or record.get("encoding") != "base64":
        violation("content is not a base64 file")
    encoded = record.get("content")
    if not isinstance(encoded, str):
        violation("missing file contents")
    try:
        lock = base64.b64decode("".join(encoded.split()), validate=True)
    except (ValueError, binascii.Error):
        violation("invalid base64 file contents")
    if len(lock) > MAX_LOCK_BYTES or len(lock) == 0:
        violation("lockfile empty or too large")
    # Independently validate GitHub-reported blob id, not just the JSON path.
    blob_sha = hashlib.sha1(b"blob " + str(len(lock)).encode("ascii") + b"\0" + lock).hexdigest()
    if not hmac.compare_digest(record.get("sha", ""), blob_sha):
        violation("GitHub blob SHA inconsistent with returned lockfile")
    return lock


def verify(event, env, *, opener=None):
    if env.get("GITHUB_EVENT_NAME") != "pull_request_target":
        violation("must run from pull_request_target on trusted base")
    if not isinstance(event, dict) or not isinstance(event.get("pull_request"), dict):
        violation("missing PR event")
    repository = event.get("repository", {}).get("full_name")
    expected_repo = env.get("GITHUB_REPOSITORY", "")
    if not isinstance(repository, str) or repository != expected_repo or not REPO_NAME.fullmatch(repository):
        violation("event repository mismatch")
    pr = event["pull_request"]
    base = pr.get("base", {})
    head = pr.get("head", {})
    if base.get("repo", {}).get("full_name") != repository or base.get("ref") != "develop":
        violation("PR base is not expected protected develop")
    head_repo = head.get("repo", {}).get("full_name")
    head_sha = head.get("sha")
    anchor = env.get("DLOCK_APPROVED_LOCK_SHA256", "")
    if not HEX_SHA256.fullmatch(anchor):
        violation("owner approval pin absent or malformed")
    token = env.get("GITHUB_TOKEN", "")
    if not token:
        violation("read-only GitHub token unavailable")
    lock = fetch_content(head_repo, head_sha, token, opener=opener)
    actual = hashlib.sha256(lock).hexdigest()
    if not hmac.compare_digest(anchor.lower(), actual):
        violation("PR lockfile does not match independently approved digest")
    print("DLOCK_TRUST_OK approved_lock_sha256=" + actual + " head_sha=" + head_sha)
    return actual


def main():
    try:
        event_path = os.environ.get("GITHUB_EVENT_PATH", "")
        if not event_path:
            violation("missing GitHub event file")
        with open(event_path, "rb") as f:
            event = json.load(f)
        verify(event, os.environ)
    except (ValueError, KeyError, TypeError, OSError, json.JSONDecodeError) as exc:
        print(str(exc) if str(exc).startswith("DLOCK_DENY:") else "DLOCK_DENY: invalid input or environment", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
