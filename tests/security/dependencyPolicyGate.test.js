'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const patchRoot = path.resolve(__dirname, '../..');
const sourceRoot = process.env.DAMAR_CANDIDATE_ROOT || patchRoot;
const gate = path.join(patchRoot, 'scripts/check-dep-policy.js');
const policy = path.join(patchRoot, 'scripts/dependency-policy.json');
const shasum = s => crypto.createHash('sha256').update(s).digest('hex');
const run = (lock, opts={}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'damar-gate-'));
  const file = path.join(dir, 'package-lock.json');
  const pol = path.join(dir, 'policy.json');
  const json = typeof lock === 'string' ? lock : JSON.stringify(lock);
  fs.writeFileSync(file,json);
  fs.writeFileSync(pol, JSON.stringify(opts.policy ?? {allowedGitDeps: [], allowedProtocols: ['https:'], allowGitSsh: false}));
  const argv = [gate,file,'--policy',pol];
  let pkg = opts.pkg;
  if (!pkg) {
    pkg = path.join(dir, 'package.json');
    let x; try { x = JSON.parse(json); } catch { x = {}; }
    const rt = (x?.packages && x.packages['']) || {};
    fs.writeFileSync(pkg, JSON.stringify({dependencies:rt.dependencies||{}, devDependencies:rt.devDependencies||{}}));
  }
  if (!opts.omitPackage) argv.push('--package-json',pkg);
  if (!opts.noHash) argv.push('--lock-sha256',opts.badHash || shasum(json));
  if (!opts.noApproved) argv.push('--approved-lock-sha256',opts.approvedHash || shasum(json));
  if (opts.duplicateHash) argv.push('--lock-sha256',shasum(json));
  if (opts.duplicateApproved) argv.push('--approved-lock-sha256',shasum(json));
  if (opts.omitPolicy) argv.splice(argv.indexOf('--policy'),2);
  if (opts.reportOnly) argv.push('--report-only');
  const result = spawnSync(process.execPath,argv,{encoding:'utf8',env:{...process.env,CI:opts.ci===false?'false':'true',GITHUB_ACTIONS:'false'}});
  fs.rmSync(dir,{recursive:true,force:true});
  return result;
};
const normal = () => ({lockfileVersion:3, packages:{'':{dependencies:{'foo':'1.0.0'}},'node_modules/foo':{resolved:'https://registry.npmjs.org/foo/-/foo-1.0.0.tgz',integrity:'sha512-abc'}}});
const denied = (res,reason) => { assert.notEqual(res.status,0,`unexpected permit: ${res.stdout} ${res.stderr}`); assert.match(res.stderr,/POLICY_VIOLATION/); if(reason) assert.match(res.stderr,reason); assert.doesNotMatch(res.stderr,/TypeError|ReferenceError|SyntaxError:\s*(?!malformed lockfile)/); };

test('valid dependency graph accepted under CI when caller provides byte digest',()=>{const r=run(normal());assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/POLICY_OK/);});
test('g18: absent root is controlled policy violation, never a crash',()=>{const x=normal();delete x.packages[''];denied(run(x),/root packages/);});
test('g18: null root is controlled policy violation, never a crash',()=>{const x=normal();x.packages['']=null;denied(run(x),/root packages/);});
test('g18: malformed packages is controlled policy violation',()=>{const x=normal();x.packages=null;denied(run(x),/packages/);});
test('invalid package entry rejected, no uncaught crash',()=>{const x=normal();x.packages['node_modules/foo']=null;denied(run(x),/invalid package entry/);});
test('malformed JSON rejected',()=>denied(run('{invalid'),/malformed lockfile JSON/));
test('bad SHA digest rejected before parsing policy',()=>denied(run(normal(),{badHash:'0'.repeat(64)}),/digest mismatch/));
test('missing digest in CI rejected',()=>denied(run(normal(),{noHash:true}),/requires exactly one/));
test('duplicate digest in CI rejected',()=>denied(run(normal(),{duplicateHash:true}),/requires exactly one/));
test('CI --report-only cannot convert a violation to success',()=>{const x=normal();x.packages['node_modules/foo'].resolved='http://evil.example/foo';denied(run(x,{reportOnly:true}),/report-only refused/);});
test('nonregistry resolved URL rejected',()=>{const x=normal();x.packages['node_modules/foo'].resolved='https://evil.example/foo.tgz';denied(run(x),/NON_REGISTRY/);});
test('registry URL credential rejected',()=>{const x=normal();x.packages['node_modules/foo'].resolved='https://u:p@registry.npmjs.org/foo/-/foo.tgz';denied(run(x),/CREDENTIALS_IN_URL/);});
test('dangling mandatory edge rejected',()=>{const x=normal();x.packages[''].dependencies.bar='1.0';denied(run(x),/DANGLING_EDGE/);});
test('root-manifest package drift rejected',()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'damar-pkg-'));const pkg=path.join(d,'package.json');fs.writeFileSync(pkg,'{"dependencies":{"foo":"2.0.0"}}');try{denied(run(normal(),{pkg}),/LOCK_DRIFT/);}finally{fs.rmSync(d,{recursive:true,force:true});}});
test('checked-out candidate lock+package graph validates in CI (NOT proof of publisher)',()=>{const lock=fs.readFileSync(path.join(sourceRoot,'package-lock.json'),'utf8');const pkg=path.join(sourceRoot,'package.json');const r=run(lock,{policy:JSON.parse(fs.readFileSync(policy,'utf8')),pkg});assert.equal(r.status,0,r.stderr);});
test('CI workflow has pre-install gate and checksum argument',()=>{const s=fs.readFileSync(path.join(patchRoot,'.github/workflows/node.js.yml'),'utf8');const g=s.indexOf('node scripts/check-dep-policy.js');const i=s.indexOf('- run: npm ci');assert.ok(g>0 && i>g,'policy gate must precede npm ci');assert.match(s,/--lock-sha256/);assert.match(s,/--package-json/);assert.match(s,/--approved-lock-sha256/);assert.match(s,/DLOCK_APPROVED_LOCK_SHA256/);});

