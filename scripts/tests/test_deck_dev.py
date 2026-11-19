import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location("deck_dev", Path(__file__).parents[1] / "deck-dev.py")
dev = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dev)


def make_plugin(root):
    for name in ("dist/index.js", "backend/out/server.cjs", "backend/xml/ssdp.xml",
                 "main.py", "package.json", "LICENSE", "bin/node", "bin/yt-dlp"):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture")
    (root / "plugin.json").write_text(json.dumps({"name": "YouTube Cast Receiver"}))


class DevelopmentWorkflowTests(unittest.TestCase):
    def test_package_layout_and_allowlist(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_plugin(root)
            (root / ".env").write_text("must not ship")
            (root / "backend/out/server.js").write_text("stale bundle")
            output = root / "dev.zip"
            dev.package(root, output)
            with zipfile.ZipFile(output) as archive:
                names = archive.namelist()
                prefix = "YouTube Cast Receiver/"
                self.assertIn(prefix + "backend/out/server.cjs", names)
                self.assertIn(prefix + "bin/node", names)
                self.assertFalse(any(".env" in name or name.endswith("server.js") for name in names))
                self.assertEqual((archive.getinfo(prefix + "bin/node").external_attr >> 16) & 0o777, 0o755)

    def test_missing_build_fails_before_ssh(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(dev, "ROOT", Path(directory)), patch.object(dev, "ssh") as ssh:
            with self.assertRaises(ValueError):
                dev.deploy("steamdeck", "/home/deck/homebrew/plugins/Test")
            ssh.assert_not_called()

    def test_status_shows_journal_even_when_http_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            tools = Path(directory)
            (tools / "curl").write_text("#!/bin/sh\nexit 22\n")
            (tools / "sudo").write_text('#!/bin/sh\nprintf "journal evidence: %s\\n" "$*"\n')
            for name in ("curl", "sudo"):
                (tools / name).chmod(0o755)
            result = subprocess.run(["sh", "-c", dev.status_command()], capture_output=True, text=True,
                                    env={**os.environ, "PATH": f"{tools}{os.pathsep}{os.environ['PATH']}"})
            self.assertEqual(result.returncode, 1)
            self.assertIn("/api/network/current", result.stdout)
            self.assertIn("journal evidence: journalctl", result.stdout)

    def test_deployment_quotes_paths_and_restarts_only_decky_after_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "local"
            root.mkdir()
            make_plugin(root)
            stage = Path(directory) / "stage"
            stage.mkdir()
            # This path must remain literal when passed through the remote shell.
            target = Path(directory) / "plugin with spaces $(touch UNEXPECTED)"
            make_plugin(target)
            (target / "bin/node").write_text("#!/bin/sh\nexit 1\n")
            (target / "bin/node").chmod(0o755)
            commands = []

            def fake_run(args, **kwargs):
                if args[0] == "scp":
                    with tarfile.open(args[1]) as archive:
                        self.assertNotIn("bin/node", archive.getnames())
                        self.assertNotIn("bin/yt-dlp", archive.getnames())
                    (stage / "update.tar.gz").write_bytes(Path(args[1]).read_bytes())
                return subprocess.CompletedProcess(args, 0)

            def fake_ssh(host, command, **kwargs):
                commands.append(command)
                return subprocess.CompletedProcess([], 0, stdout="/tmp/ytcast-dev.TEST1234\n")

            with patch.object(dev, "ROOT", root), patch.object(dev, "run", side_effect=fake_run), patch.object(dev, "ssh", side_effect=fake_ssh):
                dev.deploy("steamdeck", str(target))
            args = shlex.split(commands[-1])
            self.assertEqual(args[-2], str(target))
            script = args[3]
            tools = Path(directory) / "tools"
            tools.mkdir()
            calls = Path(directory) / "services.log"
            (tools / "systemctl").write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$SERVICE_LOG"\n')
            (tools / "systemctl").chmod(0o755)
            result = subprocess.run(["sh", "-c", script, "sh", str(target), str(stage)],
                                    env={**os.environ, "PATH": f"{tools}{os.pathsep}{os.environ['PATH']}", "SERVICE_LOG": str(calls)},
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)  # Fake Node syntax check fails.
            self.assertEqual(calls.read_text().splitlines(),
                             ["stop plugin_loader.service", "start plugin_loader.service"])
            self.assertTrue((stage / "previous-code.tar.gz").is_file())
            self.assertFalse((Path.cwd() / "UNEXPECTED").exists())

    def test_deploy_upgrades_legacy_js_install_and_backs_up_its_original_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "local"
            make_plugin(root)
            (root / "backend/out/server.cjs").write_text("updated bundle")
            target = Path(directory) / "installed plugin"
            make_plugin(target)
            (target / "backend/out/server.cjs").rename(target / "backend/out/server.js")
            (target / "backend/out/package.json").write_text('{"type":"commonjs"}')
            (target / "main.py").write_text("legacy launcher using server.js")
            node = '#!/bin/sh\ntest "$1" = --check && test -s "$2"\n'
            (target / "bin/node").write_text(node)
            (target / "bin/node").chmod(0o755)
            stage = Path(directory) / "stage"
            stage.mkdir()
            tools = Path(directory) / "tools"
            tools.mkdir()
            calls = Path(directory) / "services.log"
            (tools / "systemctl").write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$SERVICE_LOG"\n')
            (tools / "systemctl").chmod(0o755)
            commands = []

            def fake_run(args, **kwargs):
                self.assertEqual(args[0], "scp")
                (stage / "update.tar.gz").write_bytes(Path(args[1]).read_bytes())
                return subprocess.CompletedProcess(args, 0)

            def fake_ssh(host, command, **kwargs):
                commands.append(command)
                return subprocess.CompletedProcess([], 0, stdout="/tmp/ytcast-dev.TEST1234\n")

            with patch.object(dev, "ROOT", root), patch.object(dev, "run", side_effect=fake_run), patch.object(dev, "ssh", side_effect=fake_ssh):
                dev.deploy("steamdeck", str(target))
            script = shlex.split(commands[-1])[3]
            result = subprocess.run(["sh", "-c", script, "sh", str(target), str(stage)],
                                    env={**os.environ, "PATH": f"{tools}{os.pathsep}{os.environ['PATH']}", "SERVICE_LOG": str(calls)},
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(calls.read_text().splitlines(),
                             ["stop plugin_loader.service", "start plugin_loader.service"])
            with tarfile.open(stage / "previous-code.tar.gz") as archive:
                self.assertEqual(archive.extractfile("backend/out/server.js").read(), b"fixture")
                self.assertEqual(archive.extractfile("backend/out/package.json").read(), b'{"type":"commonjs"}')
                self.assertEqual(archive.extractfile("main.py").read(), b"legacy launcher using server.js")
                self.assertNotIn("backend/out/server.cjs", archive.getnames())
            self.assertEqual((target / "backend/out/server.cjs").read_text(), "updated bundle")
            self.assertEqual((target / "main.py").read_bytes(), (root / "main.py").read_bytes())
            self.assertEqual((target / "bin/node").read_text(), node)
            self.assertEqual((target / "bin/yt-dlp").read_text(), "fixture")


if __name__ == "__main__":
    unittest.main()
