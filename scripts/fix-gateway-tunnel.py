#!/usr/bin/env python3
"""
fix-gateway-tunnel.py - Diagnose and fix clawdbot gateway + Cloudflare tunnel issues

This script helps troubleshoot "502 Bad Gateway" errors for clawdbot.scribasound.com
by checking and restarting the necessary services.

Common causes of 502 errors:
1. Gateway process not running or crashed
2. Cloudflare tunnel (cloudflared) stale or disconnected
3. Multiple zombie cloudflared processes
4. Invalid gateway config (unknown keys) causing the gateway to exit on startup
5. Port mismatch between tunnel config and gateway

Usage:
    python3 scripts/fix-gateway-tunnel.py          # Check status only
    python3 scripts/fix-gateway-tunnel.py --fix    # Attempt to fix issues
    python3 scripts/fix-gateway-tunnel.py --restart-all  # Force restart everything

Author: Moltbot team
"""

import argparse
import os
from collections import deque
import re
import subprocess
import sys
import time
from pathlib import Path

# =============================================================================
# CONFIGURATION - Update these values for your setup
# =============================================================================

# Prefer env overrides so this script is safe to keep in git without secrets.
GATEWAY_PORT = int(os.environ.get("CLAWDBOT_GATEWAY_PORT", "18789"))
GATEWAY_TOKEN = os.environ.get("CLAWDBOT_GATEWAY_TOKEN")  # optional
EXTERNAL_URL = "https://clawdbot.scribasound.com/"
LOCAL_URL = f"http://127.0.0.1:{GATEWAY_PORT}/"

# macOS (launchd) - if you have a gateway LaunchAgent installed, prefer that.
# In this repo, the default label is `com.clawdbot.gateway` and it runs
# `~/.clawdbot/run-gateway.sh` (which already has its own restart loop).
LAUNCHD_GATEWAY_LABEL = os.environ.get("CLAWDBOT_GATEWAY_LAUNCHD_LABEL", "com.clawdbot.gateway")

# Paths
CLAWDBOT_REPO = Path(__file__).parent.parent  # Assumes script is in scripts/
CLOUDFLARED_BIN = "/opt/homebrew/bin/cloudflared"
CLOUDFLARED_CONFIG = Path.home() / ".cloudflared" / "config.yml"
GATEWAY_LOG = Path("/tmp/moltbot-gateway.log")
CLOUDFLARED_LOG = Path("/tmp/cloudflared.log")


# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

def run_cmd(cmd: str, capture: bool = True, timeout: int = 30) -> tuple[int, str]:
    """Run a shell command and return (exit_code, output)."""
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=capture,
            text=True,
            timeout=timeout,
        )
        output = (result.stdout or "") + (result.stderr or "")
        return result.returncode, output.strip()
    except subprocess.TimeoutExpired:
        return -1, "Command timed out"
    except Exception as e:
        return -1, str(e)


def print_status(label: str, ok: bool, detail: str = ""):
    """Print a status line with colour coding."""
    status = "✅" if ok else "❌"
    detail_str = f" - {detail}" if detail else ""
    print(f"  {status} {label}{detail_str}")


def print_header(title: str):
    """Print a section header."""
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")


# =============================================================================
# CHECK FUNCTIONS
# =============================================================================

def get_launchd_service_id(label: str) -> str:
    """Return the launchd service id for the current user (gui/<uid>/<label>)."""
    return f"gui/{os.getuid()}/{label}"


def get_launchd_service_status(label: str) -> dict:
    """
    Best-effort status for a launchd job, without dumping secrets from `launchctl print`.
    Returns:
      - exists: bool
      - running: bool | None
      - active_count: int | None
      - stdout_path: str | None
      - stderr_path: str | None
      - service_id: str
    """
    service_id = get_launchd_service_id(label)
    # First: check whether the service exists (don’t capture output — may contain secrets).
    code, _ = run_cmd(f"launchctl print {service_id} >/dev/null 2>&1", timeout=8)
    if code != 0:
        return {
            "exists": False,
            "running": None,
            "active_count": None,
            "stdout_path": None,
            "stderr_path": None,
            "service_id": service_id,
        }

    # Second: capture only the small subset of lines we need.
    # IMPORTANT: `launchctl print` includes environment variables (often secrets).
    _, output = run_cmd(
        (
            f"launchctl print {service_id} 2>/dev/null | "
            "grep -E '^(\\s*(state =|active count =|stdout path =|stderr path =))' || true"
        ),
        timeout=10,
    )

    # Note: `launchctl print` includes nested sections; we take the first match for each.
    running: bool | None = None
    m_state = re.search(r"^\s*state = (.+?)\s*$", output, flags=re.MULTILINE)
    if m_state:
        running = m_state.group(1).strip() == "running"

    active_count: int | None = None
    m_active = re.search(r"^\s*active count = (\d+)\s*$", output, flags=re.MULTILINE)
    if m_active:
        active_count = int(m_active.group(1))

    stdout_path: str | None = None
    m_stdout = re.search(r"^\s*stdout path = (.+?)\s*$", output, flags=re.MULTILINE)
    if m_stdout:
        stdout_path = m_stdout.group(1).strip()

    stderr_path: str | None = None
    m_stderr = re.search(r"^\s*stderr path = (.+?)\s*$", output, flags=re.MULTILINE)
    if m_stderr:
        stderr_path = m_stderr.group(1).strip()

    return {
        "exists": True,
        "running": running,
        "active_count": active_count,
        "stdout_path": stdout_path,
        "stderr_path": stderr_path,
        "service_id": service_id,
    }


