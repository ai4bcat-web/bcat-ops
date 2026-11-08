import { describe, expect, it } from 'vitest';
import { createCsvParser } from './csvStream.mjs';

function parse(chunks) {
  const rows = [];
  const p = createCsvParser((r) => rows.push(r));
  for (const c of chunks) p.write(c);
  p.end();
  return rows;
}

describe('createCsvParser', () => {
  it('handles quotes, escaped quotes, embedded newlines and commas', () => {
    expect(parse(['a,"b,1","c ""q""\nline2",\nx,y,z\n'])).toEqual([
      ['a', 'b,1', 'c "q"\nline2', ''],
      ['x', 'y', 'z'],
    ]);
  });

  it('handles CRLF, BOM and a missing final newline', () => {
    expect(parse(['\ufeffh1,h2\r\n1,2\r\n3,"4"'])).toEqual([['h1', 'h2'], ['1', '2'], ['3', '4']]);
  });

  it('gives identical results when chunk boundaries split quotes, CRLF and the BOM', () => {
    const text = '\ufeffa,"x""y"\r\n"p\r\nq",b\r\n';
    const whole = parse([text]);
    const bytewise = parse([...text]);
    expect(bytewise).toEqual(whole);
    expect(whole).toEqual([['a', 'x"y'], ['p\r\nq', 'b']]);
  });

  it('keeps a trailing empty field and an empty quoted last field', () => {
    expect(parse(['a,\nb,""\n'])).toEqual([['a', ''], ['b', '']]);
  });
});
