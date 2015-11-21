#!/bin/bash

set -e

DICT=password-seeds

if [[ ! -f $DICT ]]; then
    echo "This system appears to be missing $DICT"
    exit 1
fi

generate_password() {
    NWORDS=$(cat $DICT | wc -l)

    R1=$[ 1 + $[ RANDOM % $NWORDS ]]
    WORD1=$(sed "${R1}q;d" $DICT)

    R2=$[ 1 + $[ RANDOM % $NWORDS ]]
    WORD2=$(sed "${R2}q;d" $DICT)

    R3=$[ 1 + $[ RANDOM % $NWORDS ]]
    WORD3=$(sed "${R3}q;d" $DICT)

    PW=$WORD1-$WORD2-$WORD3

    echo $PW
}

check_user_exists() {
    NETID=$1

    CMD="SELECT * FROM users WHERE user_name='$NETID'"
    EXISTS=$(sudo -u postgres psql --tuples-only --username=postgres \
            --dbname=autograder --command="$CMD" | wc -l)

    if [[ $EXISTS == 1 ]]; then
        # Just one newline if user does not exist
        echo 0
    else
        echo 1
    fi
}