def tail_text(path: str | None, max_lines: int = 120) -> str:
    """Return the last N lines of a file (best-effort)."""
    if not path:
        return ""
    try:
        with open(path, "r", errors="replace") as f:
            return "".join(deque(f, maxlen=max_lines))
    except FileNotFoundError:
        return ""
    except Exception:
        return ""


def looks_like_invalid_config(log_text: str) -> bool:
    """
    Detect the most common fatal startup issue: invalid config / unknown keys.
    Example we’ve seen: web.braveApiKey in ~/.clawdbot/moltbot.json.
    """
    text = log_text.lower()
    return (
        "invalid config at" in text
        or "config invalid" in text
        or "unrecognized key" in text
        or "unknown config keys" in text
    )


def run_doctor_fix() -> bool:
    """
    Run `moltbot doctor --fix` via the local repo build, non-interactively.
    This is safe and is the recommended remediation for unknown config keys.
    """
    entry = CLAWDBOT_REPO / "dist" / "entry.js"
    if not entry.exists():
        print("  ❌ Cannot run doctor: dist/entry.js not found (run `pnpm build`).")
        return False

    print("  Running doctor --fix (non-interactive)...")
    code, output = run_cmd(
        f"cd {CLAWDBOT_REPO} && node dist/entry.js doctor --fix --yes --non-interactive",
        timeout=180,
    )
    if code == 0:
        print("  ✅ Doctor completed.")
        return True

    # Keep output short (helpful without being spammy).
    lines = output.splitlines()
    preview = "\n".join(lines[-40:]) if lines else output
    print("  ❌ Doctor failed:")
    if preview:
        print(preview)
    return False


def check_gateway_process() -> tuple[bool, str, list[int]]:
    """
    Check if the moltbot gateway process is running.
    Returns (is_running, message, list_of_pids).
    """
    code, output = run_cmd("ps aux | grep moltbot-gateway | grep -v grep")
    if code != 0 or not output:
        return False, "Not running", []

    pids: list[int] = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            try:
                pids.append(int(parts[1]))
            except ValueError:
                continue

    pids = sorted(set(pids))
    if not pids:
        return True, "Running", []
    if len(pids) == 1:
        return True, f"Running (PID {pids[0]})", pids
    return True, f"Running (PIDs {', '.join(str(p) for p in pids)})", pids


def check_gateway_listening() -> tuple[bool, str]:
    """Check if something is listening on the gateway port."""
    code, output = run_cmd(f"lsof -i :{GATEWAY_PORT} | grep LISTEN")
    if code == 0 and output:
        return True, f"Port {GATEWAY_PORT} is listening"
    return False, f"Nothing listening on port {GATEWAY_PORT}"


def check_gateway_responds() -> tuple[bool, str]:
    """Test if the gateway responds to HTTP requests locally."""
    code, output = run_cmd(f"curl -s -o /dev/null -w '%{{http_code}}' {LOCAL_URL}", timeout=10)
    if code == 0 and output == "200":
        return True, "Gateway responds with HTTP 200"
    return False, f"Gateway not responding (HTTP {output})"


