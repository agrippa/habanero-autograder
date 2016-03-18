#!/bin/bash

set -e

if [[ $# != 5 ]]; then
    echo usage: bass.sh conductor-host conductor-port conductor-user \
        conductor-runs-dir backups-dir
    exit 1
fi

CONDUCTOR=$1
CONDUCTOR_PORT=$2
CONDUCTOR_USER=$3
CONDUCTOR_RUNS_DIR=$4
BACKUPS_DIR=$5

function cleanup() {
    rm -f $BACKUPS_DIR/dont_run
}
trap cleanup SIGHUP SIGINT SIGTERM EXIT

# prevent multiple scripts from running at once
if [[ -f $BACKUPS_DIR/dont_run ]]; then
    echo Exiting early due to dont_run file
    exit 0
fi
touch $BACKUPS_DIR/dont_run

MAX_RUN=$(wget -qO- $CONDUCTOR:$CONDUCTOR_PORT/latest_complete_run)
if [[ "$MAX_RUN" == "INTERNAL FAILURE" ]]; then
    exit 1
elif [[ "$MAX_RUN" == "NO RUNS" ]]; then
    exit 1
fi

ANY_BACKUPS=$(ls -l $BACKUPS_DIR | wc -l)
START_FROM=
if [[ $ANY_BACKUPS -eq 0 ]]; then
    # No backups have been transferred yet
    START_FROM=0
else
    MAX_TRANSFERRED=$(ls -l $BACKUPS_DIR | awk '{ print $9 }' | sort -n | tail -n 1)
    START_FROM=$(echo $MAX_TRANSFERRED + 1 | bc)
fi

if [[ $START_FROM -le $MAX_RUN ]]; then
    for RUN in $(seq $START_FROM $MAX_RUN); do
        REMOTE_PATH=$(ssh $CONDUCTOR_USER@$CONDUCTOR "find $CONDUCTOR_RUNS_DIR -name $RUN")
        if [[ ${#REMOTE_PATH} -ne 0 ]]; then
            echo $RUN
            scp -r $CONDUCTOR_USER@$CONDUCTOR:$REMOTE_PATH $BACKUPS_DIR/$RUN
        fi
    done
fi

cleanup
