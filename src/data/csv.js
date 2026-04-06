/**
 * RFC 4180 CSV parser + writer for the unified history format.
 *
 * History schema: t,type,op,id,kind,source,target,layer,weight,label,payload
 * - payload is a JSON blob, stored as a quoted CSV field
 * - All fields are strings in CSV; numeric fields (t, weight) are parsed on read
 *
 * @module data/csv
 */

/** The canonical history CSV header. */
export const HEADER = 't,type,op,id,kind,source,target,layer,weight,label,payload';

/** Column names in order. */
export const COLUMNS = HEADER.split(',');

/**
 * Parse a single CSV line respecting RFC 4180 quoting.
 * Handles: quoted fields, escaped quotes (""), commas inside quotes, newlines inside quotes.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function parseLine(line) {
  const fields = [];
  let i = 0;
  const len = line.length;

  // empty line → single empty field
  if (len === 0) return [''];

  while (i <= len) {
    // we've consumed past the end — only happens if line ended with ','
    if (i === len) {
      fields.push('');
      break;
    }

    if (line[i] === '"') {
      // quoted field
      let value = '';
      i++; // skip opening quote
      while (i < len) {
        if (line[i] === '"') {
          if (i + 1 < len && line[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          value += line[i];
          i++;
        }
      }
      fields.push(value);
      if (i < len && line[i] === ',') {
        i++;
        // if comma was the last char, loop around to push empty
      } else {
        break; // no comma after quote → end of line
      }
    } else {
      // unquoted field
      const next = line.indexOf(',', i);
      if (next === -1) {
        fields.push(line.slice(i));
        break;
      } else {
        fields.push(line.slice(i, next));
        i = next + 1;
        // if comma was the last char, loop continues with i === len → push empty
      }
    }
  }

  return fields;
}

/**
 * Quote a CSV field if it contains commas, quotes, or newlines.
 * @param {string} value
 * @returns {string}
 */
export function quoteField(value) {
  if (value == null) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Convert an array of field values to a CSV line.
 * @param {string[]} fields
 * @returns {string}
 */
export function writeLine(fields) {
  return fields.map(quoteField).join(',');
}

/**
 * Parse a HistoryRow from an array of CSV field strings.
 * @param {string[]} fields
 * @returns {import('../core/types.js').HistoryRow}
 */
export function fieldsToRow(fields) {
  let payload = null;
  if (fields[10]) {
    try {
      payload = JSON.parse(fields[10]);
    } catch {
      payload = null;
    }
  }

  const weight = fields[8] !== '' ? Number(fields[8]) : undefined;

  return {
    t: Number(fields[0]),
    type: fields[1],
    op: fields[2],
    id: fields[3],
    kind: fields[4] || undefined,
    source: fields[5] || undefined,
    target: fields[6] || undefined,
    layer: fields[7] || undefined,
    weight: isNaN(weight) ? undefined : weight,
    label: fields[9] || undefined,
    payload,
  };
}

/**
 * Convert a HistoryRow to an array of CSV field strings.
 * @param {import('../core/types.js').HistoryRow} row
 * @returns {string[]}
 */
export function rowToFields(row) {
  return [
    String(row.t),
    row.type,
    row.op,
    row.id,
    row.kind || '',
    row.source || '',
    row.target || '',
    row.layer || '',
    row.weight != null ? String(row.weight) : '',
    row.label || '',
    row.payload ? JSON.stringify(row.payload) : '',
  ];
}

/**
 * Parse a full CSV string (with header) into an array of HistoryRows.
 * @param {string} text
 * @returns {import('../core/types.js').HistoryRow[]}
 */
export function parseCSV(text) {
  const rows = [];
  const lines = splitLines(text);

  // skip header if present
  let start = 0;
  if (lines.length > 0 && lines[0].startsWith('t,type,')) {
    start = 1;
  }

  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = parseLine(line);
    if (fields.length < 4) continue; // minimum: t, type, op, id
    rows.push(fieldsToRow(fields));
  }

  return rows;
}

/**
 * Write an array of HistoryRows to a CSV string (with header).
 * @param {import('../core/types.js').HistoryRow[]} rows
 * @returns {string}
 */
export function writeCSV(rows) {
  const lines = [HEADER];
  for (const row of rows) {
    lines.push(writeLine(rowToFields(row)));
  }
  return lines.join('\n') + '\n';
}

/**
 * Write a single row as a CSV line (no header, no trailing newline).
 * @param {import('../core/types.js').HistoryRow} row
 * @returns {string}
 */
export function writeRowLine(row) {
  return writeLine(rowToFields(row));
}

/**
 * Split text into lines, handling quoted fields that span multiple lines.
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  const lines = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if ((ch === '\n' || ch === '\r') && !inQuote) {
      if (ch === '\r' && text[i + 1] === '\n') i++; // CRLF
      if (current) lines.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current);

  return lines;
}

/**
 * Process CSV text line-by-line, calling callback for each parsed row.
 * Useful for large files — avoids building the full array.
 * @param {string} text
 * @param {function(import('../core/types.js').HistoryRow): void} callback
 */
export function streamLines(text, callback) {
  const lines = splitLines(text);
  let start = 0;
  if (lines.length > 0 && lines[0].startsWith('t,type,')) {
    start = 1;
  }
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = parseLine(line);
    if (fields.length < 4) continue;
    callback(fieldsToRow(fields));
  }
}
