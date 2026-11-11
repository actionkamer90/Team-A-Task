"""Customer logos: who can upload, what is accepted, and who can see them.
Run: python -m unittest discover -s tests -v"""
import base64
import os
import struct
import sys
import unittest
import zlib

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_api  # noqa: E402  (starts the test server and sets TT_DB)


def png(w, h):
    """A valid w × h PNG (solid colour), built with the standard library."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\x0d\x65\x77" * w for _ in range(h))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def b64(data):
    return "data:image/png;base64," + base64.b64encode(data).decode()


class LogoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not hasattr(test_api.TrackerTest, "admin"):
            test_api.TrackerTest.setUpClass()
        T = test_api.TrackerTest
        cls.admin, cls.lead, cls.member = T.admin, T.lead, T.member
        cls.url = "/api/teams/automation/logos"

    def test_lead_uploads_member_sees(self):
        s, r, _ = self.lead.req("PUT", self.url, {"name": "Acme", "png": b64(png(64, 64))})
        self.assertEqual(s, 200, r)
        team = self.member.req("GET", "/api/teams/automation")[1]
        src = team["logos"]["Acme"]
        self.assertRegex(src, r"^/api/teams/automation/logos/\d+\?v=\d+$")
        s, body, hd = self.member.req("GET", src, raw=True)
        self.assertEqual(s, 200)
        self.assertEqual(hd["Content-Type"], "image/png")
        self.assertIn("max-age", hd["Cache-Control"])
        self.assertEqual(body[:8], b"\x89PNG\r\n\x1a\n")
        # replacing keeps one row and changes nothing else
        self.assertEqual(self.lead.req("PUT", self.url, {"name": "Acme", "png": b64(png(32, 32))})[0], 200)
        self.assertEqual(len(self.member.req("GET", "/api/teams/automation")[1]["logos"]), 1)
        # back to initials
        self.assertEqual(self.lead.req("DELETE", self.url, {"name": "Acme"})[0], 200)
        self.assertEqual(self.member.req("GET", "/api/teams/automation")[1]["logos"], {})
        self.assertEqual(self.member.req("GET", src)[0], 404)

    def test_member_cannot_upload(self):
        self.assertEqual(self.member.req("PUT", self.url, {"name": "Acme", "png": b64(png(16, 16))})[0], 403)
        self.assertEqual(self.member.req("DELETE", self.url, {"name": "Acme"})[0], 403)

    def test_rejects_bad_images(self):
        self.assertEqual(self.lead.req("PUT", self.url, {"name": "Acme", "png": b64(b"GIF89a not a png")})[0], 400)
        self.assertEqual(self.lead.req("PUT", self.url, {"name": "Acme", "png": "!!not base64!!"})[0], 400)
        self.assertEqual(self.lead.req("PUT", self.url, {"name": "Acme", "png": b64(png(400, 10))})[0], 400)  # too wide
        self.assertEqual(self.lead.req("PUT", self.url, {"name": "", "png": b64(png(16, 16))})[0], 400)

    def test_outsider_cannot_see(self):
        self.assertEqual(self.lead.req("PUT", self.url, {"name": "Acme", "png": b64(png(16, 16))})[0], 200)
        src = self.lead.req("GET", "/api/teams/automation")[1]["logos"]["Acme"]
        self.assertEqual(test_api.Client().req("GET", src)[0], 401)
        self.assertEqual(self.lead.req("DELETE", self.url, {"name": "Acme"})[0], 200)

    def test_import_logos_command(self):
        import subprocess
        import tempfile
        d = tempfile.mkdtemp()
        for n, data in (("acme.png", png(64, 64)), ("Nobody Inc.png", png(64, 64)), ("notes.txt", b"x")):
            with open(os.path.join(d, n), "wb") as f:
                f.write(data)
        srv = os.path.join(os.path.dirname(__file__), "..", "app", "server.py")
        run = lambda *args: subprocess.run([sys.executable, srv, "import-logos", d, "--team-id", "automation", *args],
                                           capture_output=True, text=True, env=dict(os.environ)).stdout
        out = run("--dry-run")
        self.assertIn("would set Acme", out)  # file names match customers case-insensitively
        self.assertIn("skip  Nobody Inc", out)
        self.assertNotIn("Acme", self.lead.req("GET", "/api/teams/automation")[1]["logos"])
        self.assertIn("Saved 1 logo", run())
        self.assertIn("Acme", self.lead.req("GET", "/api/teams/automation")[1]["logos"])
        self.assertIn("keep  Acme", run())  # existing logos are kept unless --replace
        self.assertIn("Saved 1 logo", run("--replace"))
        self.assertEqual(self.lead.req("DELETE", self.url, {"name": "Acme"})[0], 200)


if __name__ == "__main__":
    unittest.main()
