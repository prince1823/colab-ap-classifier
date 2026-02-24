#!/usr/bin/env bash
# Creates all Sprint 1 backend GitHub issues with labels and dependencies.
# Usage: GH_TOKEN=<your-pat> bash .github/issues/create-all-issues.sh
#
# Prerequisites: gh CLI installed, token with repo + issues scopes.
set -euo pipefail

REPO="kavyald/colab-ap-classifier"

# Ensure gh is authenticated
if ! gh auth status &>/dev/null; then
  if [ -z "${GH_TOKEN:-}" ]; then
    echo "ERROR: Set GH_TOKEN or run 'gh auth login' first."
    exit 1
  fi
fi

echo "Creating labels..."
gh label create "sprint-1"      --repo "$REPO" --color "0E8A16" --description "Sprint 1 (v1)" --force 2>/dev/null || true
gh label create "backend"       --repo "$REPO" --color "1D76DB" --description "Backend / main process" --force 2>/dev/null || true
gh label create "foundation"    --repo "$REPO" --color "D4C5F9" --description "Project scaffolding & infra" --force 2>/dev/null || true
gh label create "database"      --repo "$REPO" --color "FBCA04" --description "DuckDB schema & service" --force 2>/dev/null || true
gh label create "ipc"           --repo "$REPO" --color "C5DEF5" --description "IPC handlers" --force 2>/dev/null || true
gh label create "llm-agent"     --repo "$REPO" --color "F9D0C4" --description "LLM agent implementation" --force 2>/dev/null || true
gh label create "service"       --repo "$REPO" --color "BFD4F2" --description "Backend service layer" --force 2>/dev/null || true
gh label create "pipeline"      --repo "$REPO" --color "D93F0B" --description "Classification pipeline" --force 2>/dev/null || true
gh label create "testing"       --repo "$REPO" --color "0075CA" --description "Tests" --force 2>/dev/null || true
echo "Labels created."

create_issue() {
  local title="$1"
  local labels="$2"
  local body_file="$3"
  echo "Creating: $title"
  gh issue create --repo "$REPO" --title "$title" --label "$labels" --body-file "$body_file"
}

# Create issues in dependency order
create_issue "S1-01: Project Scaffolding — Electron + React + TypeScript Setup" \
  "sprint-1,backend,foundation" \
  ".github/issues/01-project-scaffolding.md"

create_issue "S1-02: Shared TypeScript Types — IPC Contract & DB Models" \
  "sprint-1,backend,foundation" \
  ".github/issues/02-shared-types.md"

create_issue "S1-03: IPC Infrastructure & Preload Script" \
  "sprint-1,backend,foundation,ipc" \
  ".github/issues/03-ipc-infrastructure.md"

create_issue "S1-04: DuckDB Database Service — Connection & Schema Init" \
  "sprint-1,backend,database" \
  ".github/issues/04-duckdb-service.md"

create_issue "S1-05: Project Service & IPC Handlers" \
  "sprint-1,backend,service,ipc" \
  ".github/issues/05-project-service.md"

create_issue "S1-06: Recent Projects Service" \
  "sprint-1,backend,service,ipc" \
  ".github/issues/06-recent-projects-service.md"

create_issue "S1-07: Settings Service — LLM Provider Configuration" \
  "sprint-1,backend,service,ipc" \
  ".github/issues/07-settings-service.md"

create_issue "S1-08: Upload Service — CSV Parsing & Preview" \
  "sprint-1,backend,service,ipc" \
  ".github/issues/08-upload-service.md"

create_issue "S1-09: Canonicalization Agent (LLM)" \
  "sprint-1,backend,llm-agent" \
  ".github/issues/09-canonicalization-agent.md"

create_issue "S1-10: Canonicalization Service & Full CSV Import" \
  "sprint-1,backend,service,ipc" \
  ".github/issues/10-canonicalization-service.md"

create_issue "S1-11: ColabIP Service — Taxonomy & Rules Reader" \
  "sprint-1,backend,service,ipc" \
  ".github/issues/11-colabip-service.md"

create_issue "S1-12: Taxonomy Service & IPC Handlers" \
  "sprint-1,backend,service,ipc" \
  ".github/issues/12-taxonomy-service.md"

create_issue "S1-13: Supplier Service — CRUD & Category A" \
  "sprint-1,backend,service,ipc" \
  ".github/issues/13-supplier-service.md"

create_issue "S1-14: Research Agent (LLM)" \
  "sprint-1,backend,llm-agent" \
  ".github/issues/14-research-agent.md"

create_issue "S1-15: Supplier Research Service & IPC" \
  "sprint-1,backend,service,ipc" \
  ".github/issues/15-supplier-research-service.md"

create_issue "S1-16: Override Rules Service & Evaluation Engine" \
  "sprint-1,backend,service,ipc" \
  ".github/issues/16-rules-service.md"

create_issue "S1-17: Changelog Service — Audit Trail & Revert" \
  "sprint-1,backend,service,ipc" \
  ".github/issues/17-changelog-service.md"

create_issue "S1-18: Transactions Service — Query, Stats & Columns" \
  "sprint-1,backend,service,ipc" \
  ".github/issues/18-transactions-service.md"

create_issue "S1-19: Classification Agent (LLM)" \
  "sprint-1,backend,llm-agent,pipeline" \
  ".github/issues/19-classification-agent.md"

create_issue "S1-20: Classification Pipeline — Full Orchestration" \
  "sprint-1,backend,pipeline" \
  ".github/issues/20-classification-pipeline.md"

create_issue "S1-21: Reclassification Service" \
  "sprint-1,backend,service,ipc" \
  ".github/issues/21-reclassification-service.md"

create_issue "S1-22: Feedback Agent (LLM)" \
  "sprint-1,backend,llm-agent" \
  ".github/issues/22-feedback-agent.md"

create_issue "S1-23: Feedback Service — CRUD & Approval Workflow" \
  "sprint-1,backend,service,ipc" \
  ".github/issues/23-feedback-service.md"

create_issue "S1-24: Export Service — CSV Export" \
  "sprint-1,backend,service,ipc" \
  ".github/issues/24-export-service.md"

create_issue "S1-25: End-to-End Integration Tests" \
  "sprint-1,backend,testing" \
  ".github/issues/25-integration-tests.md"

echo ""
echo "All 25 Sprint 1 backend issues created successfully!"
echo "View them: gh issue list --repo $REPO --label sprint-1"
