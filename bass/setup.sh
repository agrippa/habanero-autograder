#!/bin/bash

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

if [[ $# != 5 ]]; then
    echo usage: setup.sh user-to-run-as conductor-host conductor-port \
        conductor-user conductor-runs-dir
    exit 1
fi

USER_TO_RUN_AS=$1
CONDUCTOR=$2
CONDUCTOR_PORT=$3
CONDUCTOR_USER=$4
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

echo -e "0\t3\t*\t*\t*\t$USER_TO_RUN_AS\t$SCRIPT_DIR/bass.sh $CONDUCTOR $CONDUCTOR_PORT $CONDUCTOR_USER $CONDUCTOR_RUNS_DIR $SCRIPT_DIR/backups" >> /etc/crontab