def check_cloudflared_process() -> tuple[bool, str, list[int]]:
    """
    Check cloudflared tunnel process(es).
    Returns (is_running, message, list of PIDs).
    
    Note: cloudflared normally runs as 2 processes (parent supervisor + worker),
    so 2 PIDs is expected. More than 2 indicates zombie/stale processes.
    """
    code, output = run_cmd("ps aux | grep 'cloudflared tunnel' | grep -v grep")
    if code != 0 or not output:
        return False, "Cloudflared not running", []
    
    pids = []
    for line in output.strip().split("\n"):
        parts = line.split()
        if len(parts) >= 2:
            try:
                pids.append(int(parts[1]))
            except ValueError:
                pass
    
    # cloudflared runs as 2 processes (supervisor + worker), so 2 is normal
    if len(pids) > 2:
        return True, f"WARNING: Too many instances ({len(pids)} PIDs: {pids})", pids
    elif len(pids) == 2:
        return True, f"Running (PIDs {pids[0]}, {pids[1]})", pids
    elif len(pids) == 1:
        return True, f"Running (PID {pids[0]})", pids
    return True, "Running", pids


def check_cloudflared_config() -> tuple[bool, str]:
    """Verify cloudflared config exists and has correct port."""
    if not CLOUDFLARED_CONFIG.exists():
        return False, f"Config not found: {CLOUDFLARED_CONFIG}"
    
    try:
        content = CLOUDFLARED_CONFIG.read_text()
        if f"127.0.0.1:{GATEWAY_PORT}" in content:
            return True, f"Config points to port {GATEWAY_PORT}"
        return False, f"Config may not point to port {GATEWAY_PORT}"
    except Exception as e:
        return False, f"Error reading config: {e}"


def check_external_url() -> tuple[bool, str]:
    """Test if the external URL is accessible."""
    code, output = run_cmd(
        f"curl -s -o /dev/null -w '%{{http_code}}' {EXTERNAL_URL}",
        timeout=15,
    )
    if code == 0:
        if output == "200":
            return True, f"External URL responds with HTTP 200"
        elif output == "502":
            return False, "502 Bad Gateway - tunnel not reaching backend"
        else:
            return False, f"HTTP {output}"
    return False, f"Request failed: {output}"


# =============================================================================
# FIX FUNCTIONS
# =============================================================================

def kill_process_by_name(pattern: str) -> bool:
    """Kill all processes matching a pattern."""
    code, _ = run_cmd(f"pkill -9 -f '{pattern}'")
    time.sleep(2)  # Give processes time to die
    return True


def wait_for_gateway_ready(timeout_s: int = 20) -> bool:
    """Wait until the gateway is listening and responding (best-effort)."""
    started = time.time()
    while time.time() - started < timeout_s:
        listening, _ = check_gateway_listening()
        if listening:
            ok, _ = check_gateway_responds()
            if ok:
                return True
        time.sleep(1)
    return False


