#!/bin/bash
# =============================================================================
# sync-upstream.sh
# Syncs your fork with the original MoltBot repository
# 
# Usage: ./scripts/sync-upstream.sh
# =============================================================================

set -e

cd "$(dirname "$0")/.."

echo "🔄 Syncing with upstream MoltBot..."
echo ""

# Fetch latest from upstream
echo "1. Fetching latest from upstream..."
git fetch upstream

# Get current branch
CURRENT_BRANCH=$(git branch --show-current)

if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "⚠️  Not on main branch (currently on: $CURRENT_BRANCH)"
  echo "   Switching to main..."
  git checkout main
fi

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --staged --quiet; then
  echo "⚠️  You have uncommitted changes. Stashing them..."
  git stash push -m "Auto-stash before upstream sync"
  STASHED=true
else
  STASHED=false
fi

# Merge upstream changes
echo "2. Merging upstream/main into main..."
if git merge upstream/main --no-edit; then
  echo "   ✓ Merge successful"
else
  echo ""
  echo "❌ Merge conflict detected!"
  echo "   Please resolve conflicts manually, then run:"
  echo "   git add . && git commit && git push origin main"
  exit 1
fi

# Push to your fork
echo "3. Pushing to your fork..."
git push origin main

# Restore stashed changes
if [ "$STASHED" = true ]; then
  echo "4. Restoring stashed changes..."
  git stash pop
fi

echo ""
echo "✅ Successfully synced with upstream MoltBot!"
echo ""
echo "Your fork (origin): $(git remote get-url origin)"
echo "Upstream:           $(git remote get-url upstream)"
