#!/bin/zsh
# Regenerates CONTEXT.md daily by driving `claude` headless against the local repo.
# Installed as a launchd job: ~/Library/LaunchAgents/com.bcat.ops-context-update.plist
# Logs to scripts/update-context.log

set -e

REPO="/Users/adminoid/bcat-ops"
export PATH="/Users/adminoid/.local/bin:/Users/adminoid/.nvm/versions/node/v20.20.2/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$REPO"

echo "===== $(date '+%Y-%m-%d %H:%M:%S') — context update run ====="

# Refresh local state if a remote/branch is tracked (non-fatal if offline or no upstream)
git pull --ff-only 2>/dev/null || echo "git pull skipped (no upstream / offline / dirty tree)"

TODAY="$(date '+%Y-%m-%d')"

PROMPT="You are maintaining CONTEXT.md in this repo (/Users/adminoid/bcat-ops), a context file handed to other tools/people.

Regenerate CONTEXT.md so it accurately reflects the CURRENT state of the codebase. Inspect:
- Routes: src/App.tsx
- Data models + custom queries/mutations: amplify/data/resource.ts
- Lambda functions: amplify/functions/ (one bullet per function dir, with its purpose)
- Pages/features: src/features/
- Stack and key dependencies: package.json
- README.md / Docs/ for live URLs and deploy info

Keep the existing structure and headings of CONTEXT.md. Update any section whose facts changed (added/removed routes, models, functions, deps, etc.). Set the 'Last updated:' line near the top to ${TODAY}.

IMPORTANT:
- Only write CONTEXT.md if its content actually changes. If nothing material changed besides the date, you may still update only the date line.
- Do NOT modify any other file.
- Do not invent facts; derive everything from the files above.
After editing, output a one-line summary of what changed (or 'no changes')."

# Run Claude headless, allowing only the tools needed to inspect and edit the file.
claude -p "$PROMPT" \
  --permission-mode acceptEdits \
  --allowedTools "Read,Edit,Write,Glob,Grep,Bash(git diff:*),Bash(git status:*)" \
  2>&1 || { echo "claude run failed"; exit 1; }

# Commit only if CONTEXT.md actually changed.
if ! git diff --quiet -- CONTEXT.md 2>/dev/null; then
  git add CONTEXT.md
  git commit -m "docs: refresh CONTEXT.md ($TODAY)" 2>&1 || echo "commit skipped"
  echo "CONTEXT.md updated and committed."
else
  echo "No changes to CONTEXT.md."
fi

echo "===== done $(date '+%Y-%m-%d %H:%M:%S') ====="
