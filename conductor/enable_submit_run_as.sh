#!/bin/bash

# A script for allowing the submit_run_as endpoint to be used to create job
# submissions from one user, but which are visible from another.

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
