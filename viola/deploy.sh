#!/bin/bash

set -e

if [[ $# != 2 ]]; then
    echo 'usage: deploy.sh conductor-host conductor-port'
    exit 1
fi

CONDUCTOR_HOST=$1
CONDUCTOR_PORT=$2

JARS="."
for F in $(ls lib/svnkit-1.8.11/lib/*.jar); do
    JARS="$JARS:$F"
done

echo $JARS

java -classpath $JARS Viola 8080 $CONDUCTOR_HOST $CONDUCTOR_PORT
