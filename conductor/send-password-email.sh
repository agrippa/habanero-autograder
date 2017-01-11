#!/bin/bash

set -e

source common.sh

if [[ $# != 1 ]]; then
    echo 'usage: send-password-email.sh netid'
    exit 1
fi

NETID=$1
PW=$(cat passwords | grep "^$NETID " | awk '{ print $2 }')

python send-autograder-email.py ${NETID}@rice.edu \
    "Habanero AutoGrader Account Creation" \
    "An account has been created for you on the Habanero AutoGrader with the username '$NETID' and password '$PW'. The Habanero AutoGrader is currently accessible at ${HOSTNAME}."
