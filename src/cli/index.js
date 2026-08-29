#!/usr/bin/env node

// Alias env lama AETHER_* -> DAMAR_* (deprecated; kanonik = DAMAR_*).
require("../config/envCompat");

const readline = require("node:readline");

const DaemonClient = require("./client");
const { c, symbols, banner } = require("./theme");
const commands = require("./commands");

/** Proses terowongan SSH aktif (dibunuh saat CLI keluar). */
let sshTunnel = null;

/**
 * Damar CLI — antarmuka terminal untuk Damar.
 *
 * Berperan sama seperti Console desktop: klien tipis ke daemon.
 * Ngobrol dengan streaming, cek status, kelola model, telusuri
 * memori, jalankan tool — semuanya dari terminal.
 */

function parseArgs(argv) {

    const args = { url: null, token: null, once: null, serve: false, ssh: null, mode: null };

    for (let i = 0; i < argv.length; i++) {

        const arg = argv[i];

        if (arg === "--url" || arg === "-u") {
            args.url = argv[++i];
        }
        else if (arg === "--token" || arg === "-t") {
            args.token = argv[++i];
        }
        else if (arg === "--ssh" || arg === "-s") {
            // Remote: user@host[:remotePort] — daemon Damar di sana
            // dijangkau lewat terowongan SSH lokal.
            args.ssh = argv[++i];
        }
        else if (arg === "--serve") {
            // Jalankan daemon CLI sendiri di port 3001 (DAMAR_ROLE=cli)
            // — bisa bersamaan dengan daemon Console di 3000.
            args.serve = true;
        }
        else if (arg === "--help" || arg === "-h") {
            args.help = true;
        }
        else if (i === 0 && !arg.startsWith("-")) {

            // SUBCOMMAND global (hanya argumen pertama):
            //   damar console → daemon + Console desktop (launcher)
            //   damar cli     → REPL interaktif (perilaku default)
            if (arg === "console" || arg === "gui") {
                args.mode = "console";
                continue;
            }
            if (arg === "cli" || arg === "repl") {
                args.mode = "cli";
                continue;
            }

            // Selain itu = satu pertanyaan sekali jalan (mode pipa).
            args.once = argv.slice(i).join(" ");
            break;

        }
        else if (!arg.startsWith("-")) {
            // Sisa argumen = satu pertanyaan sekali jalan (mode pipa).
            args.once = argv.slice(i).join(" ");
            break;
        }

    }

    return args;

}

function usage() {

    console.log(`
${c.text("Damar CLI")}

${c.muted("Pemakaian:")}
  damar console              ${symbols.dot} daemon + Console desktop (GUI)
  damar cli                  ${symbols.dot} mode interaktif terminal
  damar "pertanyaan"         ${symbols.dot} tanya sekali lalu keluar
  echo "teks" | damar        ${symbols.dot} baca dari pipa
  damar --serve              ${symbols.dot} nyalakan daemon CLI (port 3001)
  damar --ssh user@host      ${symbols.dot} remote: daemon Damar di host lain

${c.muted("Opsi:")}
  -u, --url <url>              alamat daemon (default auto: 3001 → 3000)
  -t, --token <token>          DAMAR_TOKEN bila daemon dikunci
  -s, --ssh <user@host[:port]> sambungkan lewat terowongan SSH ke daemon
                                  remote (port daemon dianggap 3000)
  --serve                      jalankan daemon CLI sendiri — bisa
                               bersamaan dengan daemon Console (3000)
  -h, --help                   tampilkan bantuan ini

${c.muted("Port per peran:")}
  daemon Console  ${symbols.dot} 3000  (damar console / DAMAR_ROLE=console)
  daemon CLI      ${symbols.dot} 3001  (damar cli --serve / DAMAR_ROLE=cli)

${c.muted("Env:")}
  DAMAR_URL, DAMAR_TOKEN, DAMAR_ROLE, PORT
`);

}

