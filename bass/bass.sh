#!/bin/bash

set -e

if [[ $# != 5 ]]; then
    echo usage: bass.sh conductor-host conductor-port conductor-user \
        conductor-runs-dir backups-dir
    exit 1
fi

# The host of the conductor
CONDUCTOR=$1
# The port at which the conductor accepts HTTP requests
CONDUCTOR_PORT=$2
# A user account on the conductor host that has remote SSH access
CONDUCTOR_USER=$3
# The absolute path to the directory used to store final run files on the conductor
CONDUCTOR_RUNS_DIR=$4
# The absolute path on the local bass host to place saved files at
BACKUPS_DIR=$5

# When this script exits, be sure that it cleans up after itself
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

# Find the highest run ID for which all run IDs <= to it have completed
MAX_RUN=$(wget -qO- $CONDUCTOR:$CONDUCTOR_PORT/latest_complete_run)
if [[ "$MAX_RUN" == "INTERNAL FAILURE" ]]; then
    exit 1
elif [[ "$MAX_RUN" == "NO RUNS" ]]; then
    exit 1
fi

# Find the highest run ID for which we already have a local backup
ANY_BACKUPS=$(ls -l $BACKUPS_DIR | wc -l)
START_FROM=
if [[ $ANY_BACKUPS -eq 0 ]]; then
    # No backups have been transferred yet
    START_FROM=0
else
    MAX_TRANSFERRED=$(ls -l $BACKUPS_DIR | awk '{ print $9 }' | sort -n | tail -n 1)
    START_FROM=$(echo $MAX_TRANSFERRED + 1 | bc)
fi

# Print diagnostics on what we're backing up
echo $START_FROM \-\> $MAX_RUN

# If there are runs to back up, iterate over them and transfer the run files
# from the conductor to the bass. If the transfer is successful, we delete the
# uploaded student code from the conductor to save on space.
if [[ $START_FROM -le $MAX_RUN ]]; then
    for RUN in $(seq $START_FROM $MAX_RUN); do
        REMOTE_PATH=$(ssh $CONDUCTOR_USER@$CONDUCTOR "find $CONDUCTOR_RUNS_DIR -maxdepth 2 -name $RUN")
        if [[ ${#REMOTE_PATH} -ne 0 ]]; then
            echo "Downloading $RUN from \"$REMOTE_PATH\" to \"$BACKUPS_DIR/$RUN\""
            scp -q -r $CONDUCTOR_USER@$CONDUCTOR:$REMOTE_PATH $BACKUPS_DIR/$RUN
            echo "Done downloading $RUN"
            if [[ -f $BACKUPS_DIR/$RUN/student.zip ]]; then
                # Clean up the student.zip file on the conductor if we're 100%
                # sure we have it backed up. This is purely to save disk space
                # on the conductor
                ssh $CONDUCTOR_USER@$CONDUCTOR "rm $REMOTE_PATH/student.zip"
                echo "Done cleaning up student.zip for run $RUN"
            fi
        fi
    done
fi

cleanup