const evilSRI = 'sha512-' + Buffer.alloc(64,0x33).toString('base64');
const injectedEntry = {version:'9.9.9',resolved:'https://registry.npmjs.org/evil-pkg/-/evil-pkg-9.9.9.tgz',integrity:evilSRI};
test('g25 unreferenced package: independently pinned lock blocks self-consistent injection',()=>{
  const good=normal(); const bad=structuredClone(good);
  bad.packages['node_modules/evil-pkg']=structuredClone(injectedEntry);
  denied(run(bad,{approvedHash:shasum(JSON.stringify(good))}),/UNAPPROVED_LOCK_BYTES/);
});
test('g26 transitive poison: independently pinned lock blocks self-consistent dependency injection',()=>{
  const good=normal();const bad=structuredClone(good);
  bad.packages['node_modules/foo'].dependencies={'evil-pkg':'9.9.9'};
  bad.packages['node_modules/evil-pkg']=structuredClone(injectedEntry);
  denied(run(bad,{approvedHash:shasum(JSON.stringify(good))}),/UNAPPROVED_LOCK_BYTES/);
});
test('g25/g26 remain forgeable when attacker may choose the approved digest (external D required)',()=>{
  const bad=normal();bad.packages['node_modules/foo'].dependencies={'evil-pkg':'9.9.9'};
  bad.packages['node_modules/evil-pkg']=structuredClone(injectedEntry);
  const result=run(bad);assert.equal(result.status,0,result.stderr);
});
test('missing approved anchor refuses CI, before install',()=>denied(run(normal(),{noApproved:true}),/requires exactly one valid --approved-lock-sha256/));
test('malformed approved anchor refuses CI',()=>denied(run(normal(),{approvedHash:'g'.repeat(64)}),/requires exactly one valid --approved-lock-sha256/));
test('duplicate approved anchor refuses CI',()=>denied(run(normal(),{duplicateApproved:true}),/requires exactly one valid --approved-lock-sha256/));
test('missing policy refuses CI',()=>denied(run(normal(),{omitPolicy:true}),/CI requires one --policy/));
test('actual checked-out candidate unchanged lock accepted with independently pinned candidate digest',()=>{
  const lock=fs.readFileSync(path.join(sourceRoot,'package-lock.json'),'utf8');
  const pkg=path.join(sourceRoot,'package.json');
  const result=run(lock,{policy:JSON.parse(fs.readFileSync(policy,'utf8')),pkg,approvedHash:shasum(lock)});
  assert.equal(result.status,0,result.stderr);
});
test('actual checked-out candidate g25 orphan is rejected against approved unmodified bytes',()=>{
  const good=JSON.parse(fs.readFileSync(path.join(sourceRoot,'package-lock.json'),'utf8'));
  const bad=structuredClone(good);bad.packages['node_modules/evil-pkg']=structuredClone(injectedEntry);
  denied(run(bad,{policy:JSON.parse(fs.readFileSync(policy,'utf8')),approvedHash:shasum(fs.readFileSync(path.join(sourceRoot,'package-lock.json'),'utf8'))}),/UNAPPROVED_LOCK_BYTES/);
});
test('actual checked-out candidate g26 transitive injection rejected against approved unmodified bytes',()=>{
  const good=JSON.parse(fs.readFileSync(path.join(sourceRoot,'package-lock.json'),'utf8'));
  const bad=structuredClone(good);const key=Object.keys(bad.packages).find(k=>/node_modules\/axios$/.test(k));
  assert.ok(key,'axios transitive entry exists');
  bad.packages[key].dependencies={...(bad.packages[key].dependencies||{}),'evil-pkg':'9.9.9'};
  bad.packages['node_modules/evil-pkg']=structuredClone(injectedEntry);
  denied(run(bad,{policy:JSON.parse(fs.readFileSync(policy,'utf8')),approvedHash:shasum(fs.readFileSync(path.join(sourceRoot,'package-lock.json'),'utf8'))}),/UNAPPROVED_LOCK_BYTES/);
});
