// Dibuat oleh Damar ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class ScanCctvNetworkTool {

    constructor() {
        this.name = "scanCctvNetwork";
        this.description = "Scans a given IP network range for open ports commonly used by CCTV cameras (RTSP/ONVIF: 554, 80, 8080, 1935). Returns list of live IPs and open ports.";
        this.parameters = {
                "network": {
                        "type": "string",
                        "description": "IP network range to scan (e.g., 192.168.1.0/24)"
                },
                "ports": {
                        "type": "string",
                        "description": "Comma-separated list of ports to scan (default: 554,80,8080,1935)",
                        "default": "554,80,8080,1935"
                }
        };
    }

    async execute(context, args = {}) {
        const { exec } = require('child_process');
        return (args) => {
          const { network, ports } = args;
          const cmd = `nmap -p ${ports} ${network}`;
          return exec(cmd, (error, stdout) => {
            if (error) return { error: error.message };
            return { stdout: stdout.trim() };
          });
        };
    }

}

module.exports = [ new ScanCctvNetworkTool() ];
