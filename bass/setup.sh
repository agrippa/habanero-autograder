#!/bin/bash

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

if [[ $# != 5 ]]; then
    echo usage: setup.sh user-to-run-as conductor-host conductor-port \
        conductor-user conductor-runs-dir
    exit 1
fi

# A user account on the local bass host to run the bass script as
USER_TO_RUN_AS=$1
# The hostname where the conductor is located
CONDUCTOR=$2
# The port at which the conductor accepts HTTP requests
CONDUCTOR_PORT=$3
# A user account on the conductor with SSH access and permissions on the conductor files
CONDUCTOR_USER=$4
# The absolute path of the run files directory on the conductor
CONDUCTOR_RUNS_DIR=$5

if [[ "$(id -u)" != "0" ]]; then
    echo "This script must be run as root" 1>&2
    exit 1
fi

if [[ ! -f /etc/crontab ]]; then
    touch /etc/crontab
fi

EXISTS=$(cat /etc/crontab | grep 'bass\.sh' | wc -l)

if [[ $EXISTS == 1 ]]; then
    echo CRON job for Bass component appears to already exist on this machine
    exit 1
fi

# Run every hour, five minutes after the hour
echo -e "5\t*\t*\t*\t*\t$USER_TO_RUN_AS\t$SCRIPT_DIR/bass.sh $CONDUCTOR $CONDUCTOR_PORT $CONDUCTOR_USER $CONDUCTOR_RUNS_DIR $SCRIPT_DIR/backups" >> /etc/crontab
