#!/bin/bash

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR=$SCRIPT_DIR/..

FILES=${ROOT_DIR}/conductor/app.js

for FILE in $FILES; do
    echo $FILE
    jshint $FILE
    echo
done
