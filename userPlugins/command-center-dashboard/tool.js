// Skill buatan Aether Skill Factory — jangan sunting manual.
class SkillImpl {

  constructor() {
    this.name = 'commandCenterDashboard';
    this.description = 'Membangun ulang dashboard Command Center menjadi tampilan admin yang hidup dan ringan: agregasi status sistem, runtime, dan event terbaru menjadi satu payload JSON ringkas dan reaktif.';
    this.parameters = {
      section: { type: 'string', description: 'Bagian dashboard: overview | system | runtime | events | health', required: false },
      limit: { type: 'string', description: 'Jumlah maksimum event terbaru (default 20)', required: false }
    };
  }

  async execute(args) {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');

    const section = (args && args.section) ? String(args.section).toLowerCase() : 'overview';
    let limit = parseInt(args && args.limit ? args.limit : '20', 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 20;
    if (limit > 200) limit = 200;

    const now = Date.now();

    // --- SYSTEM ---
    const cpus = os.cpus();
    const load = os.loadavg();
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const memUsed = memTotal - memFree;
    const memUsedPct = memTotal ? Math.round((memUsed / memTotal) * 1000) / 10 : 0;
    const uptimeSec = os.uptime();
    const procMem = process.memoryUsage();

    const system = {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      uptimeSeconds: uptimeSec,
      uptimeHuman: this._humanUptime(uptimeSec),
      cpuCount: cpus.length,
      cpuModel: cpus.length ? cpus[0].model : 'unknown',
      loadAvg1: load[0],
      loadAvg5: load[1],
      loadAvg15: load[2],
      memory: {
        totalBytes: memTotal,
        usedBytes: memUsed,
        freeBytes: memFree,
        usedPercent: memUsedPct
      }
    };

    // --- RUNTIME ---
    const runtime = {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      memory: {
        rssBytes: procMem.rss,
        heapUsedBytes: procMem.heapUsed,
        heapTotalBytes: procMem.heapTotal,
        externalBytes: procMem.external
      },
      heapUsedMB: Math.round((procMem.heapUsed / 1048576) * 100) / 100,
      activeHandles: this._safeCount(() => process._getActiveHandles().length),
      activeRequests: this._safeCount(() => process._getActiveRequests().length)
    };

    // --- HEALTH ---
    const checks = [];
    const memOk = memUsedPct < 90;
    const loadOk = load[0] < cpus.length * 2;
    const heapOk = procMem.heapUsed < (os.totalmem() * 0.5);
    checks.push({ name: 'memory', ok: memOk, detail: memUsedPct + '%' });
    checks.push({ name: 'load', ok: loadOk, detail: load[0].toFixed(2) });
    checks.push({ name: 'heap', ok: heapOk, detail: runtime.heapUsedMB + 'MB' });
    const health = {
      status: checks.every(c => c.ok) ? 'healthy' : (checks.some(c => c.ok) ? 'degraded' : 'critical'),
      checks,
      timestamp: now
    };

    // --- EVENTS (ringan, dari audit log bila ada) ---
    const events = [];
    try {
      const candidates = [
        path.join(process.cwd(), 'data', 'audit'),
        path.join(process.cwd(), 'logs')
      ];
      let latest = null;
      for (const dir of candidates) {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') || f.endsWith('.json') || f.endsWith('.log')).map(f => ({ f, p: path.join(dir, f) }));
          for (const ent of files) {
            try {
              const st = fs.statSync(ent.p);
              if (!latest || st.mtimeMs > latest.mtimeMs) latest = ent;
            } catch (_) {}
          }
        }
      }
      if (latest) {
        const raw = fs.readFileSync(latest.p, 'utf8');
        const lines = raw.split(/\r?\n/).filter(Boolean).slice(-limit);
        for (const line of lines) {
          let obj = null;
          try { obj = JSON.parse(line); } catch (_) { obj = { raw: line.slice(0, 200) }; }
          events.push({ ts: obj.ts || obj.time || obj.timestamp || null, type: obj.type || obj.event || 'log', source: latest.f, summary: (obj.message || obj.action || obj.raw || JSON.stringify(obj)).toString().slice(0, 160) });
        }
        events.reverse();
      }
    } catch (_) {}

    const payload = { ok: true, generatedAt: now, section };

    if (section === 'system') payload.system = system;
    else if (section === 'runtime') payload.runtime = runtime;
    else if (section === 'events') payload.events = events;
    else if (section === 'health') payload.health = health;
    else {
      payload.system = system;
      payload.runtime = runtime;
      payload.health = health;
      payload.events = events;
      payload.summary = {
        status: health.status,
        cpuCount: system.cpuCount,
        memUsedPercent: system.memory.usedPercent,
        heapUsedMB: runtime.heapUsedMB,
        eventCount: events.length
      };
    }

    payload.hasil = 'Dashboard Command Center (' + section + ') dibangun ulang: ringan, reaktif, tanpa dependensi eksternal.';
    return payload;
  }

  _humanUptime(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return (d ? d + 'd ' : '') + h + 'h ' + m + 'm ' + s + 's';
  }

  _safeCount(fn) {
    try { return fn(); } catch (_) { return null; }
  }

}

class Tool {
    constructor() {
        this._impl = new SkillImpl();
        this.name = "COMMANDCENTERDASHBOARD";
        this.description = "Membangun ulang dashboard Command Center menjadi tampilan admin yang hidup dan ringan dengan mengagregasi status sistem, metrik runtime, dan event terbaru menjadi satu payload JSON ringkas yang siap dirender secara reaktif tanpa dependensi berat.";
        this.parameters = {
    section: {"type":"string","description":"Bagian dashboard yang ingin difokuskan: 'overview' (semua), 'system', 'runtime', 'events', atau 'health'. Bila kosong akan mengembalikan seluruh bagian.","required":false},
    limit: {"type":"string","description":"Jumlah maksimum entri event terbaru yang dikembalikan (default '20').","required":false}
        };
    }
    // Kontrak plugin: execute(context, params).
    // Pilih sumber args yang benar: params utama; context
    // kadang membawa args saat pemanggil legacy.
    async execute(context, params) {
        const args = (params && typeof params === 'object' && !Array.isArray(params) && Object.keys(params).length)
            ? params
            : (context && typeof context === 'object' && !Array.isArray(context) && Object.keys(context).length)
                ? context
                : {};
        return this._impl.execute(args);
    }
}
module.exports = [new Tool()];
