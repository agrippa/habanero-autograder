#!/bin/bash

set -e

for NETID in $(ls submissions/); do
    for RUN in $(ls submissions/$NETID); do
        RUN_PATH=submissions/$NETID/$RUN
        CHECKSTYLE_PATH=$RUN_PATH/checkstyle.txt
        COMPILE_PATH=$RUN_PATH/compile.txt
        CORRECT_PATH=$RUN_PATH/correct.txt

        CHECKSTYLE_PASSED=0
        COMPILE_PASSED=0
        CORRECTNESS_PASSED=0
        
        if [[ -d $RUN_PATH ]]; then
            if [[ -f $CHECKSTYLE_PATH ]]; then
                CHECKSTYLE_LC=$(cat $CHECKSTYLE_PATH | wc -l)
                if [[ $CHECKSTYLE_LC == 3 ]]; then
                    CHECKSTYLE_PASSED=1
                fi
            fi
            if [[ $CHECKSTYLE_PASSED == 1 ]]; then
                if [[ -f $COMPILE_PATH ]]; then
                    BUILD_SUCCESS=$(cat $COMPILE_PATH | grep "BUILD SUCCESS" | wc -l)
                    if [[ $BUILD_SUCCESS != 0 ]]; then
                        COMPILE_PASSED=1
                    fi
                fi
            fi
            if [[ $COMPILE_PASSED == 1 ]]; then
                if [[ -f $CORRECT_PATH ]]; then
                    FAILURES_SINGULAR=$(cat $CORRECT_PATH | grep " failures:" | wc -l)
                    FAILURES_PLURAL=$(cat $CORRECT_PATH | grep " failure:" | wc -l)
                    if [[ $FAILURES_SINGULAR == 0 && $FAILURES_PLURAL == 0 ]]; then
                        CORRECTNESS_PASSED=1
                    fi
                fi
            fi
        fi

        QUERY="UPDATE runs SET passed_checkstyle="
        if [[ $CHECKSTYLE_PASSED == 1 ]]; then
            QUERY="${QUERY}true"
        else
            QUERY="${QUERY}false"
        fi
        QUERY="${QUERY},compiled="
        if [[ $COMPILE_PASSED == 1 ]]; then
            QUERY="${QUERY}true"
        else
            QUERY="${QUERY}false"
        fi
        QUERY="${QUERY},passed_all_correctness="
        if [[ $CORRECTNESS_PASSED == 1 ]]; then
            QUERY="${QUERY}true"
        else
            QUERY="${QUERY}false"
        fi
        QUERY="$QUERY WHERE run_id=${RUN}"

        psql --dbname=autograder --user=postgres --command="$QUERY"
    done
done
