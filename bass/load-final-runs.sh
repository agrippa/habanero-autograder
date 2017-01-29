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
    RUN_ID=$(cat final-runs | grep "^$NETID " | awk '{ print $2 }')
    if [[ -d $STAFF_DIR/$NETID ]]; then
        echo "Duplicate netid $NETID"
        exit 1
    fi

    echo Copying $BACKUPS_DIR/$RUN_ID to $STAFF_DIR/$NETID

    cp -r $BACKUPS_DIR/$RUN_ID $STAFF_DIR/$NETID
    mv ./$NETID $STAFF_DIR/$NETID/score
done

rm final-runs

echo "Done!"
