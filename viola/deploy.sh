#!/bin/bash

# Deployment script for the viola component.

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
LOG_DIR=$SCRIPT_DIR/viola-logs

if [[ $# != 3 ]]; then
    echo 'usage: deploy.sh conductor-host conductor-port conductor-user'
    exit 1
fi

# The host at which the conductor can be found
CONDUCTOR_HOST=$1
# The port at which the conductor is accepting HTTP requests
CONDUCTOR_PORT=$2
# An SSH user on the conductor host
CONDUCTOR_USER=$3

LOG_FILE_INDEX=1

while [[ -f $LOG_DIR/viola.${LOG_FILE_INDEX}.out || \
         -f $LOG_DIR/viola.${LOG_FILE_INDEX}.err ]]; do
    LOG_FILE_INDEX=$((LOG_FILE_INDEX + 1))
done

STDOUT_LOG_FILE=$LOG_DIR/viola.${LOG_FILE_INDEX}.out
STDERR_LOG_FILE=$LOG_DIR/viola.${LOG_FILE_INDEX}.err
echo Logging STDOUT to $STDOUT_LOG_FILE, STDERR to $STDERR_LOG_FILE

java -classpath .:commons-io-2.4.jar Viola 8080 $CONDUCTOR_HOST \
    $CONDUCTOR_PORT $CONDUCTOR_USER 2> $STDERR_LOG_FILE 1> $STDOUT_LOG_FILE
