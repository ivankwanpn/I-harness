import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';

const root=process.cwd(), errors=[];
const json=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const digest=b=>createHash('sha256').update(b).digest('hex');
const hash=p=>digest(fs.readFileSync(p));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:20*1024*1024});
const trees=new Map();
function blobs(ref){if(!trees.has(ref))trees.set(ref,new Map(git('ls-tree','-r',ref).trim().split('\n').map(l=>{const [meta,p]=l.split('\t');return[p,meta.split(' ')[2]]})));return trees.get(ref)}
function check(condition,label){if(!condition)errors.push(label)}
const original=json('.tmp/r4b-b1-20261022/final-source.json');
const initialEvidence=json('.tmp/r4b-b1-20261022/final-verification.json');
const first=json('.tmp/r4b-b1-fix1-20261023/final-manifest.json');
const second=json('.tmp/r4b-b1-fix2-20261023/final-manifest.json');
const latest=new Map();let historicalBlobChecks=0,logChecks=0;
for(const [m,rows] of [[original,original.files],[first,first.files],[second,second.files]]){
  const tree=blobs(m.head);
  for(const f of rows){const blob=f.gitBlob??f.blob;check(tree.get(f.path)===blob,`historical blob ${m.head}:${f.path}`);historicalBlobChecks++;latest.set(f.path,{...f,blob,sha256:f.sha256??f.worktreeSha256});}
}
const current=blobs(second.head);
for(const [p,f]of latest){check(current.get(p)===f.blob,`latest blob ${p}`);check(hash(p)===f.sha256,`latest bytes ${p}`);}
const changed=git('diff','--name-only',original.base,second.head).trim().split('\n').filter(p=>!p.startsWith('docs/')).sort();
check(JSON.stringify(changed)===JSON.stringify([...latest.keys()].sort()),'complete product range inventory');
for(const [base,logs] of [['.tmp/r4b-b1-20261022',initialEvidence.inventory],['.tmp/r4b-b1-fix1-20261023',first.logs],['.tmp/r4b-b1-fix2-20261023',second.logs]])for(const f of logs){const p=path.join(base,f.path??f.file),b=fs.readFileSync(p);check(b.length===f.bytes&&digest(b)===f.sha256,`log ${p}`);logChecks++;}
for(const f of [...first.oldReports,...first.sealed,...second.reports])check(hash(f.path)===f.sha256,`preserved ${f.path}`);
for(const f of second.reusedPredecessor.files)check(hash(f.path)===f.sha256,`reused predecessor ${f.path}`);

const fixture='packages/session-persistence-jsonl/test/fixtures/format10-predecessor';
const manifest=json(path.join(fixture,'manifest.json')), compressed=fs.readFileSync(path.join(fixture,'graph.json.gz'));
check(compressed.length===manifest.compressedBytes&&digest(compressed)===manifest.capsuleSha256,'capsule');
const decoded=gunzipSync(compressed,{maxOutputLength:2*1024*1024});check(decoded.length===manifest.decodedBytes,'decoded byte count');
const capsule=JSON.parse(decoded.toString('utf8')), entries=new Map();
for(const f of capsule.files){check(!entries.has(f.path),'duplicate capsule entry');entries.set(f.path,Buffer.from(f.base64,'base64'));}
check(entries.size===178&&manifest.files.length===178,'capsule entry count');
const oldMap=json('.tmp/r4hc-02/gateway-source-copy-map.json'), oldPaths=new Map(oldMap.pairs.map(f=>[path.resolve(f.candidate).toLowerCase(),f]));
let graphChecks=0,total=0;
for(const f of manifest.files){const b=entries.get(f.path);check(!!b&&b.length===f.bytes&&digest(b)===f.sha256,`capsule file ${f.path}`);if(!b)continue;total+=b.length;
  if(f.path==='LICENSE'){const license=execFileSync('git',['show',`${manifest.product}:LICENSE`],{cwd:root});check(digest(license)===f.sha256,'pinned root license');check(hash(path.join(fixture,'LICENSE'))===f.sha256,'visible fixture license');continue;}
  const old=path.resolve('.tmp/r4hc-02/g',f.path);const mapped=oldPaths.get(old.toLowerCase());check(mapped?.sha256===f.sha256&&hash(old)===f.sha256,`genuine predecessor ${f.path}`);graphChecks++;
}
check(graphChecks===177&&total===manifest.totalFileBytes,'old graph totals');
check(git('rev-parse','HEAD').trim()===second.head,'current HEAD');
const dirty=git('diff','--name-only').trim().split('\n').filter(Boolean);check(dirty.every(p=>p.startsWith('docs/')),'only root docs dirty');
const report={kind:'static source/evidence/capsule audit; no product execution',head:second.head,historicalBlobChecks,currentProductFiles:latest.size,logs:logChecks,reusedPredecessorFiles:second.reusedPredecessor.files.length,capsuleFiles:entries.size,genuineOldGraphFiles:graphChecks,totalCapsuleFileBytes:total,dirty,errors};
fs.writeFileSync('.superpowers/sdd/2026-10-22-context-r4b-semantic-inheritance/root-b1-final-audit.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));if(errors.length)process.exitCode=1;