async function main() {

    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
        usage();
        return;
    }

    // `damar console` — daemon + Console desktop via launcher.
    // Bisa dipanggil dari folder mana pun: launcher dijalankan di
    // folder instalasi Damar (src/cli → root = ../..).
    if (args.mode === "console") {
        const { spawn } = require("node:child_process");
        const path = require("node:path");
        const root = path.join(__dirname, "..", "..");
        const launcher = process.platform === "win32"
            ? spawn(process.execPath, [path.join(root, "scripts", "launch.js"), "--console"], {
                cwd: root, stdio: "inherit", env: { ...process.env, DAMAR_ROLE: "console" }
            })
            : spawn("node", [path.join(root, "scripts", "launch.js"), "--console"], {
                cwd: root, stdio: "inherit", env: { ...process.env, DAMAR_ROLE: "console" }
            });
        launcher.on("exit", code => process.exit(code ?? 0));
        return;
    }

    // `damar cli` — perilaku sama dengan tanpa subcommand (REPL).

    // --serve: nyalakan daemon CLI (port 3001) lalu sambungkan.
    if (args.serve) {
        console.log(c.muted("  menyalakan daemon CLI di port 3001…"));
        require("node:child_process").spawn(
            process.execPath,
            [require("node:path").join(__dirname, "..", "..", "src", "server.js"), "--role", "cli"],
            { stdio: "inherit" }
        );
        // Tunggu server siap sebelum klien menyapa.
        await new Promise(r => setTimeout(r, 1500));
        process.env.DAMAR_ROLE = "cli";
        process.env.DAMAR_URL = process.env.DAMAR_URL || "http://localhost:3001";
    }

    // --ssh: buka terowongan SSH ke daemon remote.
    if (args.ssh) {
        const { localPort } = await openSshTunnel(args.ssh);
        if (!localPort) {
            process.exitCode = 1;
            return;
        }
        // arahkan klien ke terowongan lokal
        args.url = `http://localhost:${localPort}`;
    }

    const client = new DaemonClient({ url: args.url, token: args.token });

    // Baca dari pipa bila ada (echo "..." | damar).
    const piped = await readPipedInput();

    const oneShot = args.once ?? piped;

    // Sesi percakapan; disimpan agar model punya konteks.
    const session = {
        client,
        messages: [],
        model: null,
        provider: null,
        aborter: null
    };

    if (!(await ensureDaemon(client, { quiet: Boolean(oneShot) }))) {
        process.exitCode = 1;
        return;
    }

    // Ambil provider/model aktif untuk ditampilkan & dipakai.
    try {
        const providers = await client.providers();
        session.provider = providers.active;
        session.model = providers.defaultModel;
    }
    catch {
        // Tidak fatal; chat tetap pakai default daemon.
    }

    if (oneShot) {
        await commands.chat(session, oneShot, { stream: !piped ? true : true });
        process.stdout.write("\n");
        return;
    }

    console.log(banner({
        version: client.version ?? "",
        url: client.baseUrl,
        provider: session.provider ?? "",
        model: session.model ?? ""
    }));

    console.log(
        `  ${symbols.spark} ${c.muted("ketik")} ${c.cyan("/help")} ${c.muted("untuk perintah — langsung ngobrol, atau")} ${c.cyan("/exit")} ${c.muted("untuk keluar.")}\n`
    );

    await repl(session);

}

/** Loop baca-eval-cetak. */
function repl(session) {

    return new Promise(resolve => {

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: `${c.amber("◆")} ${c.cyanS("›")} `,
            historySize: 200
        });

        session.rl = rl;

        rl.prompt();

        rl.on("line", async (line) => {

            const input = line.trim();

            if (!input) {
                rl.prompt();
                return;
            }

            // Ctrl-C saat streaming membatalkan jawaban, bukan CLI.
            try {

                if (input.startsWith("/")) {

                    const done = await commands.handle(session, input);

                    if (done === "exit") {
                        rl.close();
                        return;
                    }

                }
                else {
                    await commands.chat(session, input);
                }

            }
            catch (error) {
                console.log(`  ${symbols.err} ${c.danger(error.message)}`);
            }

            rl.prompt();

        });

        rl.on("close", () => {
            console.log(`\n${c.muted("  Sampai jumpa.")} ${symbols.damar}\n`);
            resolve();
        });

        // Ctrl-C: kalau ada stream jalan, batalkan; kalau tidak, keluar.
        rl.on("SIGINT", () => {

            if (session.aborter) {
                session.aborter.abort();
                session.aborter = null;
                console.log(c.dim("\n  (dibatalkan)"));
                rl.prompt();
            }
            else {
                rl.close();
            }

        });

    });

}

