# History Schema (Phase 10a — frozen)

`runtime/history.csv` is the only authoritative runtime file (SPEC §4). Every
fact about the graph and every user action is one row in this file. This
document freezes the schema. Producers and the runtime alike must reject rows
that do not match.

## Columns

```
t,type,op,id,kind,source,target,layer,weight,label,payload
```

| Field    | Type    | Required for                | Notes |
|----------|---------|-----------------------------|-------|
| `t`      | number  | always                      | monotonic timestamp; replay cursor key |
| `type`   | string  | always                      | one of `NODE`, `EDGE` |
| `op`     | string  | always                      | one of `add`, `update`, `remove` |
| `id`     | string  | always                      | node id or `source->layer->target` |
| `kind`   | string  | NODE add                    | `function`, `global`, `cluster`, `file`, `directory`, `image`, `script`, `dependency`, `json-file`, `json-key`, `markdown-file`, `heading`, `user-action`, ... |
| `source` | string  | EDGE add                    | edge endpoint |
| `target` | string  | EDGE add                    | edge endpoint |
| `layer`  | string  | EDGE add                    | `calls`, `reads`, `writes`, `memberOf`, `contains`, `depends`, `next`, `spatial`, `pinned`, ... |
| `weight` | number  | optional                    | numeric strength; producers default to 1–5 |
| `label`  | string  | optional                    | display label |
| `payload`| JSON    | optional                    | stringified JSON; producers stash file path, line number, author, etc. |

## Validation rules (enforced by `data/csv.js`'s `validateRow()`)

1. `type` must be `NODE` or `EDGE`.
2. `op` must be `add`, `update`, or `remove`.
3. `id` must be a non-empty string.
4. `t` (when present) must be a finite number.
5. `EDGE add` requires `source`, `target`, and `layer`.

Producers that emit a row failing any rule are dropped silently with a stderr
warning — they are bugs, not data.

## Conventions for built-in producers (Phase 10b–10f)

- **AST producer** (`codegen/ast.mjs`)
  - File: id `file:<rel>`, kind `file`, payload `{ path, lines, language }`.
  - Function: id `file:<rel>#<name>`, kind `function`, payload `{ file, line, endLine, exported }`.
  - Global: id `file:<rel>#<name>`, kind `global`, payload `{ file, line, declKind }`.
  - Edges: `calls`, `reads`, `writes`, `memberOf`.

- **Codemap producer** (`codegen/codemap.mjs`)
  - Cluster: id `cluster:<section>`, kind `cluster`.
  - Function: id `<name>` (raw), kind `function`, payload `{ line, author }`.
  - Edges: `memberOf` (function → cluster).

- **Repo scanner** (`codegen/repo-scanner.mjs`, Phase 10f)
  - Directory: id `dir:<rel>`, kind `directory`. Root is `dir:.`.
  - File handlers: js/json/markdown/image/text. Each emits a `file:` (or richer)
    NODE plus child nodes/edges per their domain. Every file gets a
    `dir:<parent> --contains--> file:<rel>` edge.
  - JSON: `package.json` script entries → kind `script`, dependencies → kind `dependency`.
  - Markdown: `#`/`##`/... headings → kind `heading`, sibling headings linked by `next`.
  - Images: kind `image`, payload carries `src` so the renderer can draw it.

- **Live watcher** (`codegen/watcher.mjs`, Phase 10f)
  - Tags every diff row with `payload.author = 'watcher'`.
  - Emits `add`/`update`/`remove` rows so the runtime reacts incrementally.

## Why this is frozen

Adding fields breaks every replayer downstream (snapshot loader, agent
endpoints, branches). New per-producer metadata goes into `payload`, never
into a new column. If a future capability genuinely needs a new top-level
column, that is a schema migration: bump a version, ship a one-shot
upgrader, freeze again.
