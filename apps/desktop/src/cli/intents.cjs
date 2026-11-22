'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const actions = new Set(['plan', 'revise', 'approve', 'execute', 'verify', 'revoke', 'cancel', 'supervisor-on', 'supervisor-off']);
const identity = /^[A-Za-z0-9_-]{1,128}$/;
function validate(record) {
  const allowed = ['schema', 'operationId', 'sessionId', 'runtimeId', 'action', 'state', 'createdAt'];
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).sort().join() !== allowed.sort().join() || record.schema !== 1 ||
      !['HELD', 'RECONCILING'].includes(record.state) || !actions.has(record.action) ||
      !['operationId', 'sessionId', 'runtimeId'].every(key => typeof record[key] === 'string' && identity.test(record[key])) ||
      !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) throw Error('INVALID_INTENT_HOLD_REQUIRED');
  return record;
}
class IntentStore {
  constructor(directory) {
    if (!path.isAbsolute(directory)) throw Error('ABSOLUTE_INTENT_STORE_REQUIRED');
    this.directory = directory;
  }
  list() {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory).filter(name => name.endsWith('.json')).map(name => {
      try {
        const record = validate(JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8')));
        if (name !== record.operationId + '.json') throw Error('INTENT_ID_MISMATCH');
        return record;
      } catch { throw Error('CORRUPT_INTENT_HOLD_REQUIRED'); }
    });
  }
  begin({ sessionId, runtimeId, action }) {
    const record = validate({ schema: 1, operationId: crypto.randomUUID(), sessionId, runtimeId,
      action, state: 'HELD', createdAt: Date.now() });
    fs.mkdirSync(this.directory, { recursive: true });
    // Exclusive creation is both the competing-client gate and the crash marker.
    const lock = path.join(this.directory, 'mutation.lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx'); }
    catch { throw Error('MUTATION_HELD_RECONCILE_REQUIRED'); }
    try {
      fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd);
      if (this.list().length) throw Error('PRIOR_INTENT_HELD_RECONCILE_REQUIRED');
      const target = path.join(this.directory, record.operationId + '.json');
      const marker = fs.openSync(target, 'wx');
      try { fs.writeFileSync(marker, JSON.stringify(record)); fs.fsyncSync(marker); }
      finally { fs.closeSync(marker); }
      return record;
    } finally { fs.closeSync(fd); }
  }
  acknowledge(operationId, { runtimeId, action }) {
    // Only the process holding this exact durable operation may release the CLI gate.
    // This never changes service jobs, grants, worker locks or INFLIGHT reservations.
    const guard = path.join(this.directory, 'reconciliation.lock');
    let fd;
    try { fd = fs.openSync(guard, 'wx'); }
    catch { throw Error('RECONCILIATION_BUSY_HOLD_REQUIRED'); }
    try {
      fs.writeFileSync(fd,JSON.stringify({schema:1,pid:process.pid,operationId,nonce:crypto.randomUUID()}));fs.fsyncSync(fd);
      const lock = path.join(this.directory, 'mutation.lock');
      const record = validate(JSON.parse(fs.readFileSync(lock, 'utf8')));
      if (record.operationId !== operationId || record.runtimeId !== runtimeId || record.action !== action)
        throw Error('INTENT_BINDING_MISMATCH');
      const marker = path.join(this.directory, operationId + '.json');
      const archive = path.join(this.directory, 'confirmed');
      const target = path.join(archive, operationId + '.json');
      const pending = validate(JSON.parse(fs.readFileSync(fs.existsSync(marker) ? marker : target, 'utf8')));
      if (JSON.stringify(pending) !== JSON.stringify(record)) throw Error('INTENT_BINDING_MISMATCH');
      fs.mkdirSync(archive, { recursive: true });
      if (fs.existsSync(target)) {
        let receipt;
        try { receipt = validate(JSON.parse(fs.readFileSync(target, 'utf8'))); }
        catch { throw Error('CORRUPT_RECEIPT_HOLD_REQUIRED'); }
        if (JSON.stringify(receipt) !== JSON.stringify(record)) throw Error('RECEIPT_BINDING_MISMATCH');
      }
      // Archive first. A crash at any later point retains the lock or the receipt, never replays a request.
      if (!fs.existsSync(target)) {
        const receipt = fs.openSync(target, 'wx');
        try { fs.writeFileSync(receipt, JSON.stringify(record)); fs.fsyncSync(receipt); }
        finally { fs.closeSync(receipt); }
      }
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
      fs.unlinkSync(lock);
    } finally { fs.closeSync(fd); fs.unlinkSync(guard); }
  }
  recoverAcknowledgementGuard() {
    // Recover only a provably dead local CLI's reconciliation guard, never its mutation hold.
    // A separate exclusive recovery sentinel serializes readers against one another.
    const sentinel=path.join(this.directory,'guard-recovery.lock');
    let fd;
    try{fd=fs.openSync(sentinel,'wx');}catch{throw Error('GUARD_RECOVERY_BUSY_HOLD_REQUIRED');}
    try{
      const guard=path.join(this.directory,'reconciliation.lock');
      let owner;
      try{owner=JSON.parse(fs.readFileSync(guard,'utf8'));}catch{throw Error('GUARD_OWNER_UNKNOWN_HOLD_REQUIRED');}
      if(!owner||typeof owner!=='object'||Array.isArray(owner)||Object.keys(owner).sort().join()!=='nonce,operationId,pid,schema'||owner.schema!==1||!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.operationId!=='string'||!identity.test(owner.operationId)||typeof owner.nonce!=='string'||!identity.test(owner.nonce))throw Error('GUARD_OWNER_UNKNOWN_HOLD_REQUIRED');
      try{process.kill(owner.pid,0);throw Error('GUARD_OWNER_ALIVE_HOLD_REQUIRED');}
      catch(error){if(error.code!=='ESRCH')throw error;}
      // No new acknowledgement can acquire guard while this same file still exists.
      // Recheck its bytes before unlink; cooperating recovery callers hold the sentinel.
      const current=JSON.parse(fs.readFileSync(guard,'utf8'));
      if(current.nonce!==owner.nonce||current.pid!==owner.pid)throw Error('GUARD_OWNER_CHANGED_HOLD_REQUIRED');
      fs.unlinkSync(guard);
      return {state:'CLI_GUARD_RECOVERED',mutationHold:'UNCHANGED',operationId:owner.operationId};
    }finally{fs.closeSync(fd);fs.unlinkSync(sentinel);}
  }
}
module.exports = { IntentStore, validate };
