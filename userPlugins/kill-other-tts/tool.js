// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class KillOtherTtsTool {

    constructor() {
        this.name = "killOtherTts";
        this.description = "Matikan semua layanan TTS selain ArdiNeural (port 8880): stop container Docker Kokoro jika berjalan, kill proses voice-server.js di port 8644, dan kill semua proses TTS lain yang bukan di port 8880. Hanya untuk Windows dengan PowerShell.";
        this.parameters = {
                "dryRun": {
                        "type": "boolean",
                        "description": "Jika true, hanya laporkan apa yang akan dimatikan tanpa benar-benar mematikan (simulasi).",
                        "required": false
                }
        };
    }

    async execute(context, args = {}) {
        const { execSync } = require('child_process');

        function ps(cmd, timeout = 8000) {
          try {
            return execSync(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`, {
              encoding: 'utf8', timeout, windowsHide: true
            }).trim();
          } catch { return ''; }
        }

        function cmd(c, timeout = 8000) {
          try {
            return execSync(c, { encoding: 'utf8', timeout, windowsHide: true }).trim();
          } catch { return ''; }
        }

        async function execute(args) {
          const dry = args.dryRun === true;
          const results = [];

          // ── 1. Docker stop kokoro ──────────────────────────────────
          try {
            // Nama kontainer kanonik kini `damar_kokoro`; ejaan lama
            // `aether_kokoro` tetap dicocokkan supaya kontainer yang
            // dibuat sebelum rename tetap bisa dihentikan.
            const psOut = cmd('docker ps --filter name=kokoro --format "{{.Names}}"');
            const nama = String(psOut || '')
              .split(/\r?\n/)
              .map(s => s.trim())
              .filter(s => s === 'damar_kokoro' || s === 'aether_kokoro');
            if (nama.length) {
              if (!dry) {
                for (const n of nama) {
                  cmd(`docker stop ${n}`, 12000);
                  cmd(`docker update --restart=no ${n}`);
                }
              }
              results.push({ target: 'docker_kokoro', action: dry ? 'would_stop' : 'stopped', names: nama });
            } else {
              results.push({ target: 'docker_kokoro', action: 'not_running' });
            }
          } catch (e) {
            results.push({ target: 'docker_kokoro', action: 'error', error: e.message });
          }

          // ── 2. Kill proses di port 8644 ────────────────────────────
          try {
            const net = cmd('netstat -ano | findstr ":8644 "');
            if (net) {
              const pids = new Set();
              for (const line of net.split('\r\n')) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
              }
              for (const pid of pids) {
                if (!dry) cmd(`taskkill /PID ${pid} /F`);
                results.push({ target: 'port_8644', pid, action: dry ? 'would_kill' : 'killed' });
              }
              if (pids.size === 0) {
                results.push({ target: 'port_8644', action: 'no_pids' });
              }
            } else {
              results.push({ target: 'port_8644', action: 'no_listener' });
            }
          } catch (e) {
            results.push({ target: 'port_8644', action: 'error', error: e.message });
          }

          // ── 3. Kill proses TTS lain yang BUKAN port 8880 ───────────
          try {
            const json = ps(
              `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'tts|voice|kokoro|aether-tts' -and $_.CommandLine -notmatch 'console' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`
            );
            let procs = [];
            if (json) {
              try {
                const parsed = JSON.parse(json);
                procs = Array.isArray(parsed) ? parsed : [parsed];
              } catch { /* ignore parse error */ }
            }

            if (procs.length === 0) {
              // Fallback: coba wmic
              const wmicOut = cmd('wmic process where "Name=\'node.exe\'" get ProcessId,CommandLine /format:csv 2>nul');
              if (wmicOut) {
                for (const line of wmicOut.split('\r\n')) {
                  const lower = line.toLowerCase();
                  if ((lower.includes('tts') || lower.includes('voice') || lower.includes('kokoro')) && !lower.includes('console')) {
                    const m = line.match(/(\d+)\s*$/);
                    if (m) procs.push({ ProcessId: parseInt(m[1]), CommandLine: line });
                  }
                }
              }
            }

            const killed = [];
            for (const p of procs) {
              const pid = String(p.ProcessId);
              const cl = (p.CommandLine || '').toLowerCase();

              // Skip proses yang listen di port 8880
              try {
                const netPid = cmd(`netstat -ano | findstr "${pid}"`);
                if (netPid && netPid.includes(':8880')) {
                  results.push({ target: 'tts_process', pid, action: 'skipped_port_8880', cmdline: cl.substring(0, 120) });
                  continue;
                }
              } catch {}

              if (!dry) cmd(`taskkill /PID ${pid} /F`);
              killed.push(pid);
              results.push({ target: 'tts_process', pid, action: dry ? 'would_kill' : 'killed', cmdline: cl.substring(0, 120) });
            }

            if (killed.length === 0 && results.filter(r => r.target === 'tts_process').length === 0) {
              results.push({ target: 'tts_process', action: 'none_found' });
            }
          } catch (e) {
            results.push({ target: 'tts_process', action: 'error', error: e.message });
          }

          return { ok: true, dry_run: dry, results };
        }

        module.exports = class Tool {
          constructor() {
            this.name = 'killOtherTts';
            this.description = 'Matikan semua TTS selain ArdiNeural: docker stop kokoro, kill voice-server port 8644, kill proses TTS bukan port 8880.';
            this.parameters = {
              dryRun: { type: 'boolean', description: 'Simulasi saja, tidak benar-benar kill', required: false }
            };
          }
          async execute(args) { return execute(args); }
        };
    }

}

module.exports = [ new KillOtherTtsTool() ];
