'use strict';
// Windowless shortcut target (Start menu, run-at-login): runs "damar <presence|control>" with no console window,
// shows an error box if it fails, then quits. Usage: electron.exe release/gui-launch presence|control
const { app, dialog } = require('electron');
const path = require('node:path');
const { execFile } = require('node:child_process');

const HOME = path.resolve(__dirname, '..', '..');
const action = process.argv.slice(1).find(a => a === 'presence' || a === 'control');
app.on('window-all-closed', () => {});
app.whenReady().then(() => {
  if (!action) { dialog.showErrorBox('DAMAR', 'Unknown shortcut action.'); return app.quit(); }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  execFile(path.join(HOME, 'inherited-v53', 'node.exe'), [path.join(HOME, 'release', 'damar.cjs'), action], { cwd: HOME, env, windowsHide: true, timeout: 180000 },
    (error, stdout, stderr) => {
      if (error) dialog.showErrorBox('DAMAR ' + action, (String(stderr || '') + '\n' + error.message).trim().slice(-1800));
      app.quit();
    });
});
