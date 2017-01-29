#!/bin/bash

set -e

if [[ $# != 5 ]]; then
    echo usage: load-final-runs.sh conductor-host conductor-user backups-dir assignment-name staff-dir
    exit 1
fi

CONDUCTOR=$1
CONDUCTOR_USER=$2
BACKUPS_DIR=$3
ASSIGNMENT_NAME=$4
STAFF_DIR=$5

rm -rf $STAFF_DIR
mkdir -p $STAFF_DIR

ssh $CONDUCTOR_USER@$CONDUCTOR "~/habanero-autograder/conductor/get-final-runs-for-assignment.sh $ASSIGNMENT_NAME" > final-runs
for NETID in $(cat final-runs | awk '{ print $1 }'); do
    RUN_ID=$(cat final-runs | grep "^$NETID " | awk '{ print $2 }')
    echo $NETID $RUN_ID

    RUN_DIR=$BACKUPS_DIR/$RUN_ID
    if [[ ! -d $RUN_DIR ]]; then
        echo Missing run directory $RUN_DIR
        exit 1
    fi

    ssh $CONDUCTOR_USER@$CONDUCTOR "node ~/habanero-autograder/conductor/get_score_for_run.js $RUN_ID" > $NETID
done < final-runs

for NETID in $(cat final-runs | awk '{ print $1 }'); do
    if [[ -d $STAFF_DIR/$NETID ]]; then
        echo "Duplicate netid $NETID"
        exit 1
    fi

    cp -r $BACKUPS_DIR/$RUN_ID $STAFF_DIR/$NETID
    mv ./$NETID $STAFF_DIR/$NETID/score
done

rm final-runs

echo "Done!"

# ANY_BACKUPS=$(ls -l $BACKUPS_DIR | wc -l)
# START_FROM=
# if [[ $ANY_BACKUPS -eq 0 ]]; then
#     # No backups have been transferred yet
#     START_FROM=0
# else
#     MAX_TRANSFERRED=$(ls -l $BACKUPS_DIR | awk '{ print $9 }' | sort -n | tail -n 1)
#     START_FROM=$(echo $MAX_TRANSFERRED + 1 | bc)
# fi
# 
# echo $START_FROM \-\> $MAX_RUN
# 
# if [[ $START_FROM -le $MAX_RUN ]]; then
#     for RUN in $(seq $START_FROM $MAX_RUN); do
#         REMOTE_PATH=$(ssh $CONDUCTOR_USER@$CONDUCTOR "find $CONDUCTOR_RUNS_DIR -maxdepth 2 -name $RUN")
#         if [[ ${#REMOTE_PATH} -ne 0 ]]; then
#             echo "Downloading $RUN from \"$REMOTE_PATH\" to \"$BACKUPS_DIR/$RUN\""
#             scp -q -r $CONDUCTOR_USER@$CONDUCTOR:$REMOTE_PATH $BACKUPS_DIR/$RUN
#             echo "Done downloading $RUN"
#             if [[ -f $BACKUPS_DIR/$RUN/student.zip ]]; then
#                 # Clean up the student.zip file on the conductor if we're 100%
#                 # sure we have it backed up. This is purely to save disk space
#                 # on the conductor
#                 ssh $CONDUCTOR_USER@$CONDUCTOR "rm $REMOTE_PATH/student.zip"
#                 echo "Done cleaning up student.zip for run $RUN"
#             fi
#         fi
#     done
# fi
# 
# cleanup
