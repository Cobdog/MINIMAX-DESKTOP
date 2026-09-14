# Python realism stub for scripts/test-runtime.cjs: a real interpreter running
# a real `main.py --listen 127.0.0.1 --port N --disable-auto-launch` argv from
# a checkout directory — same observable contract as runtime-stub.cjs (serves
# /system_stats, logs a line, never reads stdin). Used ONLY when a usable
# python3/python exists; the suite skips this section with a logged note
# otherwise (CI ubuntu/windows runners both have python).
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port = 0
for index, arg in enumerate(sys.argv):
    if arg == '--port' and index + 1 < len(sys.argv):
        port = int(sys.argv[index + 1])
if not port:
    sys.stderr.write('runtime-stub.py: --port is required\n')
    sys.exit(2)

print(json.dumps({'level': 'info', 'msg': 'boot', 'fixture': 'runtime-stub.py', 'port': port, 'pid': __import__('os').getpid()}), flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/system_stats':
            body = json.dumps({'system': {'os': 'stub-py'}, 'devices': []}).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass


print(json.dumps({'level': 'info', 'msg': 'ready'}), flush=True)
ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
