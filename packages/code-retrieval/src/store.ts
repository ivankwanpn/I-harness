import { createHash } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Chunk } from './chunker.ts'
import { terms } from './chunker.ts'
import type { CodeHit } from './types.ts'

export interface StoredFile { sourceId:string; path:string; revision:string; hash:string; chunks:Chunk[] }
export interface StoredState { generation:number; files:number; chunks:number; storedBytes:number; partial:boolean; reasons:string[]; model:string }
const empty=():StoredState=>({generation:0,files:0,chunks:0,storedBytes:0,partial:false,reasons:[],model:''})
export const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
export class Store {
  private db?: DatabaseSync
  private opening?:Promise<void>
  private path:string
  constructor(root:string,workspace:string) { this.path=join(root,'code-retrieval',hash(workspace),'index.sqlite') }
  async open(maxDiskBytes:number):Promise<void> {
    if(this.db) return
    if(maxDiskBytes<128*1024)throw new Error('Code Context disk quota is too small for SQLite and its journal')
    if(!this.opening) this.opening=(async()=>{
      const {DatabaseSync}=await import('node:sqlite')
      mkdirSync(join(this.path,'..'),{recursive:true})
      const db=new DatabaseSync(this.path)
      try {
        db.exec(`PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;
          CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, generation INTEGER NOT NULL, reasons TEXT NOT NULL, model TEXT NOT NULL);
          INSERT OR IGNORE INTO meta VALUES(1,1,0,'[]','');
          CREATE TABLE IF NOT EXISTS files (source TEXT NOT NULL,path TEXT NOT NULL,revision TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(source,path));
          CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY,source TEXT NOT NULL,path TEXT NOT NULL,revision TEXT NOT NULL,text TEXT NOT NULL,startLine INTEGER NOT NULL,endLine INTEGER NOT NULL,startOffset INTEGER NOT NULL,endOffset INTEGER NOT NULL,FOREIGN KEY(source,path) REFERENCES files(source,path) ON DELETE CASCADE);
          CREATE TABLE IF NOT EXISTS terms (term TEXT NOT NULL,chunk INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,PRIMARY KEY(term,chunk));
          CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY,vector TEXT NOT NULL);
        `)
        if((db.prepare('SELECT version FROM meta').get() as {version:number}).version!==1) throw new Error('Unsupported Code Context index schema')
        this.db=db
      } catch(error) {db.close();throw error}
    })().finally(()=>{this.opening=undefined})
    await this.opening
  }
  status():StoredState {
    if(!this.db) return empty()
    const meta=this.db.prepare('SELECT generation,reasons,model FROM meta WHERE id=1').get() as {generation:number;reasons:string;model:string}
    const counts=this.db.prepare('SELECT (SELECT count(*) FROM files) AS files,(SELECT count(*) FROM chunks) AS chunks').get() as {files:number;chunks:number}
    const reasons=JSON.parse(meta.reasons) as string[]
    return {...meta,...counts,reasons,partial:reasons.length>0,storedBytes:statSync(this.path).size}
  }
  file(source:string,path:string):StoredFile|undefined {
    const row=this.db!.prepare('SELECT source AS sourceId,path,revision,hash FROM files WHERE source=? AND path=?').get(source,path) as unknown as Omit<StoredFile,'chunks'>|undefined
    return row?{...row,chunks:this.db!.prepare('SELECT source AS sourceId,path,revision,text,startLine,endLine,startOffset,endOffset FROM chunks WHERE source=? AND path=? ORDER BY startOffset').all(source,path) as unknown as Chunk[]}:undefined
  }
  vector(key:string):number[]|undefined {
    const row=this.db!.prepare('SELECT vector FROM vectors WHERE key=?').get(key) as {vector:string}|undefined
    return row?JSON.parse(row.vector) as number[]:undefined
  }
  vectorDimensions():number|undefined {
    // The actual dimension is durable in the vectors themselves, including
    // generations created before explicit dimension metadata existed.
    const rows=this.db!.prepare('SELECT DISTINCT json_array_length(vector) AS dimensions FROM vectors').all() as {dimensions:number}[]
    if(rows.length>1 || rows.some(row=>!Number.isInteger(row.dimensions)||row.dimensions<1||row.dimensions>8192))throw new Error('Inconsistent stored embedding dimensions; run a full rebuild')
    return rows[0]?.dimensions
  }
  outside(sources:string[]|undefined):{files:number;chunks:number} {
    if(!sources)return {files:0,chunks:0}
    const files=this.db!.prepare('SELECT source FROM files').all() as {source:string}[]
    const chunks=this.db!.prepare('SELECT source FROM chunks').all() as {source:string}[]
    return {files:files.filter(f=>!sources.includes(f.source)).length,chunks:chunks.filter(c=>!sources.includes(c.source)).length}
  }
  candidates(query:string,sourceIds?:string[],pathPrefix?:string):CodeHit[] {
    const keys=terms(query).slice(0,128)
    if(!keys.length) return []
    const filters=['t.term IN ('+keys.map(()=>'?').join(',')+')'], values:string[]=[...keys]
    if(sourceIds) {if(!sourceIds.length)return [];filters.push('c.source IN ('+sourceIds.map(()=>'?').join(',')+')');values.push(...sourceIds)}
    if(pathPrefix) {filters.push("(c.path=? OR substr(c.path,1,?)=?)");values.push(pathPrefix,String([...pathPrefix].length+1),pathPrefix+'/')}
    return this.db!.prepare(`SELECT c.source AS sourceId,c.path,c.revision,c.text,c.startLine,c.endLine,c.startOffset,c.endOffset,count(*) AS score FROM terms t JOIN chunks c ON c.id=t.chunk WHERE ${filters.join(' AND ')} GROUP BY c.id ORDER BY score DESC,c.source,c.path,c.startOffset`).all(...values) as unknown as CodeHit[]
  }
  all(sourceIds?:string[],pathPrefix?:string):CodeHit[] {
    return (this.db!.prepare('SELECT source AS sourceId,path,revision,text,startLine,endLine,startOffset,endOffset,0 AS score FROM chunks').all() as unknown as CodeHit[])
      .filter(c=>(!sourceIds||sourceIds.includes(c.sourceId))&&(!pathPrefix||c.path===pathPrefix||c.path.startsWith(pathPrefix+'/')))
  }
  commit(files:StoredFile[],sources:string[]|undefined,reasons:string[],model:string,vectors:Map<string,number[]>,maxDiskBytes:number,check:()=>void):void {
    const db=this.db!, before=this.status()
    // DELETE journal can temporarily duplicate changed pages. Reserve half of
    // the workspace disk budget for that journal, including an allocation page.
    const page=(db.prepare('PRAGMA page_size').get() as {page_size:number}).page_size
    const pages=Math.floor((maxDiskBytes-page)/2/page)
    if(pages<1 || before.storedBytes>pages*page) throw new Error('Code Context disk quota exceeded')
    db.exec(`PRAGMA max_page_count=${pages}; BEGIN IMMEDIATE`)
    try {
      const insertChunk=db.prepare('INSERT INTO chunks(source,path,revision,text,startLine,endLine,startOffset,endOffset) VALUES(?,?,?,?,?,?,?,?)')
      const insertTerm=db.prepare('INSERT OR IGNORE INTO terms VALUES(?,?)')
      const staged=new Set(files.map(f=>JSON.stringify([f.sourceId,f.path])))
      for(const old of db.prepare('SELECT source,path FROM files').all() as {source:string;path:string}[])
        if((!sources||sources.includes(old.source))&&!staged.has(JSON.stringify([old.source,old.path])))db.prepare('DELETE FROM files WHERE source=? AND path=?').run(old.source,old.path)
      for(const file of files) {
        check()
        const old=this.file(file.sourceId,file.path)
        if(old?.hash===file.hash&&old.revision===file.revision&&old.chunks.length===file.chunks.length&&(old.chunks.at(-1)?.endOffset??0)===(file.chunks.at(-1)?.endOffset??0))continue
        db.prepare('DELETE FROM files WHERE source=? AND path=?').run(file.sourceId,file.path)
        db.prepare('INSERT INTO files VALUES(?,?,?,?)').run(file.sourceId,file.path,file.revision,file.hash)
        for(const chunk of file.chunks) {
          check()
          const inserted=insertChunk.run(chunk.sourceId,chunk.path,chunk.revision,chunk.text,chunk.startLine,chunk.endLine,chunk.startOffset,chunk.endOffset)
          for(const term of terms(chunk.text)) insertTerm.run(term,inserted.lastInsertRowid)
        }
      }
      if(before.model!==model) db.exec('DELETE FROM vectors')
      for(const [key,vector] of vectors) db.prepare('INSERT OR REPLACE INTO vectors VALUES(?,?)').run(key,JSON.stringify(vector))
      // Keep only vectors for current content. Scoped refresh retains vectors
      // belonging to other admitted sources, while deletions reclaim cache.
      const live=new Set(this.all().map(c=>hash(model+'\0'+c.text)))
      for(const row of db.prepare('SELECT key FROM vectors').all() as {key:string}[]) if(!live.has(row.key)) db.prepare('DELETE FROM vectors WHERE key=?').run(row.key)
      db.prepare('UPDATE meta SET generation=?,reasons=?,model=? WHERE id=1').run(before.generation+1,JSON.stringify(reasons),model)
      check()
      db.exec('COMMIT')
    } catch(error) {if(db.isTransaction)db.exec('ROLLBACK');throw error}
  }
  clear():void {
    if(!this.db)return
    this.db.exec("BEGIN IMMEDIATE; DELETE FROM files; DELETE FROM vectors; UPDATE meta SET generation=0,reasons='[]',model='' WHERE id=1; COMMIT; VACUUM")
  }
  close():void {this.db?.close();this.db=undefined}
}
