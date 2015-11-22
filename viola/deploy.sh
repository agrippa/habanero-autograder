#!/bin/bash

set -e

JARS="."
for F in $(ls lib/svnkit-1.8.11/lib/*.jar); do
    JARS="$JARS:$F"
done

echo $JARS

java -classpath $JARS Viola 8080