def start_gateway_manual() -> bool:
    """Start the gateway directly (non-launchd)."""
    print("  Starting gateway...")
    
    # Open log file for output.
    # Append so we keep historical context when debugging repeated failures.
    log_file = open(GATEWAY_LOG, "a")
    
    args = [
        "node",
        "dist/entry.js",
        "gateway",
        "--port",
        str(GATEWAY_PORT),
        "--allow-unconfigured",
    ]
    if GATEWAY_TOKEN:
        args += ["--token", GATEWAY_TOKEN]

    # Start as a detached process.
    try:
        subprocess.Popen(
            args,
            cwd=str(CLAWDBOT_REPO),
            stdout=log_file,
            stderr=log_file,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as e:
        print(f"  ❌ Failed to start gateway: {e}")
        return False
    finally:
        try:
            log_file.close()
        except Exception:
            pass
    
    if wait_for_gateway_ready():
        running, msg, _ = check_gateway_process()
        print(f"  ✅ Gateway started: {msg}")
        return True

    print(f"  ❌ Gateway failed to become ready. Check {GATEWAY_LOG}")
    return False


def start_cloudflared() -> bool:
    """Start the cloudflared tunnel as a properly daemonized process."""
    print("  Starting cloudflared tunnel...")
    
    if not Path(CLOUDFLARED_BIN).exists():
        print(f"  ❌ cloudflared not found at {CLOUDFLARED_BIN}")
        return False
    
    if not CLOUDFLARED_CONFIG.exists():
        print(f"  ❌ Config not found: {CLOUDFLARED_CONFIG}")
        return False
    
    # Open log file for output
    log_file = open(CLOUDFLARED_LOG, "w")
    
    # Start cloudflared as a fully detached daemon process
    try:
        process = subprocess.Popen(
            [
                CLOUDFLARED_BIN,
                "tunnel",
                "--config", str(CLOUDFLARED_CONFIG),
                "run",
            ],
            stdout=log_file,
            stderr=log_file,
            stdin=subprocess.DEVNULL,
            start_new_session=True,  # Detach from controlling terminal
        )
    except Exception as e:
        print(f"  ❌ Failed to start cloudflared: {e}")
        return False
    finally:
        try:
            log_file.close()
        except Exception:
            pass
    
    time.sleep(5)  # Give tunnel time to connect
    
    # Verify it started and connected
    running, msg, _ = check_cloudflared_process()
    if running:
        # Check logs for successful registration
        code, log_output = run_cmd(f"tail -20 {CLOUDFLARED_LOG} | grep 'Registered tunnel'")
        if "Registered" in log_output:
            print(f"  ✅ Cloudflared started and connected")
            return True
        else:
            print(f"  ⚠️  Cloudflared started but may not be connected. Check {CLOUDFLARED_LOG}")
            return True
    else:
        print(f"  ❌ Cloudflared failed to start. Check {CLOUDFLARED_LOG}")
        return False


def restart_cloudflared() -> bool:
    """Kill all cloudflared processes and start fresh."""
    print("  Killing existing cloudflared processes...")
    kill_process_by_name("cloudflared")
    return start_cloudflared()


def restart_gateway() -> bool:
    """
    Restart the gateway.

    If a macOS launchd job exists (`com.clawdbot.gateway`), prefer restarting that,
    to avoid having competing supervisors fighting over the gateway lock/port.
    """
    launchd = get_launchd_service_status(LAUNCHD_GATEWAY_LABEL)
    if launchd["exists"]:
        print(f"  Restarting launchd service ({LAUNCHD_GATEWAY_LABEL})...")
        code, output = run_cmd(f"launchctl kickstart -k {launchd['service_id']}", timeout=15)
        if code != 0:
            print("  ⚠️  launchctl kickstart failed; falling back to manual start.")
            print(f"     {output}")
            print("  Killing existing gateway processes...")
            kill_process_by_name("moltbot-gateway")
            return start_gateway_manual()
        if wait_for_gateway_ready(timeout_s=30):
            return True

        # Not ready: inspect launchd logs for common causes and attempt targeted remediation.
        stderr_tail = tail_text(launchd.get("stderr_path"))
        stdout_tail = tail_text(launchd.get("stdout_path"))
        combined_tail = f"{stderr_tail}\n{stdout_tail}"

        if looks_like_invalid_config(combined_tail):
            print("  ⚠️  Gateway failed to start due to invalid config (see launchd logs).")
            if run_doctor_fix():
                print(f"  Restarting launchd service ({LAUNCHD_GATEWAY_LABEL}) after doctor fix...")
                run_cmd(f"launchctl kickstart -k {launchd['service_id']}", timeout=15)
                if wait_for_gateway_ready(timeout_s=45):
                    return True

        print("  ⚠️  launchd restarted but gateway did not become ready in time.")
        if launchd.get("stderr_path"):
            print(f"     Check launchd stderr: tail -100 {launchd['stderr_path']}")
        if launchd.get("stdout_path"):
            print(f"     Check launchd stdout: tail -100 {launchd['stdout_path']}")
        return False

    print("  Killing existing gateway processes...")
    kill_process_by_name("moltbot-gateway")
    return start_gateway_manual()


# =============================================================================
# MAIN DIAGNOSTIC FLOW
# =============================================================================

def run_diagnostics() -> dict:
    """Run all diagnostic checks and return results."""
    results = {}
    
    print_header("macOS Service (launchd)")
    launchd = get_launchd_service_status(LAUNCHD_GATEWAY_LABEL)
    if launchd["exists"]:
        running = bool(launchd.get("running"))
        detail = "Running" if running else "Not running"
        print_status(f"launchd {LAUNCHD_GATEWAY_LABEL}", running, detail)
        results["launchd_gateway_exists"] = True
        results["launchd_gateway_running"] = running
        results["launchd_gateway_stdout"] = launchd.get("stdout_path")
        results["launchd_gateway_stderr"] = launchd.get("stderr_path")
    else:
        print_status(f"launchd {LAUNCHD_GATEWAY_LABEL}", True, "Not installed")
        results["launchd_gateway_exists"] = False
        results["launchd_gateway_running"] = False
        results["launchd_gateway_stdout"] = None
        results["launchd_gateway_stderr"] = None

    print_header("Gateway Status")
    
    # Check gateway process
    ok, msg, pids = check_gateway_process()
    print_status("Gateway process", ok, msg)
    results["gateway_process"] = ok
    results["gateway_pids"] = pids
    
    # Check gateway port
    ok, msg = check_gateway_listening()
    print_status("Gateway port", ok, msg)
    results["gateway_port"] = ok
    
    # Check gateway responds
    if results["gateway_port"]:
        ok, msg = check_gateway_responds()
        print_status("Gateway HTTP", ok, msg)
        results["gateway_http"] = ok
    else:
        results["gateway_http"] = False
    
    print_header("Cloudflare Tunnel Status")
    
    # Check cloudflared config
    ok, msg = check_cloudflared_config()
    print_status("Tunnel config", ok, msg)
    results["tunnel_config"] = ok
    
    # Check cloudflared process (2 PIDs is normal: supervisor + worker)
    ok, msg, pids = check_cloudflared_process()
    print_status("Tunnel process", ok and len(pids) <= 2, msg)
    results["tunnel_process"] = ok
    results["tunnel_multiple"] = len(pids) > 2
    
    print_header("External Connectivity")
    
    # Check external URL
    ok, msg = check_external_url()
    print_status("External URL", ok, msg)
    results["external_url"] = ok
    
    return results


def attempt_fix(results: dict) -> bool:
    """Attempt to fix issues based on diagnostic results."""
    print_header("Attempting Fixes")
    
    fixed_something = False
    
    # Fix gateway if not running or not responding
    if not results.get("gateway_process") or not results.get("gateway_http"):
        print("\n  🔧 Gateway needs attention...")
        if restart_gateway():
            fixed_something = True
    
    # Fix cloudflared if not running or has multiple instances
    if not results.get("tunnel_process") or results.get("tunnel_multiple"):
        print("\n  🔧 Cloudflared tunnel needs attention...")
        if restart_cloudflared():
            fixed_something = True
    
    # If both services are fine but external URL fails, try restarting tunnel
    if (results.get("gateway_http") and 
        results.get("tunnel_process") and 
        not results.get("external_url")):
        print("\n  🔧 Tunnel connected but external URL failing, restarting tunnel...")
        if restart_cloudflared():
            fixed_something = True
    
    return fixed_something


def main():
    parser = argparse.ArgumentParser(
        description="Diagnose and fix clawdbot gateway + Cloudflare tunnel issues",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 fix-gateway-tunnel.py              # Check status only
  python3 fix-gateway-tunnel.py --fix        # Attempt to fix issues
  python3 fix-gateway-tunnel.py --restart-all  # Force restart everything
        """,
    )
    parser.add_argument(
        "--fix",
        action="store_true",
        help="Attempt to fix any issues found",
    )
    parser.add_argument(
        "--restart-all",
        action="store_true",
        help="Force restart both gateway and tunnel",
    )
    args = parser.parse_args()
    
    print("\n🔍 Clawdbot Gateway & Tunnel Diagnostics")
    print(f"   External URL: {EXTERNAL_URL}")
    print(f"   Local URL: {LOCAL_URL}")
    
    # Force restart everything if requested
    if args.restart_all:
        print_header("Force Restarting All Services")
        print("\n  🔧 Restarting gateway...")
        restart_gateway()
        print("\n  🔧 Restarting cloudflared...")
        restart_cloudflared()
        print("\n  ⏳ Waiting for services to stabilise...")
        time.sleep(3)
    
    # Run diagnostics
    results = run_diagnostics()
    
    # Attempt fixes if requested
    if args.fix and not args.restart_all:
        all_ok = all([
            results.get("gateway_http"),
            results.get("tunnel_process"),
            not results.get("tunnel_multiple"),
            results.get("external_url"),
        ])
        
        if not all_ok:
            attempt_fix(results)
            print("\n  ⏳ Waiting for services to stabilise...")
            time.sleep(3)
            print_header("Re-checking Status")
            results = run_diagnostics()
    
    # Final summary
    print_header("Summary")
    
    all_ok = all([
        results.get("gateway_http"),
        results.get("tunnel_process"),
        not results.get("tunnel_multiple"),
        results.get("external_url"),
    ])
    
    if all_ok:
        print(f"\n  ✅ All systems operational!")
        print(f"     Visit: {EXTERNAL_URL}")
        return 0
    else:
        print(f"\n  ❌ Issues remain. Suggested actions:")
        if not results.get("gateway_process"):
            print(f"     - Check gateway logs: tail -100 {GATEWAY_LOG}")
        if not results.get("tunnel_process"):
            print(f"     - Check tunnel logs: tail -100 {CLOUDFLARED_LOG}")
        if results.get("tunnel_multiple"):
            print(f"     - Kill zombie cloudflared: pkill -9 -f cloudflared")
        if not results.get("external_url"):
            print(f"     - Check Cloudflare dashboard for tunnel status")
        print(f"\n     Run with --fix to attempt automatic fixes")
        return 1


if __name__ == "__main__":
    sys.exit(main())
