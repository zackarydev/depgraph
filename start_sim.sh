#!/bin/bash
# Start the tools dev server (depgraph + focus SSE)
cd "$(dirname "$0")"
python3 codegen/codemap.py --update
node depgraph-server.mjs --simulate=1000
