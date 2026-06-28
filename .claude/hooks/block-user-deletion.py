#!/usr/bin/env python3
"""PreToolUse(Bash) guardrail — block deleting Supabase users / lifting the DB guard.

Backstop to the database-level BEFORE DELETE trigger added in migration
20260714_guard_user_deletion.sql. That trigger is the real enforcement; this hook
just stops the assistant from casually issuing such a command in the first place
(a mass `DELETE FROM public.users` once wiped 25 prod guests in one shot).

Reads the PreToolUse hook JSON on stdin; if the Bash command matches a
user-deletion / guard-override pattern, emits a PreToolUse "deny" decision.
Anything else: print nothing, exit 0 (no interference).
"""
import json
import re
import sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)  # not the shape we expect — never interfere

cmd = (data.get("tool_input") or {}).get("command", "") or ""

PATTERNS = [
    r"delete\s+from\s+(?:auth|public)\.users",  # SQL user deletion (mass or targeted)
    r"admin\.deleteUser",                        # GoTrue admin API (auth.admin.deleteUser)
    r"dino\.allow_user_deletion",                # lifting the DB-level deletion guard
]

if any(re.search(p, cmd, re.IGNORECASE) for p in PATTERNS):
    reason = (
        "Blocked by the user-deletion guardrail (.claude/settings.json -> "
        ".claude/hooks/block-user-deletion.py). This command would delete Supabase "
        "users or lift the dino.allow_user_deletion DB guard (migration 20260714). "
        "Deleting users is intentionally not a default capability for the assistant. "
        "If it's truly intended, run the command yourself, or temporarily remove this "
        "hook."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))

sys.exit(0)
