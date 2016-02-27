#!/bin/bash

set -e

if [[ $# != 1 ]]; then
    echo 'usage: enable_submit_run_as.sh enable|disable'
    exit 1
fi

if [[ "$1" == "enable" ]]; then
    touch enable_run_as
else
    rm -f enable_run_as
fi
