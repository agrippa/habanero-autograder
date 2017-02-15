#!/bin/bash

set -e

if [[ $# -ne 1 ]]; then
    echo 'usage: get-final-runs-for-assignment.sh assignment-name'
    exit 1
fi

ASSIGNMENT=$1

psql --quiet --dbname=autograder --user=postgres --command="SELECT assignment_id FROM assignments WHERE name='$ASSIGNMENT'" -t > tmp
if [[ $(cat tmp | wc -l) -ne 2 ]]; then
    echo Invalid output when selecting assignment id
    exit 1
fi

ASSIGNMENT_ID=$(head -n 1 tmp)

psql --quiet --dbname=autograder --user=postgres \
    --command="SELECT max(final_run_id), assignment_id, user_id from final_runs WHERE assignment_id=$ASSIGNMENT_ID group by assignment_id, user_id order by user_id;" -t > tmp

while read line; do
    if [[ ${#line} -eq 0 ]]; then
        # Skip empty lines
        continue
    fi
    FINAL_RUN_ID=$(echo $line | awk '{ print $1 }')
    USER_ID=$(echo $line | awk '{ print $5 }')

    USER_NAME=$(psql --quiet --dbname=autograder --user=postgres --command="SELECT user_name FROM users WHERE user_id=$USER_ID" -t)
    RUN_ID=$(psql --quiet --dbname=autograder --user=postgres --command="SELECT run_id FROM final_runs WHERE final_run_id=$FINAL_RUN_ID" -t)

    echo $USER_NAME $RUN_ID
done < tmp
