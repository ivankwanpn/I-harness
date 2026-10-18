import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from '../../../node_modules/typescript/lib/typescript.js';
const historical = JSON.parse(fs.readFileSync('docs/research/2026-10-13-v0.1.13/census.json','utf8'));
const map = fs.readFileSync('docs/refactoring/v0.1.13-decomposition-map.md','utf8');
const tasks = new Map();
for(const line of map.split(/\r?\n/)) {
  const match = /^\|(S\d+)\|`([^`]+)`/.exec(line);
  if(match) tasks.set(match[2], { task: match[1], status: line.endsWith('|pending|') ? 'pending' : 'reviewed' });
}
const files = execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const exts = new Set(historical.method.extensions);
function product(file) {
  if(!exts.has(path.extname(file))) return false;
  return !/(^|\/)(node_modules|out|dist|build|target|coverage|generated|releases?|vendor|third_party|third-party|vendored|docs?|references?|fixtures?|snapshots?|testdata|__tests__|tests?|e2e|scripts?)(\/|$)|(^|\/)release[^/]*\/|\.generated\.|\.(test|spec)\.[^.]+$/.test(file);
}
function measure(file) {
  const content=fs.readFileSync(file,'utf8'), lines=content.split(/\r?\n/); if(lines.at(-1)==='')lines.pop();
  const functions=[];
  if(/\.[cm]?[jt]sx?$/.test(file)) {
    const sf=ts.createSourceFile(file,content,ts.ScriptTarget.Latest,true,file.endsWith('x')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    function walk(node) {
      if(ts.isFunctionDeclaration(node)||ts.isFunctionExpression(node)||ts.isArrowFunction(node)||ts.isMethodDeclaration(node)||ts.isConstructorDeclaration(node)||ts.isGetAccessorDeclaration(node)||ts.isSetAccessorDeclaration(node)) {
        const parent=node.parent, start=sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1,end=sf.getLineAndCharacterOfPosition(node.getEnd()).line+1;
        const name=node.name?.getText(sf) ?? (ts.isVariableDeclaration(parent)||ts.isPropertyAssignment(parent)?parent.name.getText(sf):ts.isCallExpression(parent)?parent.expression.getText(sf).slice(0,90)+' callback':'<anonymous>');
        functions.push({name,start,end,lines:end-start+1,characters:node.getWidth(sf)});
      }
      ts.forEachChild(node,walk);
    }
    walk(sf);
  }
  const largest=functions.toSorted((a,b)=>b.lines-a.lines)[0];
  const findings=functions.filter(x=>x.lines>=250||(x.lines<250&&x.characters>=18000));
  return {path:file,lines:lines.length,bytes:Buffer.byteLength(content),...(largest?{largestFunction:largest}:{}),findings};
}
const current=files.filter(product).map(measure);
const byPath=new Map(current.map(x=>[x.path,x]));
const original=historical.candidateAnalysis.map(row=>({ ...tasks.get(row.path),originalPath:row.path,baselineLines:row.lines,current:byPath.get(row.path)??measure(row.path)}));
const originalPaths=new Set(original.map(x=>x.originalPath));
const flagged=current.filter(x=>x.lines>=800||x.findings.length);
const extra=flagged.filter(x=>!originalPaths.has(x.path));
const result={baseline:historical.head,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),measuredAt:new Date().toISOString(),method:{...historical.method,scope:'Tracked maintained product files only; test/script/vendor/generated excluded; scripts directories excluded at every depth. Rust embedded tests remain included in physical line totals and require manual product-only review. JS/TS function AST includes nested spans; measurements are candidate flags, not completion verdicts.'},summary:{originalFiles:original.length,reviewedOriginalFiles:original.filter(x=>x.status==='reviewed').length,pendingOriginalFiles:original.filter(x=>x.status==='pending').length,pendingTasks:new Set(original.filter(x=>x.status==='pending').map(x=>x.task)).size,currentProductFiles:current.length,currentFlaggedFiles:flagged.length,extraFlaggedFiles:extra.length},original,extraFlagged:extra};
fs.writeFileSync(new URL('./census.json', import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result.summary));
for(const row of original.filter(x=>x.status==='pending'))console.log(JSON.stringify({task:row.task,path:row.originalPath,baseline:row.baselineLines,current:row.current.lines,largest:row.current.largestFunction}));
console.log('Additional current flags outside original paths:');
for(const row of extra)console.log(JSON.stringify({path:row.path,lines:row.lines,largest:row.largestFunction}));
