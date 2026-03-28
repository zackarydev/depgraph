#!/bin/bash
# Start the tools dev server (depgraph + focus SSE)
cd "$(dirname "$0")"

# If running depgraph as code visualizer
# code ./codegen/graphgen.mjs
# code ./codegen/historygen.mjs
# python3 codegen/codemap.py --update

# For streaming:
./stream/start_stream.sh &

node depgraph-server.mjs "$@"
