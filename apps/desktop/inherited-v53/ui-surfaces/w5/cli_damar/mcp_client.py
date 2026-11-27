"""Minimal MCP (Model Context Protocol) stdio client.

Servers come from the "mcpServers" config object:

    "mcpServers": {
      "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
                 "env": { "EXTRA": "1" } }
    }

The client spawns each server, performs the initialize handshake, lists its
tools and exposes them to the model as `mcp__<server>__<tool>`.
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from typing import Any, Optional


class MCPError(RuntimeError):
    pass


MCP_ENV_ALLOWLIST = {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "HOME", "USERPROFILE"}


def sanitized_mcp_env(explicit: Optional[dict] = None) -> dict[str, str]:
    """Do not leak the CLI/provider environment into child MCP servers."""
    env = {key: value for key, value in os.environ.items() if key.upper() in MCP_ENV_ALLOWLIST}
    for key, value in (explicit or {}).items():
        if value is not None:
            env[str(key)] = str(value)
    return env


class MCPServer:
    def __init__(self, name: str, command: str, args: Optional[list] = None,
                 env: Optional[dict] = None, timeout: float = 30.0) -> None:
        self.name = name
        self.command = command
        self.args = [str(a) for a in (args or [])]
        self.env = sanitized_mcp_env(env)
        self.timeout = timeout
        self.proc: Optional[subprocess.Popen] = None
        self.tools: list[dict] = []
        self._next_id = 0
        self._pending: dict[int, "queue.Queue[dict]"] = {}
        self._pending_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._id_lock = threading.Lock()
        self._stderr_tail: list[str] = []

    # -- lifecycle -----------------------------------------------------------
    def start(self) -> None:
        self.proc = subprocess.Popen(
            [self.command, *self.args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
            bufsize=1, env=self.env)
        threading.Thread(target=self._reader, daemon=True).start()
        threading.Thread(target=self._stderr_reader, daemon=True).start()
        self._request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "damar-cli", "version": "0.1.0"},
        })
        self._notify("notifications/initialized", {})
        result = self._request("tools/list", {})
        self.tools = result.get("tools", [])

    def stop(self) -> None:
        proc, self.proc = self.proc, None
        if proc is not None:
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    proc.kill()
                    proc.wait(timeout=2)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                try:
                    if pipe:
                        pipe.close()
                except OSError:
                    pass

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    # -- JSON-RPC plumbing ---------------------------------------------------
    def _reader(self) -> None:
        stdout = self.proc.stdout if self.proc else None
        if stdout is None:
            return
        for line in stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(message, dict) and isinstance(message.get("id"), int):
                with self._pending_lock:
                    waiter = self._pending.get(message["id"])
                if waiter is not None:
                    waiter.put(message)
        with self._pending_lock:
            waiters = list(self._pending.values())
        for waiter in waiters:
            waiter.put({"__eof__": True})

    def _stderr_reader(self) -> None:
        stderr = self.proc.stderr if self.proc else None
        if stderr is None:
            return
        for line in stderr:
            self._stderr_tail.append(line.rstrip())
            if len(self._stderr_tail) > 40:
                del self._stderr_tail[:-40]

    def _send(self, payload: dict) -> None:
        if self.proc is None or self.proc.stdin is None:
            raise MCPError(f"{self.name}: server is not running")
        try:
            with self._write_lock:
                self.proc.stdin.write(json.dumps(payload) + "\n")
                self.proc.stdin.flush()
        except OSError as exc:
            raise MCPError(f"{self.name}: write failed ({exc})") from exc

    def _notify(self, method: str, params: dict) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _request(self, method: str, params: dict) -> dict:
        with self._id_lock:
            self._next_id += 1
            request_id = self._next_id
        waiter: "queue.Queue[dict]" = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[request_id] = waiter
        try:
            self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
            try:
                message = waiter.get(timeout=self.timeout)
            except queue.Empty as exc:
                raise MCPError(f"{self.name}: timed out waiting for {method}") from exc
            if message.get("__eof__"):
                raise MCPError(f"{self.name}: server exited during {method}")
            if "error" in message:
                detail = message["error"]
                raise MCPError(f"{self.name}: {detail.get('message', detail)}")
            result = message.get("result", {})
            return result if isinstance(result, dict) else {"value": result}
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)

    # -- tools ---------------------------------------------------------------
    def call(self, tool: str, arguments: dict) -> str:
        result = self._request("tools/call", {"name": tool, "arguments": arguments})
        parts: list[str] = []
        for item in result.get("content", []):
            if not isinstance(item, dict):
                parts.append(str(item))
            elif item.get("type") == "text":
                parts.append(str(item.get("text", "")))
            else:
                parts.append(f"[{item.get('type', 'content')}]")
        text = "\n".join(part for part in parts if part) or "(no content)"
        if result.get("isError"):
            text = "MCP error: " + text
        return text


class MCPManager:
    """Owns every configured server and maps mcp__<server>__<tool> names."""

    PREFIX = "mcp__"

    def __init__(self, config: Optional[dict] = None) -> None:
        self.servers: dict[str, MCPServer] = {}
        self.notes: list[str] = []
        for name, spec in (config or {}).items():
            if isinstance(spec, dict) and spec.get("command"):
                self.servers[str(name)] = MCPServer(
                    str(name), str(spec["command"]), spec.get("args"), spec.get("env"))

    def start(self) -> list[str]:
        for server in self.servers.values():
            try:
                server.start()
                self.notes.append(f"mcp {server.name}: {len(server.tools)} tool(s)")
            except (OSError, MCPError) as exc:
                self.notes.append(f"mcp {server.name}: unavailable ({exc})")
        return self.notes

    def stop(self) -> None:
        for server in self.servers.values():
            server.stop()

    def tool_schemas(self) -> list[dict]:
        schemas: list[dict] = []
        for server in self.servers.values():
            for tool in server.tools:
                schemas.append({"type": "function", "function": {
                    "name": self.tool_name(server.name, tool.get("name", "?")),
                    "description": f"[MCP {server.name}] "
                                   + str(tool.get("description") or tool.get("name", "")),
                    "parameters": tool.get("inputSchema") or {"type": "object", "properties": {}},
                }})
        return schemas

    @classmethod
    def tool_name(cls, server: str, tool: str) -> str:
        return f"{cls.PREFIX}{server}__{tool}"

    def call(self, name: str, arguments_json: str) -> str:
        parts = name.split("__", 2)
        if len(parts) != 3:
            return f"Error: bad MCP tool name {name}"
        server = self.servers.get(parts[1])
        if server is None:
            return f"Error: unknown MCP server {parts[1]}"
        try:
            arguments = json.loads(arguments_json or "{}")
        except json.JSONDecodeError as exc:
            return f"Error: bad arguments JSON ({exc})"
        try:
            return server.call(parts[2], arguments if isinstance(arguments, dict) else {})
        except MCPError as exc:
            return f"Error: {exc}"
