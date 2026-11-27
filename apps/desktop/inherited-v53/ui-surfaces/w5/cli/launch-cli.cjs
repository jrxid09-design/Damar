const { spawn, execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const ENTRYPOINT = path.join(path.dirname(__dirname), 'cli_damar', 'damar.py');
async function resolvePython() {
  const failures = [];
  for (const name of ['py.exe', 'python.exe', 'python3.exe']) {
    const candidates = name === 'py.exe' && process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Launcher', name)] : [];
    const executable = findExecutable(name, candidates);
    if (!executable) continue;
    const args = name === 'py.exe' ? ['-3', '-X', 'utf8'] : ['-X', 'utf8'];
    try {
      const version = await new Promise((resolve, reject) => execFile(executable, [...args, '-c', 'import sys, rich; assert sys.version_info >= (3, 9); print(sys.version.split()[0])'], { shell: false, windowsHide: true, timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
      return { executable, args, version };
    } catch { failures.push(name); }
  }
  throw new Error('Python 3.9+ with rich is required for the owner CLI. No packages were installed.' + (failures.length ? ' Checked: ' + failures.join(', ') : ''));
}
function findExecutable(name, candidates = []) {
  return [...candidates, ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name))]
    .find(file => path.isAbsolute(file) && existsSync(file));
}
function start(executable, args, windowsVerbatimArguments = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: path.dirname(__dirname), shell: false, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
async function launchDamarCli() {
  if (process.platform !== 'win32') throw new Error('This prototype launcher requires Windows.');
  if (process.env.DAMAR_PRIVATE_SESSION) {
    const launcher=path.resolve(__dirname,'../../../scripts/OPEN_DAMAR_CLI.ps1');
    if (!existsSync(launcher)) throw new Error('Private CLI launcher is missing.');
    const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    await start(powershell,['-NoProfile','-NoExit','-File',launcher,'-Session',process.env.DAMAR_PRIVATE_SESSION,'-Console']);
    return {host:'DAMAR session-bound PowerShell'};
  }
  if (!existsSync(ENTRYPOINT)) throw new Error('DAMAR CLI entrypoint is missing.');
  const python = await resolvePython();
  const previewArgs = process.env.DAMAR_UI_OFFLINE_PREVIEW === '1' ? ['--offline-preview'] : [];
  // Windows App Execution Aliases can launch successfully even when fs.existsSync reports false.
  const wt = findExecutable('wt.exe') || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe') : null);
  if (wt) {
    try {
      await start(wt, ['-w', 'new', 'new-tab', '--title', 'DAMAR CLI', '--suppressApplicationTitle', '--', python.executable, ...python.args, ENTRYPOINT, ...previewArgs]);
      return { host: 'Windows Terminal', pythonVersion: python.version };
    } catch (error) {
      console.warn('Windows Terminal launch failed; trying dedicated DAMAR console:', error.message);
    }
  }
  // START allocates a real console for the fixed Python entrypoint; /c exits the helper.
  // No instruction text ever enters this command line, and no shell prompt is retained.
  if (/["%!\r\n]/.test(python.executable + ENTRYPOINT)) throw new Error('CLI fallback paths contain unsupported characters.');
  const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  await start(cmd, ['/d', '/s', '/c', `start "DAMAR CLI" "${python.executable}" ${python.args.join(' ')} "${ENTRYPOINT}" ${previewArgs.join(' ')}`], true);
  return { host: 'Windows console (fixed CLI entrypoint)', pythonVersion: python.version };
}
module.exports = { launchDamarCli };
