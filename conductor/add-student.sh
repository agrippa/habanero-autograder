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

if [[ $EXISTS == 0 ]]; then
    HASH=$(nodejs password_hash.js $PW)
    SQL_CMD="INSERT INTO users (user_name, password_hash, is_admin) VALUES \
             ('$NETID', '$HASH', false)"
    sudo -u postgres psql --tuples-only --username=postgres \
        --dbname=autograder --command="$SQL_CMD"

    mkdir -p submissions/$NETID
    mkdir -p logs/$NETID

    echo $NETID $PW >> passwords
    echo $NETID $PW
else
    echo User $NETID already exists
fi
