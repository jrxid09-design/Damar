'use strict';
const fs = require('node:fs');
const path = require('node:path');
function install(root) {
  const base = path.resolve(root);
  function check(value) {
    if (typeof value === 'number') return; // Handles are opened through the guarded open functions.
    const target = path.resolve(String(value));
    if (target !== base && !target.toLowerCase().startsWith(base.toLowerCase() + path.sep)) throw Error('R7R3_WRITE_OUTSIDE_SCRATCH');
    for (let p = target;; p = path.dirname(p)) {
      if (fs.existsSync(p) && (fs.lstatSync(p).isSymbolicLink() || fs.realpathSync.native(p).toLowerCase() !== p.toLowerCase())) throw Error('R7R3_REPARSE_REFUSED');
      if (path.dirname(p) === p) break;
    }
  }
  check(base);
  for (const name of ['writeFileSync','appendFileSync','mkdirSync','unlinkSync','rmdirSync','rmSync','truncateSync']) {
    const original = fs[name]; fs[name] = function(target,...args) { check(target); return original.call(fs,target,...args); };
  }
  for (const name of ['renameSync','copyFileSync']) {
    const original = fs[name]; fs[name] = function(from,to,...args) { if (name === 'renameSync') check(from); check(to); return original.call(fs,from,to,...args); };
  }
  const open = fs.openSync;
  fs.openSync = function(target,flags,...args) {
    if (typeof flags !== 'string' || /[wa+]/.test(flags)) check(target);
    return open.call(fs,target,flags,...args);
  };
  return check;
}
module.exports = { install };
