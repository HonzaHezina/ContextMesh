"""Import Claude Code sessions (the JSONL files Claude Code keeps on disk) into a running instance.

Location: ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl (Windows: %USERPROFILE%\\.claude\\projects).
Only what the person and the assistant wrote is taken: user prompts and assistant text blocks, with the
original timestamps. Tool calls and results, thinking, attachments, sub-agent (sidechain) turns, meta and
error entries are skipped and counted. Harness text inside prompts (<system-reminder>, command echoes) is
removed. A message longer than the API limit is skipped, never cut. Message ids are the entry uuids, so
re-running is safe.

Claude Code deletes old sessions (cleanupPeriodDays, default about 30 days): import before they go.
Sessions can hold secrets printed by commands; the server rejects messages that look like a password or key,
but review the dry run first. Pick projects explicitly: nothing is imported without --project or --all.

Usage:
  python scripts/import_claude_code.py --list
  python scripts/import_claude_code.py --project ContextMesh [--project ActiveMemory] [--dry-run]
  MEMORY_CLIENT_API_KEY=... MEMORY_API_URL=https://... python scripts/import_claude_code.py --project ContextMesh
The format is read from real session files of this machine; Claude Code may change it between versions.
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

LIMIT = 50000
ROOT = Path.home() / ".claude" / "projects"
SYSTEM_BLOCK = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
HARNESS_START = ("<command-", "<local-command", "<bash-", "Caveat:", "[Request interrupted")


def clean(text):
    return SYSTEM_BLOCK.sub("", text).strip()


def text_of(content):
    """Plain text of a message content: a string or a list of blocks (only text blocks count)."""
    if isinstance(content, str):
        return clean(content)
    if isinstance(content, list):
        return clean("\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"))
    return ""


def stamp(value):
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def project_name(folder):
    # "C--Users-janhe-projekty-ContextMesh" -> "ContextMesh" (the last path part; encoding is lossy)
    return folder.rsplit("-", 1)[-1] or folder


def convert_session(path, project):
    """(message bodies, skipped counts) of one session file."""
    bodies, skipped = [], {"tool_or_other": 0, "empty_or_harness": 0, "too_long": 0, "sidechain_meta_error": 0}
    session = path.stem
    first = None
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        kind = entry.get("type")
        if kind not in ("user", "assistant"):
            continue
        if entry.get("isSidechain") or entry.get("isMeta") or entry.get("isApiErrorMessage"):
            skipped["sidechain_meta_error"] += 1
            continue
        message = entry.get("message") or {}
        text = text_of(message.get("content"))
        when = stamp(entry.get("timestamp"))
        uuid = entry.get("uuid")
        if not (text and when and uuid) or text.startswith(HARNESS_START):
            # tool results / calls / thinking carry no text blocks, so they land here too
            skipped["tool_or_other" if not text else "empty_or_harness"] += 1
            continue
        if len(text) > LIMIT:
            skipped["too_long"] += 1
            continue
        first = first or when
        bodies.append({"role": kind, "content": text, "message_id": uuid, "occurred_at": when})
    day = (first or "")[:10]
    conversation = f"Claude Code: {project} ({day}, {session[:8]})"
    for body in bodies:
        body.update(source_system="claude-code", conversation_id=conversation)
    return bodies, skipped


def sessions(selected, everything):
    if not ROOT.exists():
        sys.exit(f"Not found: {ROOT}")
    for folder in sorted(p for p in ROOT.iterdir() if p.is_dir()):
        name = project_name(folder.name)
        if everything or any(s.lower() in folder.name.lower() for s in selected):
            for path in sorted(folder.glob("*.jsonl")):
                yield name, path


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true", help="list projects and session counts, then stop")
    ap.add_argument("--project", action="append", default=[], help="part of the project folder name (repeatable)")
    ap.add_argument("--all", action="store_true", help="every project (including unrelated ones)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.list:
        for folder in sorted(p for p in ROOT.iterdir() if p.is_dir()) if ROOT.exists() else []:
            files = list(folder.glob("*.jsonl"))
            if files:
                print(f"{folder.name}: {len(files)} sessions")
        return
    if not (args.project or args.all):
        sys.exit("Choose --project NAME (repeatable) or --all. Use --list to see the projects.")

    bodies, total = [], {}
    count = 0
    for name, path in sessions(args.project, args.all):
        part, skipped = convert_session(path, name)
        count += 1
        bodies += part
        for key, value in skipped.items():
            total[key] = total.get(key, 0) + value
    print(f"Sessions: {count}, zpráv k nahrání: {len(bodies)}, přeskočeno: {total}.")
    if args.dry_run or not bodies:
        return

    import httpx

    key = os.environ.get("MEMORY_CLIENT_API_KEY")
    if not key:
        sys.exit("Set MEMORY_CLIENT_API_KEY to a token with write permission.")
    base = os.environ.get("MEMORY_API_URL", "http://127.0.0.1:8080")
    new, rejected = 0, []
    with httpx.Client(base_url=base, headers={"Authorization": f"Bearer {key}"}, timeout=30) as http:
        for body in bodies:
            response = http.post("/v1/episodes", json=body)
            if response.status_code in (409, 422):
                rejected.append(response.text[:120])
                continue
            response.raise_for_status()
            new += 0 if response.json()["duplicate"] else 1
        for _ in range(60):
            jobs = http.get("/v1/jobs").json()
            if not any(j["status"] in ("pending", "running") for j in jobs.get("jobs", jobs)):
                break
            time.sleep(0.5)
    print(f"Nových zpráv: {new}, odmítnuto serverem: {len(rejected)}.")
    for reason in rejected[:5]:
        print("  odmítnuto:", reason)


if __name__ == "__main__":
    main()