/**
 * Terowongan SSH ke daemon Damar remote.
 *
 * Bentuk target: user@host[:remotePort]  (remotePort default 3000).
 * Port lokal dipilih acak bebas; `ssh -N -L` dijalankan sebagai
 * proses anak — ikut mati saat CLI keluar (stdio inherit agar
 * permintaan kunci/host-key terlihat).
 */
async function openSshTunnel(target) {

    const { spawn } = require("node:child_process");
    const net = require("node:net");

    // parse user@host:port
    const match = String(target).match(/^(?:([^@]+)@)?([A-Za-z0-9._-]+)(?::(\d+))?$/);

    if (!match) {
        console.log(`  ${symbols.err} ${c.danger(`Target SSH tidak dipahami: ${target}`)} ${c.dim("(pakai user@host[:port])")}`);
        return { localPort: null };
    }

    const [, user, host, remotePort = "3000"] = match;

    // cari port lokal bebas
    const localPort = await new Promise(resolve => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });

    const sshTarget = user ? `${user}@${host}` : host;

    console.log(`${c.muted("  terowongan SSH ke")} ${c.text(sshTarget)} ${c.muted(`:${remotePort} → localhost:${localPort}…`)}`);

    const child = spawn("ssh", [
        "-N",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30",
        "-L", `${localPort}:127.0.0.1:${remotePort}`,
        sshTarget
    ], { stdio: ["ignore", "inherit", "inherit"] });

    sshTunnel = child;

    // tunggu terowongan siap: cek koneksi lokal sampai hidup
    const ready = await new Promise(resolve => {

        let tries = 0;

        const attempt = () => {

            tries++;

            const sock = net.connect(localPort, "127.0.0.1");

            sock.once("connect", () => { sock.destroy(); resolve(true); });

            sock.once("error", () => {
                sock.destroy();
                if (tries > 40) resolve(false);          // ±20 detik
                else setTimeout(attempt, 500);
            });

        };

        setTimeout(attempt, 600);

    });

    if (!ready) {
        console.log(`  ${symbols.err} ${c.danger("Terowongan SSH gagal dibuka — periksa kunci/host.")}`);
        child.kill();
        return { localPort: null };
    }

    // Terowongan ikut mati bersama CLI.
    process.on("exit", () => { try { child.kill(); } catch { /* abaikan */ } });

    console.log(`  ${symbols.ok} ${c.ok("terowongan siap")}`);

    return { localPort };

}

async function ensureDaemon(client, { quiet = false } = {}) {

    if (await client.ping()) {
        return true;
    }

    if (!quiet) {
        console.log(banner());
    }

    console.log(
        `  ${symbols.err} ${c.danger("Daemon Damar tidak terjangkau di")} ${c.text(client.baseUrl)}\n`
    );
    console.log(`  ${c.muted("Jalankan daemon dulu di terminal lain:")}`);
    console.log(`     ${c.amber("damar --serve")} ${c.dim("(daemon CLI, port 3001)")}\n`);
    console.log(`  ${c.muted("Atau arahkan CLI ke alamat lain:")}`);
    console.log(`     ${c.amber("damar --url http://192.168.1.20:3000")}\n`);
    console.log(`  ${c.muted("Daemon di mesin lain? Terowongan SSH:")}`);
    console.log(`     ${c.amber("damar --ssh user@namahost")}\n`);

    return false;

}

function readPipedInput() {

    return new Promise(resolve => {

        // Tidak ada pipa (stdin adalah TTY) → interaktif.
        if (process.stdin.isTTY) {
            return resolve(null);
        }

        let data = "";

        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => (data += chunk));
        process.stdin.on("end", () => resolve(data.trim() || null));

        // Jangan menggantung bila stdin tidak pernah menutup.
        setTimeout(() => resolve(data.trim() || null), 500).unref?.();

    });

}

main().catch(error => {
    console.error(`${symbols.err} ${c.danger(error.stack ?? error.message)}`);
    process.exit(1);
});
