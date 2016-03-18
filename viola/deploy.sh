#!/bin/bash

set -e

if [[ $# != 3 ]]; then
    echo 'usage: deploy.sh conductor-host conductor-port conductor-user'
    exit 1
fi

CONDUCTOR_HOST=$1
CONDUCTOR_PORT=$2
CONDUCTOR_USER=$3

JARS=".:commons-io-2.4.jar"
echo $JARS

java -classpath $JARS Viola 8080 $CONDUCTOR_HOST $CONDUCTOR_PORT $CONDUCTOR_USER
