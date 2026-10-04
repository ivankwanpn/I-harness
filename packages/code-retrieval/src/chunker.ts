import ts from 'typescript'
import type { CodeFileSnapshot, CodeHit } from './types.ts'
export type Chunk = Omit<CodeHit,'generation'|'score'>
/** Boundaries are UTF-16 offsets into unchanged admitted text. AST statements
 * only suggest cut points; every chunk is one contiguous slice. */
export function* chunks(file: CodeFileSnapshot): Generator<Chunk> {
  const text=file.text, boundaries=new Set<number>()
  if(/\.[cm]?[jt]sx?$/i.test(file.path)) {
    const ast=ts.createSourceFile(file.path,text,ts.ScriptTarget.Latest,false)
    for(const statement of ast.statements) boundaries.add(statement.end)
  }
  let start=0, line=1
  while(start<text.length) {
    let end=start, bytes=0, cut=start
    while(end<text.length) {
      const point=text.codePointAt(end)!, width=point>0xffff?2:1, size=Buffer.byteLength(text.slice(end,end+width))
      if(bytes+size>4096) break
      bytes+=size; end+=width
      if(text[end-1]==='\n'||boundaries.has(end)) cut=end
    }
    if(end<text.length && cut>start) end=cut
    const slice=text.slice(start,end), newlines=(slice.match(/\n/g)??[]).length
    yield {sourceId:file.sourceId,path:file.path,revision:file.revision,text:slice,startOffset:start,endOffset:end,
      startLine:line,endLine:line+newlines-(slice.endsWith('\n')?1:0)}
    line+=newlines; start=end
  }
}
/** Terms retain whole identifiers, split camel/snake words, and index CJK
 * characters and bigrams so SQLite's ASCII-oriented token boundaries do not
 * lose Chinese recall. */
export function terms(text: string): string[] {
  const result=new Set<string>()
  for(const part of [text,text.replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/_/g,' ')])
    for(const token of part.toLowerCase().match(/[\p{L}\p{N}_]+/gu)??[]) {
      if(token.length<=256) result.add(token)
      for(const run of token.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)??[]) {
        const chars=[...run]
        for(let i=0;i<chars.length;i++) { result.add(chars[i]); if(i+1<chars.length) result.add(chars[i]+chars[i+1]) }
      }
    }
  return [...result]
}
