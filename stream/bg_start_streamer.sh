node stream/streamer.mjs --interval=200 --mode=tick &
PID=$!
sleep 1
curl -s -N http://127.0.0.1:3801/stream 2>&1 | head -8
curl -s http://127.0.0.1:3801/ 2>&1
kill $PID 2>/dev/null