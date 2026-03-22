#!/bin/bash
# Start the tools dev server (depgraph + focus SSE)
cd "$(dirname "$0")"
node depgraph-server.mjs "$@"
