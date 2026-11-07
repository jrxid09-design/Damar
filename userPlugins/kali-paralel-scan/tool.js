// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class KaliParallelScanTool {

    constructor() {
        this.name = "kaliParallelScan";
        this.description = "Scan multiple IPs in parallel from Kali WSL with OS detection and service fingerprinting. Returns consolidated results.";
        this.parameters = {};
    }

    async execute(context, args = {}) {
        const { execSync } = require('child_process');
        const ips = Array.isArray(args.ips) ? args.ips : [args.ips];
        const results = {};

        for (const ip of ips) {
          try {
            const cmd = `wsl -d kali-linux -u root bash -c "nmap -sV -O --osscan-guess -T4 ${ip} 2>&1"`;
            const out = execSync(cmd, { timeout: 120000, encoding: 'utf8', windowsHide: true });
            const lines = out.split('\n');
            results[ip] = {
              mac: lines.find(l => l.includes('MAC Address')),
              os: lines.find(l => l.includes('OS details') || l.includes('Running') || l.includes('Aggressive OS')),
              ports: lines.filter(l => l.match(/^\d+\/\w+\s+open/)),
              android: out.includes('Android') || out.includes('Samsung'),
              full: out
            };
          } catch (e) {
            results[ip] = { error: e.stderr || e.message };
          }
        }
        return results;
    }

}

module.exports = [ new KaliParallelScanTool() ];
