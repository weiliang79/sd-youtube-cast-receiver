"""Local development helpers. No third-party Python packages required."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CODE = ("dist", "backend/out/server.cjs", "backend/xml", "main.py",
        "package.json", "plugin.json", "LICENSE")
SERVICE = "plugin_loader.service"


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def payload_files(root, with_binaries=False):
    """Explicit allowlist: never ship local config, credentials or node_modules."""
    entries = CODE + (("bin/node", "bin/yt-dlp") if with_binaries else ())
    files = []
    for name in entries:
        path = root / name
        if path.is_symlink():
            raise ValueError(f"Refusing symlink in payload: {path}")
        if not path.exists():
            raise ValueError(f"Missing {path}; build first (packaging also needs Linux binaries).")
        files.extend(sorted(path.rglob("*")) if path.is_dir() else [path])
    if not (root / "dist/index.js").is_file():
        raise ValueError("Missing dist/index.js; build the frontend first.")
    for path in files:
        if path.is_symlink():
            raise ValueError(f"Refusing symlink in payload: {path}")
    return [path for path in files if path.is_file()]


def package(root, output):
    files = payload_files(root, with_binaries=True)
    name = json.loads((root / "plugin.json").read_text())["name"]
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            relative = path.relative_to(root).as_posix()
            info = zipfile.ZipInfo(f"{name}/{relative}")
            info.create_system = 3
            mode = 0o755 if relative.startswith("bin/") else 0o644
            info.external_attr = (0o100000 | mode) << 16
            archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
    print(output)


def ssh(host, command, *, tty=False, capture=False):
    return run(["ssh", *(["-t"] if tty else []), host, command],
               text=True, capture_output=capture)


def deploy(host, plugin_path):
    path = PurePosixPath(plugin_path)
    if not path.is_absolute() or ".." in path.parts or len(path.parts) < 4:
        raise ValueError("Plugin path must be an absolute plugin directory, not a parent directory.")
    files = payload_files(ROOT)
    with tempfile.TemporaryDirectory(prefix="ytcast-dev-") as local:
        archive = Path(local) / "update.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for file in files:
                tar.add(file, arcname=file.relative_to(ROOT).as_posix(), recursive=False)
        stage = ssh(host, "mktemp -d /tmp/ytcast-dev.XXXXXXXX", capture=True).stdout.strip()
        if not stage.startswith("/tmp/ytcast-dev.") or not stage.replace("/", "").replace("-", "").replace(".", "").isalnum():
            raise ValueError("Unexpected remote staging path.")
        run(["scp", str(archive), f"{host}:{stage}/update.tar.gz"])
        # sudo uses an interactive TTY; passwords are never read or stored here.
        # Keep a code backup outside the plugin directory for manual recovery.
        script = '''set -eu
target=$1
stage=$2
test -f "$target/plugin.json"
test -x "$target/bin/node"
test -f "$target/bin/yt-dlp"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$target/plugin.json")" = 'YouTube Cast Receiver'
# Back up the installed layout, including legacy server.js and package overrides.
tar -czf "$stage/previous-code.tar.gz" -C "$target" dist backend/out backend/xml main.py package.json plugin.json LICENSE
systemctl stop plugin_loader.service
trap 'systemctl start plugin_loader.service' EXIT
tar -xzf "$stage/update.tar.gz" -C "$target" --no-same-owner
"$target/bin/node" --check "$target/backend/out/server.cjs"
echo "Code backup retained at $stage/previous-code.tar.gz"
'''
        command = shlex.join(["sudo", "sh", "-c", script, "sh", plugin_path, stage])
        print(f"Updating {host}:{plugin_path}; only Decky Loader will be stopped/started.", flush=True)
        print(f"Remote staging/recovery directory: {stage}", flush=True)
        ssh(host, command, tty=True)
    print("Deployment complete. Reopen the Decky panel, then run status and logs.")


def status_command():
    return '''failed=0
for endpoint in health network/current state; do
  printf '\\n/api/%s\\n' "$endpoint"
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:39281/api/$endpoint" || failed=1
  printf '\\n'
done
echo 'Recent receiver journal evidence (historical, not a live advertising API):'
sudo journalctl -b -u plugin_loader.service --no-pager -n 60 --grep='YTCast|READY' || failed=1
exit "$failed"
'''


def port(value):
    number = int(value)
    if not 1 <= number <= 65535:
        raise argparse.ArgumentTypeError("Port must be between 1 and 65535")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["build", "package", "deploy", "logs", "status", "devtools"])
    parser.add_argument("--host", default=os.environ.get("DECK_SSH_HOST", "steamdeck"), help="SSH alias or user@host")
    parser.add_argument("--plugin-path", default=os.environ.get("DECK_PLUGIN_PATH", "/home/deck/homebrew/plugins/YouTube Cast Receiver"))
    parser.add_argument("--output", type=Path, default=ROOT / "youtube-cast-receiver-dev.zip")
    parser.add_argument("--cef-port", type=port, default=os.environ.get("DECK_CEF_PORT", "8080"))
    parser.add_argument("--local-port", type=port, default=18080)
    args = parser.parse_args()
    if not args.host or args.host.startswith("-") or any(c.isspace() for c in args.host):
        parser.error("Use an SSH alias or user@host without spaces or options; configure SSH in ~/.ssh/config.")
    if args.command == "build":
        pnpm = shutil.which("pnpm")
        if not pnpm:
            raise ValueError("pnpm is required on PATH; install it before running build.")
        for task in ("build", "build:backend", "test"):
            run([pnpm, "run", task], cwd=ROOT)
    elif args.command == "package":
        package(ROOT, args.output.resolve())
    elif args.command == "deploy":
        deploy(args.host, args.plugin_path)
    elif args.command == "logs":
        ssh(args.host, f"sudo journalctl -b -u {SERVICE} -n 100 -f", tty=True)
    elif args.command == "status":
        ssh(args.host, status_command(), tty=True)
    else:
        print(f"Keep this tunnel running. In Chrome inspect 127.0.0.1:{args.local_port}.", flush=True)
        run(["ssh", "-N", "-o", "ExitOnForwardFailure=yes", "-L",
             f"127.0.0.1:{args.local_port}:127.0.0.1:{args.cef_port}", args.host])


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
