#!/bin/bash
# Start the tools dev server (depgraph + focus SSE)
cd "$(dirname "$0")"
# code ./codegen/historygen.mjs
# python3 codegen/codemap.py --update
node depgraph-server.mjs "$@"
