#!/bin/bash
# Start the tools dev server (depgraph + focus SSE)
cd "$(dirname "$0")"
code ./codegen/graphgen.mjs
code ./codegen/historygen.mjs
./stream/start_stream.sh &
# python3 codegen/codemap.py --update
node depgraph-server.mjs "$@"
