from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os
import sys
import webbrowser

os.chdir(Path(__file__).resolve().parent)
class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.js': 'application/javascript', '.mjs': 'application/javascript', '.wasm': 'application/wasm'}

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8877
server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
url = f'http://127.0.0.1:{port}/'
print(f'GrainScope: {url}', flush=True)
if '--open' in sys.argv:
    webbrowser.open(url)
server.serve_forever()
