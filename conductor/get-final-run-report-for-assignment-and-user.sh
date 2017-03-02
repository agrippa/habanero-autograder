#!/bin/bash

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

if [[ $# -ne 2 ]]; then
    echo 'usage: get-final-run-report-for-assignment-and-user.sh assignment-name user-name'
    exit 1
fi

ASSIGNMENT=$1
USER=$2

psql --quiet --dbname=autograder --user=postgres --command="SELECT assignment_id FROM assignments WHERE name='$ASSIGNMENT'" -t > tmp
if [[ $(cat tmp | wc -l) -ne 2 ]]; then
    echo Invalid output when selecting assignment id
    exit 1
fi
ASSIGNMENT_ID=$(head -n 1 tmp)

psql --quiet --dbname=autograder --user=postgres --command="SELECT user_id FROM users WHERE user_name='$USER'" -t > tmp
if [[ $(cat tmp | wc -l) -ne 2 ]]; then
    echo Invalid output when selecting user id
    exit 1
fi
USER_ID=$(head -n 1 tmp)

psql --quiet --dbname=autograder --user=postgres --command="SELECT max(final_run_id) from final_runs WHERE assignment_id=$ASSIGNMENT_ID AND user_id=$USER_ID group by assignment_id, user_id order by user_id;" -t > tmp
if [[ $(cat tmp | wc -l) -eq 1 ]]; then
    # No final run
    echo There does not exist a final run for user $USER on assignment $ASSIGNMENT
elif [[ $(cat tmp | wc -l) -eq 2 ]]; then
    # Final run
    FINAL_RUN_ID=$(head -n 1 tmp)

    psql --quiet --dbname=autograder --user=postgres --command="SELECT run_id FROM final_runs WHERE final_run_id=$FINAL_RUN_ID;" -t > tmp
    if [[ $(cat tmp | wc -l) -ne 2 ]]; then
        echo Invalid output when selecting run ID
        exit 1
    fi
    RUN_ID=$(head -n 1 tmp)
    echo Submission Report for $ASSIGNMENT
    echo
    echo The below information is automatically generated, and is not an official grade report. Your final grade is not guaranteed to be the same as below.
    echo This report is sent to ensure that the submission the teaching staff sees matches what you expect.
    echo If it does not match what you expect for $ASSIGNMENT, please contact the teaching staff at comp322-staff@rice.edu.
    echo
    echo User $USER has run $RUN_ID selected for assignment $ASSIGNMENT.
    node $SCRIPT_DIR/get_slip_days_for_run.js $RUN_ID | grep -v CST
    node $SCRIPT_DIR/get_score_for_run.js $RUN_ID | grep -v CST
    echo
else
    echo Invalid output when selecting final run ID
    exit 1
fi
