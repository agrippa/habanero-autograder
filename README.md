The **Habanero Autograder** is a comprehensive tool for **automatically grading
parallel JVM programs for both correctness and performance**. It differentiates
itself from other autograders in its focus on performance testing as a
first-class citizen of the evaluation process.


The Habanero Autograder can be broken down in to four independent
(orchestrally-themed) components: the Conductor, the Viola, the Cello, and the Bass:

1. **Conductor**: the Conductor is a Node.js server responsible for serving up
the webpages that constitute the user-facing part of the Autograder. The 
Conductor also coordinates the asynchronous execution of all tests on the 
backend, and other interactions between the other three components.
2. **Viola**: the Viola is a small Java HTTP server that is responsible
for running lightweight correctness tests for each user submission. The Viola
accepts job requests from the Conductor, processes those jobs through a multi-stage parallel
pipeline, and reports back to the Conductor when the tests
complete. The Viola is architected such that it can be co-located with the 
Conductor, or run on a separate, dedicated machine.
3. **Cello**: the Cello consists of a set of bash scripts used on the 
cluster to handle performance testing of each user submission. These bash
scripts are generated by the Conductor for each user submission,
and then submitted to a computer cluster. The Conductor periodically polls on
the completion of the Cello job for each user submission. A Cello job is only
launched once the Viola tests complete.
4. **Bass**: Once both the Viola and Cello tests have completed, the 
Bass component is responsible for saving the user submission and its results to
off-site storage to ensure that no student data is lost. This is done with a
pull model, with a daemon co-located with the offsite storage periodically
fetching any newly completed runs from the Conductor.

The top-level directory for each component includes installation instructions.

If you have any questions, comments, or difficulties using the Habanero
Autograder please contact the author (Max Grossman) at jmaxg3@gmail.com.
