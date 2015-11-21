#!/bin/bash

set -e

# Set up directory for storing student code
# Structure is:
#
#   submissions
#   |-| netid
#   |--| runid
#   |---| student.zip
#
mkdir -p submissions
mkdir -p submissions/admin

# Set up directory for storing student run logs
# Structure is:
#
#   logs
#   |-| netid
#   |--| runid
#   |---| local
#   |----| unit.log
#   |----| checkstyle.log
#   |----| findbugs.log
#   |---| remote
#   |----| perf.log
#
mkdir -p logs
mkdir -p logs/admin
