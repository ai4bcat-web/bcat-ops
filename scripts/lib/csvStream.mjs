// Minimal streaming RFC-4180 CSV parser: quoted fields, "" escapes, embedded
// newlines, CRLF/LF/CR row ends, leading UTF-8 BOM. Push text chunks, receive rows.

export function createCsvParser(onRow) {
  let field = '';
  let row = [];
  let inQuotes = false;
  let pendingQuote = false; // saw a quote while inQuotes; next char decides escape vs close
  let skipLf = false; // previous char was CR
  let atStart = true;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    const r = row;
    row = [];
    onRow(r);
  };

  function write(chunk) {
    let i = 0;
    if (atStart && chunk.length) {
      if (chunk.charCodeAt(0) === 0xfeff) i = 1;
      atStart = false;
    }
    for (; i < chunk.length; i++) {
      const c = chunk[i];
      if (skipLf) {
        skipLf = false;
        if (c === '\n') continue;
      }
      if (pendingQuote) {
        pendingQuote = false;
        if (c === '"') {
          field += '"';
          continue;
        }
        inQuotes = false; // closing quote; fall through to handle c unquoted
      }
      if (inQuotes) {
        if (c === '"') pendingQuote = true;
        else field += c;
        continue;
      }
      if (c === '"' && !fieldStarted) {
        inQuotes = true;
        fieldStarted = true;
      } else if (c === ',') {
        endField();
      } else if (c === '\n') {
        endRow();
      } else if (c === '\r') {
        endRow();
        skipLf = true;
      } else {
        field += c;
        fieldStarted = true;
      }
    }
  }

  function end() {
    if (pendingQuote) {
      pendingQuote = false;
      inQuotes = false;
    }
    if (fieldStarted || field !== '' || row.length) endRow();
  }

  return { write, end };
}
