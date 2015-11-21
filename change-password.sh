#!/bin/bash

set -e

source common.sh

if [[ $# != 1 ]]; then
    echo 'usage: add-student.sh netid'
    exit 1
fi

NETID=$1
PW=$(generate_password)
EXISTS=$(check_user_exists $NETID)

if [[ $EXISTS == 1 ]]; then
    HASH=$(nodejs password_hash.js $PW)
    SQL_CMD="UPDATE users SET password_hash='$HASH' WHERE user_name='$NETID'"
    sudo -u postgres psql --tuples-only --username=postgres \
        --dbname=autograder --command="$SQL_CMD"

    echo $NETID $PW >> passwords
    echo $NETID $PW
else
    echo User $NETID does not exist, cannot change their password
fi

