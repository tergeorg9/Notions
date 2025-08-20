#!/usr/bin/env bash
set -euo pipefail

command -v gh >/dev/null 2>&1 || { echo "✖ Please install GitHub CLI: https://cli.github.com/"; exit 1; }

read -rp "GitHub username (e.g. YOUR_GH_USERNAME): " GH_USER
read -rp "Repository name (e.g. notion-site): " REPO
read -rp "Public Notion start URL: " START_URL

# Create repo on GitHub (public for Pages)
GH_REPO="$GH_USER/$REPO"

echo "→ Creating repo $GH_REPO"
gh repo create "$GH_REPO" --public --source . --remote origin --push

echo "→ Setting repo variable NOTION_START_URL"
gh variable set NOTION_START_URL -R "$GH_REPO" -b "$START_URL"

echo "→ Pushing main"
git push -u origin main

echo "→ Trigger first deploy"
gh workflow run -R "$GH_REPO" "Build & Deploy Notion → Pages"

echo "✅ Done. Check Actions tab, then Pages URL in repo Settings"
