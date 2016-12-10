#!/bin/bash

# A script for preventing new runs from being submitted, useful for entering a
# maintenance period.

set -e

if [[ $# != 1 ]]; then
    echo 'usage: block_runs.sh enable|disable'
    exit 1
fi

if [[ "$1" == "enable" ]]; then
    touch block_submissions
else
    rm -f block_submissions
fi
