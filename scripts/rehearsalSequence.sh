#!/usr/bin/env bash
# Build a rehearsal Amplify branch end to end: 60-model baseline, then the exact SHA at stage 0, then stages 1..5.
# usage: scripts/rehearsalSequence.sh <branch> <sha>   (branch name SHORT: the data template size depends on the branch name length)
# DEV/REHEARSAL ONLY: refuses main, dev and anything not given explicitly.
set -u
B=${1:?branch}; SHA=${2:?sha}; A=d3dejqzs77khq6
case "$B" in main|dev) echo "refusing $B"; exit 2;; esac
BASE=2d7c44df
wait_job() { while true; do J=$(aws amplify list-jobs --app-id $A --branch-name "$B" --max-results 1 --query 'jobSummaries[0].[jobId,status]' --output text); case "$J" in *RUNNING*|*PENDING*|*PROVISIONING*) sleep 45;; *) echo "$J"; return;; esac; done; }
git push origin $BASE:refs/heads/$B 2>&1 | tail -1
aws amplify create-branch --app-id $A --branch-name "$B" --stage DEVELOPMENT --framework React --enable-auto-build --no-enable-pull-request-preview --environment-variables BCAT_DEV_STACK=true,PORTAL_PROD_ORIGIN=https://$B.$A.amplifyapp.com --ttl 5 --query branch.branchName --output text
sleep 60
S=$(date +%s); R=$(wait_job); echo "BASELINE $R in $(( $(date +%s) - S ))s"; case "$R" in *SUCCEED*) ;; *) exit 1;; esac
aws amplify update-branch --app-id $A --branch-name "$B" --environment-variables BCAT_DEV_STACK=true,PORTAL_PROD_ORIGIN=https://$B.$A.amplifyapp.com,BCAT_SCHEMA_STAGE=0 >/dev/null
git push --force origin $SHA:refs/heads/$B 2>&1 | tail -1
sleep 60
S=$(date +%s); R=$(wait_job); echo "STAGE 0 $R in $(( $(date +%s) - S ))s"; case "$R" in *SUCCEED*) ;; *) exit 1;; esac
exec /bin/bash "$(dirname "$0")/stageRun.sh" "$B" 1 5
