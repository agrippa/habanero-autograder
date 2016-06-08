#!/bin/bash

# 'Kill' a job by altering its status in Postgres. Realistically, this doesn't
# change the actual state of the running job but simply makes it appear to have
# failed to the user.

set -e

if [[ $# != 1 ]]; then
    echo usage: manually_fail.sh run-id
    exit 1
fi

psql --dbname=autograder --user=postgres --command="UPDATE runs SET status='FAILED',finish_time=CURRENT_TIMESTAMP,cello_msg='Failed on server restart, please resubmit.' WHERE run_id=$1;"
