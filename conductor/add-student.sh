#!/bin/bash

# This script is used to add user accounts to the Conductor, including sending
# an e-mail to them notifying them of account creation and account details.

set -e

source common.sh

if [[ $# != 1 ]]; then
    echo 'usage: add-student.sh netid'
    exit 1
fi

# The username of the student to be added
NETID=$1
# The password to use for this student
PW=$(generate_password)
# Whether the user already exists
EXISTS=$(check_user_exists $NETID)
# The hostname of the conductor host, to include in the account set up e-mail
HOSTNAME=$(hostname)

# Set GMAIL_USER to be the gmail account used to send e-mails from the autograder
if [[ -z "$GMAIL_USER" ]]; then
    echo GMAIL_USER must be a defined environment variable
    exit 1
fi

# Set GMAIL_PASS to be the password for $GMAIL_USER
if [[ -z "$GMAIL_PASS" ]]; then
    echo GMAIL_PASS must be a defined environment variable
    exit 1
fi

if [[ $EXISTS == 0 ]]; then
    HASH=$(node password_hash.js $PW)
    # Perform the actual user creation
    SQL_CMD="INSERT INTO users (user_name, password_hash, is_admin) VALUES \
             ('$NETID', '$HASH', false)"
    sudo -u postgres psql --tuples-only --username=postgres \
        --dbname=autograder --command="$SQL_CMD"

    # Set up some directories for this user account
    mkdir -p submissions/$NETID
    mkdir -p logs/$NETID

    # Save a plain text copy of passwords to refer to later. Is this good for
    # security? No, but the autograder does not store any sensitive information.
    echo $NETID $PW >> passwords
    echo $NETID $PW

    # Send an e-mail to the student notifying them of their account creation.
    # Right now, this is hard-coded to work for Rice University accounts but
    # could be easily extended.
    python send-autograder-email.py ${NETID}@rice.edu \
        "Habanero AutoGrader Account Creation" \
        "An account has been created for you on the Habanero AutoGrader with the username '$NETID' and password '$PW'. The Habanero AutoGrader is currently accessible at ${HOSTNAME}."
else
    echo User $NETID already exists
fi

