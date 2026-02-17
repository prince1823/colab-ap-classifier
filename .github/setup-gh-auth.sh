#!/usr/bin/env bash
# Setup GitHub CLI authentication using a Personal Access Token.
#
# Usage:
#   GH_TOKEN=ghp_xxxxxxxxxxxx bash .github/setup-gh-auth.sh
#
# Or interactively:
#   bash .github/setup-gh-auth.sh
#
# The token needs these scopes: repo, issues, pull_requests (or 'repo' for classic tokens).

set -euo pipefail

if [ -z "${GH_TOKEN:-}" ]; then
  echo "Enter your GitHub Personal Access Token (PAT):"
  echo "(Token needs repo scope for issues and PRs)"
  read -s -p "> " GH_TOKEN
  echo ""
fi

# Validate token
echo "Validating token..."
export GH_TOKEN
USER=$(gh api user --jq '.login' 2>/dev/null) || {
  echo "ERROR: Invalid token or no access. Check your PAT scopes."
  exit 1
}
echo "Authenticated as: $USER"

# Persist token for gh CLI
echo "$GH_TOKEN" | gh auth login --with-token

# Verify repo access
echo "Verifying repo access..."
gh repo view kavyald/colab-ap-classifier --json name --jq '.name' &>/dev/null && {
  echo "Repo access confirmed: kavyald/colab-ap-classifier"
} || {
  echo "WARNING: Cannot access kavyald/colab-ap-classifier. Check token permissions."
  exit 1
}

echo ""
echo "GitHub CLI authenticated successfully!"
echo "Use /create-issue to create new issues with proper board fields."
