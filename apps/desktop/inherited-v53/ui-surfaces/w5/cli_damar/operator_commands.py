"""Read-only operator ingress. No sessions, plugins, tools or secret-store reads."""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


class CommandError(Exception):
    def __init__(self, code, message, status=2):
        super().__init__(message)
        self.code, self.status = code, status


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise CommandError("INVALID_ARGUMENT", "Invalid arguments; use help for operator command syntax")


def redact(value):
    if isinstance(value, dict):
        return {key: "[REDACTED]" if re.search(
            r"token|secret|password|authorization|credential|api.?key|cookie", key, re.I)
            else redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r"(https?://)[^\s/@]+:[^\s/@]+@", r"\1[REDACTED]@", value, flags=re.I)
        value = re.sub(r"([?&](?:key|api_key|token|secret|password)=)[^&#\s]*", r"\1[REDACTED]", value, flags=re.I)
        value = re.sub(r"Bearer\s+[^\s\"']+", "Bearer [REDACTED]", value, flags=re.I)
        for name in ("DAMAR_TOKEN", "DAMAR_API_KEY", "NINEROUTER_API_KEY"):
            secret = os.environ.get(name)
            if secret:
                value = value.replace(secret, "[REDACTED]")
    return value


def get_json(origin, path):
    headers = {"x-damar-channel": "cli"}
    token = os.environ.get("DAMAR_TOKEN")
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(origin + path, headers=headers, method="GET")
    # Do not follow a runtime redirect with the existing credential attached.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    with urllib.request.build_opener(NoRedirect).open(request, timeout=3) as response:
        body = json.loads(response.read(2_000_001).decode("utf-8"))
    if not isinstance(body, (dict, list)) or isinstance(body, dict) and body.get("success") is False:
        raise CommandError("REQUEST_FAILED", "Runtime returned an unsuccessful response", 1)
    return body


def run(argv, *, version, load_config, provider_catalog, home_dir):
    """Return None for explicitly requested legacy flags, otherwise an exit status."""
    operator = not argv or bool(argv and not argv[0].startswith("-")) or "--json" in argv or "--url" in argv
    if not operator:
        return None
    if argv and not argv[0].startswith("-") and any(arg in {"--help", "-h"} for arg in argv):
        argv = ["help", argv[0]] + [arg for arg in argv[1:] if arg not in {"--help", "-h"}]
    if "--json" in argv:
        argv = ["version" if arg == "--version" else "help" if arg in {"--help", "-h"} else arg for arg in argv]
    parser = Parser(prog="damar", description="Read-only DAMAR operator commands")
    parser.add_argument("command", nargs="?", default="help")
    parser.add_argument("operation", nargs="?")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--url", default=os.environ.get("DAMAR_URL", "http://127.0.0.1:29623"))
    as_json = "--json" in argv
    try:
        args = parser.parse_args(argv)
        command = args.command
        if command == "help":
            if args.operation and args.operation not in {"status", "doctor", "config", "providers", "models", "tools", "version", "plan", "approval", "jobs", "verify", "check", "audit", "logs", "tail", "export", "provider"}:
                raise CommandError("INVALID_ARGUMENT", "Unknown command help target")
            data = {"usage": "damar <status|doctor|config [show]|providers [list]|models [list]|help|version> [--json] [--url ORIGIN]",
                    "legacy": "Use -p/--prompt for chat; --plain for a legacy REPL; --self-test for local tests.",
                    "runtime": "http://127.0.0.1:29623", "gateway": "http://127.0.0.1:20127/v1",
                    "policy": "Operator mutations are not implemented; diagnostics never repair or grant authority."}
        elif command == "version":
            if args.operation:
                raise CommandError("INVALID_ARGUMENT", "version takes no operation")
            data = {"name": "damar-cli", "version": version}
        elif command in {"status", "doctor", "config", "providers", "models", "tools"}:
            allowed = "show" if command == "config" else "list"
            if args.operation and (command in {"status", "doctor"} or args.operation != allowed):
                raise CommandError("NOT_IMPLEMENTED", "Only the documented read-only operation is implemented", 3)
            url = urllib.parse.urlsplit(args.url)
            if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in {"", "/"}:
                raise CommandError("INVALID_ARGUMENT", "Runtime URL must be an HTTP(S) origin without credentials or path")
            origin = args.url.rstrip("/")
            if command in {"status", "doctor"}:
                data = None
                for path in ("/api/health", "/health", "/ready"):
                    try:
                        data = get_json(origin, path)
                        break
                    except urllib.error.HTTPError as exc:
                        if exc.code != 404:
                            raise
                if data is None:
                    raise CommandError("NOT_IMPLEMENTED", "Runtime has no supported health route", 3)
                if command == "doctor":
                    data = {"reachable": True, "runtime": origin, "health": data, "repairsAttempted": False}
            elif command == "config":
                path = home_dir() / "config.json"
                if path.exists():
                    raw = json.loads(path.read_text(encoding="utf-8"))
                    if not isinstance(raw, dict):
                        raise CommandError("INVALID_CONFIG", "Local config must contain a JSON object", 1)
                data = {"scope": "local-python-cli", "config": load_config()}
            elif command == "providers":
                data = get_json(origin, "/api/v1/console/ai/providers")
            else:
                data = get_json(origin, "/api/v1/console/" + ("ai/models" if command == "models" else "tools"))
        elif command in {"start", "stop", "restart", "install", "uninstall", "update", "set", "provider", "model", "trust", "memory", "run", "execute", "approve", "login", "logout", "plan", "approval", "jobs", "verify", "check", "audit", "logs", "tail", "export"}:
            raise CommandError("NOT_IMPLEMENTED", "No owner-bound operator adapter. No action was performed.", 3)
        else:
            raise CommandError("UNKNOWN_COMMAND", "Unknown operator command; use help or -p for a prompt")
        clean = redact(data)
        print(json.dumps({"success": True, "data": clean} if as_json else clean, ensure_ascii=True, indent=None if as_json else 2))
        return 0
    except (CommandError, OSError, ValueError, urllib.error.URLError) as exc:
        code = exc.code if isinstance(exc, CommandError) else "REQUEST_FAILED"
        message = str(exc) if isinstance(exc, CommandError) else "Read failed; check endpoint, local config and existing credentials"
        if as_json:
            print(json.dumps({"success": False, "error": {"code": code, "message": message}}))
        else:
            print(f"{code}: {message}", file=sys.stderr)
        return exc.status if isinstance(exc, CommandError) else 1
