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

# A directory for storing instructor-provided testing files.
# The structure of the instructor-tests directory is:
#
# instructor-tests
# |-| assignment-id-0
# |--| pom.xml
# |--| instructor.zip
# |-| assignment-id-1
# ...
#
# Inside instructor.zip should be the file/folder hierarchy that is to be merged
# with the student code. There should be no conflicting files, so files should
# be carefully named. Any pom.xml uploaded with the student submission will be
# replaced with the provided one.
mkdir -p instructor-tests
