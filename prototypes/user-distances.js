// ── User-authored distance store (Plan 2 Option E) ───────────────────────
//
// Holds the most-recent DISTANCE rest-length per unordered {a,b} node pair.
// Populated from the user-actions.csv log on startup and kept up-to-date
// via local drag emission + cross-tab SSE rebroadcast. GraphPhysics reads
// the Map each tick and applies a spring force to each pair (see index.html
// section "2b. User-authored distance springs").
//
// Self-contained: zero DOM, zero fetch. The index.html page wires it to
// fetch + script-tag globals; tests load it as a CommonJS module.
//
// Exported API:
//   userDistances: Map<pairKey, {dist, t}>    shared mutable state
//   updateUserDistance(a, b, dist, t) → bool  true if the entry was updated
//   _pairKey(a, b) → string                   canonical unordered-pair key
//   parseCSVLine(line) → string[]             minimal RFC-4180-ish parser
//   ingestUserActionsCSV(text) → number       count of DISTANCE rows applied
(function (root) {
  'use strict';

  const userDistances = new Map();

  function _pairKey(a, b) {
    return a < b ? a + '\x00' + b : b + '\x00' + a;
  }

  function updateUserDistance(a, b, dist, t) {
    if (!a || !b || a === b) return false;
    const d = Number(dist);
    const ts = Number(t);
    if (!isFinite(d) || d < 0) return false;
    if (!isFinite(ts)) return false;
    const key = _pairKey(a, b);
    const prev = userDistances.get(key);
    if (prev && prev.t >= ts) return false;
    userDistances.set(key, { dist: d, t: ts });
    return true;
  }

  function parseCSVLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else current += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { fields.push(current); current = ''; }
        else current += ch;
      }
    }
    fields.push(current);
    return fields;
  }

  // Parse a user-actions.csv (t,type,label,source,target,importance_xi,cluster)
  // and apply every DISTANCE row through updateUserDistance. Header row is
  // assumed at line 0 and skipped. Other row types are ignored here — this
  // module only owns the distance-spring subset of the user-action stream.
  function ingestUserActionsCSV(text) {
    const lines = text.trim().split('\n');
    let applied = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const f = parseCSVLine(line);
      if (f[1] !== 'DISTANCE') continue;
      if (updateUserDistance(f[3], f[4], f[5], f[0])) applied++;
    }
    return applied;
  }

  const api = { userDistances, updateUserDistance, _pairKey, parseCSVLine, ingestUserActionsCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.userDistancesModule = api;
})(typeof window !== 'undefined' ? window : null);
