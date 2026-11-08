#!/usr/bin/env bash
# READ-ONLY. Prints the recovery commands for a production data stack stuck in UPDATE_ROLLBACK_FAILED. It runs ONLY
# describe/list calls; it never runs continue-update-rollback (a human does).
# usage: scripts/prodRecoveryPlan.sh [rootStackName]
set -u
ROOT=${1:-amplify-d3dejqzs77khq6-main-branch-0feb70fa58}
PFX=$(echo "$ROOT" | sed -E 's/^(.*-branch-[0-9a-f]{8}).*/\1/')   # nested stacks carry the truncated prefix
st() { aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>&1; }
DATA=$(aws cloudformation describe-stack-resources --stack-name "$ROOT" --query "StackResources[?LogicalResourceId=='data7552DF31'].PhysicalResourceId" --output text)
echo "root:  $ROOT = $(st $ROOT)"
DATA=$(echo "$DATA" | sed -E "s#^.*stack/([^/]+)/.*#\1#")
echo "data:  $DATA = $(st "$DATA")"
echo "nested model stacks by status:"
aws cloudformation list-stacks --query "StackSummaries[?contains(StackName,'${PFX}') && contains(StackName,'amplifyData') && StackStatus!='DELETE_COMPLETE'].StackStatus" --output text | tr '\t' '\n' | sort | uniq -c
INPROG=$(aws cloudformation list-stacks --stack-status-filter UPDATE_ROLLBACK_IN_PROGRESS UPDATE_COMPLETE_CLEANUP_IN_PROGRESS UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS --query "StackSummaries[?contains(StackName,'${PFX}') && contains(StackName,'amplifyData')].StackName" --output text | wc -w)
echo "nested stacks still settling: $INPROG   (do NOT run continue-update-rollback until this is 0 and root/data both read UPDATE_ROLLBACK_FAILED)"
echo
echo "== resources that failed to roll back (nested stack -> resource) =="
SKIPS=()
for N in $(aws cloudformation list-stacks --stack-status-filter UPDATE_ROLLBACK_FAILED --query "StackSummaries[?contains(StackName,'${PFX}') && contains(StackName,'amplifyData')].StackName" --output text); do
  LOGICAL=$(aws cloudformation list-stack-resources --stack-name "${DATA}" --query "StackResourceSummaries[?ResourceType=='AWS::CloudFormation::Stack' && contains(PhysicalResourceId,'/$N/')].LogicalResourceId" --output text)
  for R in $(aws cloudformation describe-stack-resources --stack-name "$N" --query "StackResources[?ResourceStatus=='UPDATE_FAILED'].LogicalResourceId" --output text); do
    echo "  $LOGICAL -> $R"; SKIPS+=("data7552DF31.$LOGICAL.$R")
  done
done
echo
echo "== STEP 1 (try the plain retry first; run only when nothing is settling) =="
echo "aws cloudformation continue-update-rollback --stack-name $ROOT"
echo "   then poll:  aws cloudformation describe-stacks --stack-name $ROOT --query 'Stacks[0].StackStatus' --output text   (expect UPDATE_ROLLBACK_COMPLETE)"
echo
echo "== STEP 2 (ONLY if step 1 ends UPDATE_ROLLBACK_FAILED again with the same Custom::AmplifyDynamoDBTable resources) =="
echo "aws cloudformation continue-update-rollback --stack-name $ROOT \\"
echo "  --resources-to-skip ${SKIPS[*]:-<none-found>}"
echo "   (skipping a table custom resource leaves that table as it is now: PITR may be ON for a few tables the failed update reached. Harmless; no data or table is touched.)"
