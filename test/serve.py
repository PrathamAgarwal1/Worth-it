"""Test server: runs the real extension code on a fake YouTube page.

    python test/serve.py            # then open http://localhost:8765/

/ and /watch serve the mock YouTube SPA; extension pages (report, popup) get the chrome.* stub
injected so they work outside Chrome. Test-only: never needed to use the extension.
"""
import http.server
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STUB = '<script src="/test/chrome-stub.js"></script><script src="/src/hooks.js"></script>' \
       '<script src="/src/model.js"></script><script src="/src/demo.js"></script><script src="/src/store.js"></script>' \
       '<script>if (/[?&]demo=1/.test(location.search)) chrome.runtime.sendMessage({ type: "loadDemo" });</script>'


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def _send_html(self, html: str):
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/watch"):
            return self._send_html((ROOT / "test" / "mock-youtube.html").read_text(encoding="utf-8"))
        if path in ("/report/report.html", "/popup/popup.html"):
            html = (ROOT / path.lstrip("/")).read_text(encoding="utf-8")
            return self._send_html(html.replace("<body>", "<body>" + STUB, 1))
        return super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("127.0.0.1", 8765), Handler) as httpd:
        print("Mock YouTube on http://localhost:8765/")
        httpd.serve_forever()
