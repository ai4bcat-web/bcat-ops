#!/usr/bin/env bash
# Grow an Amplify branch's schema stage by stage (Docs/tms-build/AW_STAGED_DEPLOY.md).
# usage: scripts/stageRun.sh <branch> <fromStage> <toStage>   (e.g. rehearsal2 1 4)
# Waits for any running job first, then for each k: sets BCAT_SCHEMA_STAGE=k (preserving the other branch env vars),
# starts a RELEASE job, waits for SUCCEED, prints the elapsed time. Stops at the first failure. Never lowers a stage.
# DEV/REHEARSAL BRANCHES ONLY: refuses `main`.
set -u
B=${1:?branch}; FROM=${2:?from}; TO=${3:?to}; A=d3dejqzs77khq6
[ "$B" = "main" ] && { echo "refusing main"; exit 2; }
wait_job() { while true; do J=$(aws amplify list-jobs --app-id $A --branch-name "$B" --max-results 1 --query 'jobSummaries[0].[jobId,status]' --output text); case "$J" in *RUNNING*|*PENDING*|*PROVISIONING*) sleep 45;; *) echo "$J"; return;; esac; done; }
echo "waiting for the running job: $(wait_job)"
for k in $(seq "$FROM" "$TO"); do
  S=$(date +%s)
  ENV=$(aws amplify get-branch --app-id $A --branch-name "$B" --query branch.environmentVariables --output json | python3 -c "import json,sys; d=json.load(sys.stdin); d['BCAT_SCHEMA_STAGE']='$k'; print(','.join(f'{a}={b}' for a,b in d.items()))")
  aws amplify update-branch --app-id $A --branch-name "$B" --environment-variables "$ENV" >/dev/null
  JOB=$(aws amplify start-job --app-id $A --branch-name "$B" --job-type RELEASE --query 'jobSummary.jobId' --output text)
  sleep 30
  R=$(wait_job); E=$(( $(date +%s) - S ))
  echo "STAGE $k job $JOB: $R in ${E}s ($(date +%H:%M:%S))"
  case "$R" in *SUCCEED*) ;; *) echo "STOP at stage $k"; exit 1;; esac
done
echo "ALL STAGES DONE"
