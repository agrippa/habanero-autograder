#!/bin/bash

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
LOG_DIR=$SCRIPT_DIR/conductor-logs

LOG_FILE_INDEX=1

while [[ -f $LOG_DIR/conductor.${LOG_FILE_INDEX}.out || \
         -f $LOG_DIR/conductor.${LOG_FILE_INDEX}.err ]]; do
    LOG_FILE_INDEX=$((LOG_FILE_INDEX + 1))
done

STDOUT_LOG_FILE=$LOG_DIR/conductor.${LOG_FILE_INDEX}.out
STDERR_LOG_FILE=$LOG_DIR/conductor.${LOG_FILE_INDEX}.err
echo Logging STDOUT to $STDOUT_LOG_FILE, STDERR to $STDERR_LOG_FILE

PORT=8081 node $SCRIPT_DIR/app.js $* 2> $STDERR_LOG_FILE 1> $STDOUT_LOG_FILE
