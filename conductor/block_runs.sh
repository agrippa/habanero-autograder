#!/bin/bash

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
