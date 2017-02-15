var fs = require('fs-extra');
var pg = require('pg');

var PERF_TEST_LBL = 'HABANERO-AUTOGRADER-PERF-TEST';

// All run statuses
var TESTING_CORRECTNESS_STATUS = 'TESTING CORRECTNESS';
var IN_CLUSTER_QUEUE_STATUS = 'IN CLUSTER QUEUE';
var TESTING_PERFORMANCE_STATUS = 'TESTING PERFORMANCE';
var FINISHED_STATUS = 'FINISHED';
var CANCELLED_STATUS = 'CANCELLED';
var FAILED_STATUS = 'FAILED';

// Account credentials to use when connecting to a local Postgres instance used
// as a persistent store for autograder user accounts, assignment info, and run
// info.
var POSTGRES_USERNAME = process.env.PGSQL_USER || 'postgres';
var POSTGRES_PASSWORD = process.env.PGSQL_PASSWORD || 'foobar';
var POSTGRES_USER_TOKEN = null;
if (POSTGRES_PASSWORD.length === 0) {
  POSTGRES_USER_TOKEN = POSTGRES_USERNAME;
} else {
  POSTGRES_USER_TOKEN = POSTGRES_USERNAME + ":" + POSTGRES_PASSWORD;
}

var excessiveFileSizeMsg = 'The submission appears to perform excessive ' +
    'prints, resulting in large log files. Please reduce the prints performed ' +
    'and resubmit. A truncated version of your output is included below.';
// Limit the size of files student runs can produce.
var MAX_FILE_SIZE = 10 * 1024 * 1024;
// Account for inserted error message and two new lines
var MAX_DISPLAY_FILE_SIZE = MAX_FILE_SIZE + excessiveFileSizeMsg.length + 2;

var dont_display = ['profiler.txt'];
var conString = "postgres://" + POSTGRES_USER_TOKEN + "@localhost/autograder";

// Logging utility, includes a timestamp with the log message
function log(msg) {
    console.log(new Date().toLocaleString() + ' ' + msg);
}

// Issue a query to the configured Postgres instance, passing the callback cb
// the results (either an error or the output of the query).
function pgquery_internal(query, query_args, cb) {
  log('pgquery: acquiring PGSQL client...');
  pg.connect(conString, function(err, client, done) {
      log("pgquery: finished acquiring PGSQL client, err=" + err);
      if (err) {
          log('pgquery: hit an err = ' + err);
          done();
          return cb(err, null);
      } else {
          var q = client.query(query, query_args);
          q.on('row', function(row, result) { result.addRow(row); });
          q.on('error', function(err, result) {
              done();
              return cb(err, null);
          });
          q.on('end', function(result) {
              done();
              return cb(null, result.rows);
          });
      }
  });
}

// Check if the provided array contains a specified value.
function arr_contains(target, arr) {
  for (var i = 0; i < arr.length; i++) {
    if (target === arr[i]) {
      return true;
    }
  }
  return false;
}

// Return the maximum value stored in a list.
function max_internal(l) {
    var m = l[0];
    for (var i = 1; i < l.length; i++) {
        if (l[i] > m) m = l[i];
    }
    return m;
}

// Get a human-readable label for each test output file to display alongside
// that file's contents in the autograder.
function get_default_file_lbl(file) {
    if (file === 'cluster-stderr.txt') {
        return 'Cluster STDERR';
    } else if (file === 'cluster-stdout.txt') {
        return 'Cluster STDOUT';
    } else if (file === 'compile.txt') {
        return 'Compilation';
    } else if (file === 'correct.txt') {
        return 'Correctness Tests';
    } else if (file === 'files.txt') {
        return 'Required Files Report';
    } else if (file === 'tree.txt') {
        return 'Submitted Files Report';
    } else if (file === 'findbugs.txt') {
        return 'FindBugs Analysis';
    } else if (string_starts_with(file, 'performance.') && string_ends_with(file, '.txt')) {
        var tokens = file.split('.');
        return 'Performance Tests (' + tokens[1] + ' cores)';
    } else {
        return file.charAt(0).toUpperCase() + file.substring(1, file.length - 4);
    }
}

// Get the size of the file at path, in bytes.
function get_file_size_internal(path) {
    var stats = fs.statSync(path);
    return stats.size;
}

// A simple utility function for parsing a list of integers expressed as a
// comma-separated string.
function parse_comma_separated_ints_internal(ncores_str) {
    var tokens = ncores_str.split(',');
    var ncores = [];
    for (var t = 0; t < tokens.length; t++) {
        ncores.push(parseInt(tokens[t]));
    }
    return ncores;
}

// Find the metadata for a performance test given its name.
function find_performance_test_with_name_and_cores(name, cores, rubric) {
  for (var p = 0; p < rubric.performance.tests.length; p++) {
    if (rubric.performance.tests[p].testname === name &&
            rubric.performance.tests[p].ncores === cores) {
      return rubric.performance.tests[p];
    }
  }
  return null;
}

// Find the metadata for a correctness test given its name.
function find_correctness_test_with_name(name, rubric) {
  for (var c = 0; c < rubric.correctness.length; c++) {
    if (rubric.correctness[c].testname === name) {
      return rubric.correctness[c];
    }
  }
  return null;
}

// Utility for checking if a string starts with the specified prefix.
function string_starts_with(st, prefix) {
  return st.slice(0, prefix.length) === prefix;
}

// Utility for checking if a string ends with the specified suffix.
function string_ends_with(st, suffix) {
    return st.indexOf(suffix, st.length - suffix.length) !== -1;
}

// Parse the output of a performance test for a non-empty STDERR. Non-empty
// STDERR may indicate a failed test, so we conservatively mark it so.
function check_for_empty_stderr_internal(lines) {
  var i = lines.length - 1;
  while (i >= 0 && lines[i] !== '======= STDERR =======') {
    i--;
  }
  i++;
  var any_nonempty_lines = false;
  for (; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      any_nonempty_lines = true;
      break;
    }
  }
  return any_nonempty_lines;
}

// Check if a run has finished successfully, i.e. has not failed and was not
// cancelled.
function run_completed(run_status) {
  return run_status !== FAILED_STATUS && run_status !== CANCELLED_STATUS;
}

// Indicate that some validation of instructor-uploaded files has failed.
function failed_validation_internal(err_msg) {
    log('failed_validation: ' + err_msg);
    return {success: false, msg: err_msg};
}

// Load the instructor-provided grading rubric and verify that it contains all
// of the fields it is expected to contain.
function load_and_validate_rubric_internal(rubric_file) {
  var rubric = null;
  try {
    rubric = JSON.parse(fs.readFileSync(rubric_file));
  } catch (err) {
    return failed_validation_internal('Failed to parse rubric JSON: ' + err.message);
  }

  if (!rubric.hasOwnProperty('correctness')) {
    return failed_validation_internal('Rubric is missing correctness section');
  }
  if (!rubric.hasOwnProperty('performance')) {
    return failed_validation_internal('Rubric is missing performance section');
  }
  if (!rubric.hasOwnProperty('style')) {
    return failed_validation_internal('Rubric is missing style section');
  }

  if (!rubric.performance.hasOwnProperty('tests')) {
    return failed_validation_internal('Rubric is missing tests field of performance ' +
            'section');
  }

  if (rubric.performance.tests.length > 0 &&
          !rubric.performance.hasOwnProperty('characteristic_test')) {
    return failed_validation_internal('Rubric is missing characteristic_test field of ' +
            'performance section');
  }

  for (var c = 0; c < rubric.correctness.length; c++) {
    if (!rubric.correctness[c].hasOwnProperty('testname')) {
      return failed_validation_internal('Correctness test is missing name');
    }
    if (!rubric.correctness[c].hasOwnProperty('points_worth') ||
        rubric.correctness[c].points_worth < 0.0) {
      return failed_validation_internal('Correctness test is missing valid points_worth');
    }
  }

  for (var p = 0; p < rubric.performance.tests.length; p++) {
    if (!rubric.performance.tests[p].hasOwnProperty('testname')) {
      return failed_validation_internal('Performance test is missing name');
    }
    if (!rubric.performance.tests[p].hasOwnProperty('points_worth')) {
      return failed_validation_internal('Performance test is missing points_worth');
    }
    if (!rubric.performance.tests[p].hasOwnProperty('ncores')) {
        return failed_validation_internal('Performance test is missing ncores');
    }
    if (!rubric.performance.tests[p].hasOwnProperty('grading')) {
      return failed_validation_internal('Performance test is missing speedup grading');
    }
    var points_worth = rubric.performance.tests[p].points_worth;

    for (var g = 0; g < rubric.performance.tests[p].grading.length; g++) {
      if (!rubric.performance.tests[p].grading[g].hasOwnProperty('bottom_inclusive')) {
        return failed_validation_internal('Performance test grading is missing bottom_inclusive');
      }
      if (!rubric.performance.tests[p].grading[g].hasOwnProperty('top_exclusive')) {
        return failed_validation_internal('Performance test grading is missing top_exclusive');
      }
      if (!rubric.performance.tests[p].grading[g].hasOwnProperty('points_off')) {
        return failed_validation_internal('Performance test grading is missing points_off');
      }
      if (rubric.performance.tests[p].grading[g].points_off > points_worth) {
        return failed_validation_internal('Performance test grading is more than points_worth');
      }
    }
  }

  if (!rubric.style.hasOwnProperty('points_per_error')) {
    return failed_validation_internal('Style section is missing points_per_error');
  }
  if (!rubric.style.hasOwnProperty('max_points_off')) {
    return failed_validation_internal('Style section is missing max_points_off');
  }

  return { success: true, rubric: rubric };
}

// Conductor-local assignment directory path
function assignment_path_internal(assignment_id) {
    return __dirname + '/instructor-tests/' + assignment_id;
}

// Path to the local rubric file on the conductor.
function rubric_file_path_internal(assignment_id) {
    return assignment_path_internal(assignment_id) + '/rubric.json';
}

function load_log_files_internal(run_dir) {
    var cello_err = null;
    var log_files = {};

    fs.readdirSync(run_dir).forEach(function(file) {
        if (file.indexOf('.txt', file.length - '.txt'.length) !== -1 &&
            !arr_contains(file, dont_display)) {
                var path = run_dir + '/' + file;
                var file_size = get_file_size_internal(path);
                if (file_size <= MAX_DISPLAY_FILE_SIZE) {
                    var contents = fs.readFileSync(path, 'utf8');
                    log_files[file] = { contents: contents,
                        lbl: get_default_file_lbl(file) };

                    if (cello_err === null) {
                        if (file === 'cluster-stdout.txt') {
                            var lines = contents.split('\n');
                            for (var i = 0; i < lines.length; i++) {
                                if (string_starts_with(lines[i], 'AUTOGRADER-ERROR')) {
                                    cello_err = lines[i].substring(17);
                                    break;
                                } else if (string_starts_with(lines[i], '[ERROR]')) {
                                    cello_err = 'Your submission ' +
                                        'appears to have failed to ' +
                                        'compile on the cluster, please ' +
                                        'check the Cluster STDOUT view ' +
                                        'for lines starting with "[ERROR]"';
                                    break;
                                }
                            }
                        } else if (file === 'cluster-stderr.txt' && file_size > 0) {
                            cello_err = contents;
                        }
                    }
                } else {
                    log_files[file] = {
                        contents: 'Unusually large file, unable to display.',
                        lbl: get_default_file_lbl(file) };
                }
            }
    });

    return {cello_err: cello_err,
            log_files: log_files};
}

function calculate_score_internal(assignment_id, log_files, ncores, run_status, run_id) {
    var rubric_file = rubric_file_path_internal(assignment_id);
    var max_n_cores = max_internal(ncores);

    var correctness_comments = [];
    var performance_comments = [];
    var style_comments = [];

    var validated = load_and_validate_rubric_internal(rubric_file);
    if (!validated.success) {
        log('calculate_score: failed loading rubric, ' + validated.msg);
        return null;
    }
    var rubric = validated.rubric;

    var total_possible = 0.0;
    var total_correctness_possible = 0.0;
    for (var c = 0; c < rubric.correctness.length; c++) {
        var correctness_item = rubric.correctness[c];
        total_possible += correctness_item.points_worth;
        total_correctness_possible += correctness_item.points_worth;
    }
    var total_performance_possible = 0.0;
    for (var p = 0; p < rubric.performance.tests.length; p++) {
        var performance_item = rubric.performance.tests[p];
        total_possible += performance_item.points_worth;
        total_performance_possible += performance_item.points_worth;
    }
    total_possible += rubric.style.max_points_off;

    // Compute correctness score based on test failures
    var correctness = total_correctness_possible;
    if (!run_completed(run_status)) {
        correctness_comments.push('No correctness points due to run status "' +
                run_status + '"');
        correctness = 0.0;
    } else if (!('correct.txt' in log_files)) {
        correctness_comments.push('No correctness points due to missing ' +
                'correctness test output');
        correctness = 0.0;
    } else {
        var correctness_content = log_files['correct.txt'].contents.toString('utf8');
        var correctness_lines = correctness_content.split('\n');

        /*
         * First check if anything was printed to STDERR. This may indicate anything
         * (from harmless prints by the student, to OutOfMemoryException) so we
         * conservatively give zero points if STDERR is non-empty.
         */
        var any_nonempty_stderr_lines = check_for_empty_stderr_internal(correctness_lines);

        if (any_nonempty_stderr_lines) {
            log('calculate_score: setting correctness score to 0 for run ' +
                    run_id + ' due to non-empty stderr');
            correctness_comments.push('No correctness points due to non-empty ' +
                    'stderr during correctness tests');
            correctness = 0.0;
        } else {
            var failure_counts = [];
            var failures_message_found = false;
            var line = null;
            for (var i = 0; i < correctness_lines.length; i++) {
                line = correctness_lines[i];
                if (string_starts_with(line, 'There were ') && string_ends_with(line, ' failures:')) {
                    failure_counts.push(parseInt(line.split(' ')[2]));
                    failures_message_found = true;
                } else if (string_starts_with(line, 'There was ') && string_ends_with(line, ' failure:')) {
                    failure_counts.push(1);
                    failures_message_found = true;
                } else if (string_starts_with(line, "OK (") && (string_ends_with(line, " tests)") ||
                                string_ends_with(line, " test)"))) {
                                    failures_message_found = true;
                                }
            }

            if (!failures_message_found) {
                /*
                 * Something went really wrong during parsing as there is no JUnit report.
                 * The most likely cause is a timeout during the student tests, so assign
                 * a score of 0 for correctness.
                 */
                log('calculate_score: setting correctness score to 0 for run ' +
                        run_id + ' because failure report not found');
                correctness_comments.push('No correctness points, the correctness ' +
                        'test output appears to be incomplete. The most likely cause ' +
                        'is a timeout.');
                correctness = 0.0;
            } else {
                var line_index = 0;
                for (var f = 0; f < failure_counts.length; f++) {
                    var current_failure_count = failure_counts[f];
                    for (var failure = 1; failure <= current_failure_count; failure++) {
                        while (line_index < correctness_lines.length && !string_starts_with(correctness_lines[line_index], failure + ') ')) {
                            line_index++;
                        }

                        if (line_index < correctness_lines.length && string_starts_with(correctness_lines[line_index], failure + ') ')) {
                            var junit_testname = correctness_lines[line_index].split(' ')[1];
                            var test_tokens = junit_testname.split('(');
                            var correctness_testname = test_tokens[0];
                            var classname = test_tokens[1].substring(0, test_tokens[1].length - 1);
                            var fullname = classname + '.' + correctness_testname;

                            var correctness_test = find_correctness_test_with_name(fullname, rubric);
                            if (correctness_test) {
                                log('calculate_score: taking off ' + correctness_test.points_worth +
                                        ' points for test ' + correctness_test.testname + ' on run ' + run_id);
                                correctness_comments.push('Deducted ' +
                                        correctness_test.points_worth +
                                        ' point(s) due to failure of test ' + fullname);
                                correctness -= correctness_test.points_worth;
                            }
                        }
                    }
                }
            }
        }
    }

    var have_all_performance_files = true;
    for (var i = 0; i < ncores.length; i++) {
        if (!('performance.' + ncores[i] + '.txt' in log_files)) {
            have_all_performance_files = false;
            break;
        }
    }

    // Compute performance score based on performance of each test
    var performance = 0.0;
    if (!have_all_performance_files) {
        log('calculate_score: forcing performance to 0 for run ' +
                run_id + ', run_status=' + run_status + ', have performance ' +
                'log files? ' + have_all_performance_files);
        performance_comments.push('No performance points due to missing ' +
                'performance test output');
    } else if (!run_completed(run_status)) {
        log('calculate_score: forcing performance to 0 for run ' +
                run_id + ', run_status=' + run_status + ', have performance ' +
                'log files? ' + have_all_performance_files);
        performance_comments.push('No performance points due to run status "' +
                run_status + '"');
    } else {
        var graded_tests = [];
        for (var i = 0; i < rubric.performance.tests.length; i++) {
            graded_tests.push({testname: rubric.performance.tests[i].testname,
                cores: rubric.performance.tests[i].ncores,
                points: rubric.performance.tests[i].points_worth});
        }

        for (var c = 0; c < ncores.length; c++) {
            var curr_cores = ncores[c];

            var multi_thread_content = log_files['performance.' + curr_cores + '.txt'].contents.toString('utf8');
            var multi_thread_lines = multi_thread_content.split('\n');

            for (var multi_thread_line in multi_thread_lines) {
                if (string_starts_with(multi_thread_lines[multi_thread_line], PERF_TEST_LBL)) {
                    var tokens = multi_thread_lines[multi_thread_line].split(' ');

                    var performance_testname = tokens[2];
                    var seq_time = parseInt(tokens[3]);
                    var parallel_time = parseInt(tokens[4]);

                    log('calculate_score: found multi thread perf for test=' +
                            performance_testname + ', seq_time=' + seq_time + ', parallel_time=' +
                            parallel_time + ' for run ' + run_id + ' and ncores=' + curr_cores);

                    var performance_test = find_performance_test_with_name_and_cores(
                            performance_testname, curr_cores, rubric);
                    if (performance_test) {
                        var speedup = 0.0;
                        if (parallel_time > 0.0) {
                            speedup = seq_time / parallel_time;
                        }
                        var grading = performance_test.grading;
                        var test_score = performance_test.points_worth;
                        var matched = false;
                        for (var g = 0; g < grading.length && !matched; g++) {
                            var bottom_inclusive = grading[g].bottom_inclusive;
                            var top_exclusive = grading[g].top_exclusive;
                            if (bottom_inclusive <= speedup &&
                                    (top_exclusive < 0.0 || top_exclusive > speedup)) {
                                        matched = true;
                                        test_score -= grading[g].points_off;

                                        var range_msg;
                                        if (top_exclusive < 0) {
                                            range_msg = '>= ' + bottom_inclusive;
                                        } else {
                                            range_msg = 'in range [' + bottom_inclusive +
                                                ', ' + top_exclusive + ')';
                                        }

                                        performance_comments.push('Deducted ' +
                                                grading[g].points_off +
                                                ' point(s) on test ' +
                                                performance_testname + ' with ' +
                                                curr_cores + ' core(s)' +
                                                ' for speedup of ' + speedup + ', ' + range_msg);
                                        log('calculate_score: deducting ' +
                                                grading[g].points_off + ' points on test ' + performance_testname +
                                                ' for speedup of ' + speedup + ', in range ' +
                                                bottom_inclusive + '->' + top_exclusive + ' for run ' +
                                                run_id);
                                    }
                        }
                        log('calculate_score: giving test ' + performance_testname + ' ' +
                                test_score + ' points for run ' + run_id + ' with speedup ' + speedup);
                        performance += test_score;
                        for (var f = 0; f < graded_tests.length; f++) {
                            if (graded_tests[f].testname == performance_testname &&
                                    graded_tests[f].cores == curr_cores) {
                                        graded_tests.splice(f, 1);
                                        break;
                                    }
                        }
                    }
                }
            }
        }

        for (var f = 0; f < graded_tests.length; f++) {
            performance_comments.push('No successful run of test ' +
                    graded_tests[f].testname + ' on ' + graded_tests[f].cores +
                    ' cores(s) found, resulted in loss of ' +
                    graded_tests[f].points + ' point(s)');
        }
    }

    // Compute style score based on number of style violations
    var style = rubric.style.max_points_off;
    if ('checkstyle.txt' in log_files) {
        var checkstyle_content = log_files['checkstyle.txt'].contents.toString('utf8');
        var checkstyle_lines = checkstyle_content.split('\n');

        var iter = 0;
        while (iter < checkstyle_lines.length && !string_starts_with(checkstyle_lines[iter], 'Starting audit')) {
            iter++;
        }
        iter++;
        var errorCount = 0;
        while (iter < checkstyle_lines.length && !string_starts_with(checkstyle_lines[iter], 'Audit done')) {
            errorCount++;
            iter++;
        }

        var pointsOff = errorCount * rubric.style.points_per_error;
        if (pointsOff > style) pointsOff = style;
        style_comments.push('Deducted ' + pointsOff + ' point(s) because of ' +
                errorCount + ' checkstyle error(s)');
        style -= pointsOff;
    } else {
        style_comments.push('No style points due to missing checkstyle output');
        style = 0.0;
    }

    return { total: correctness + performance + style,
        total_possible: total_possible,
        breakdown: [
        { name: 'Correctness', points: correctness,
            total: total_correctness_possible,
            comments: correctness_comments },
        { name: 'Performance', points: performance,
            total: total_performance_possible,
            comments: performance_comments },
        { name: 'Style', points: style,
            total: rubric.style.max_points_off,
            comments: style_comments }
        ]};
}

module.exports = {
    // Calculate the score for a given run based on correctness results, performance
    // results, and checkstyle results. Include detailed feedback on where points
    // were lost.
    calculate_score: function(assignment_id, log_files, ncores, run_status, run_id) {
        return calculate_score_internal(assignment_id, log_files, ncores, run_status, run_id);
    },
    load_log_files: function(run_dir) {
        return load_log_files_internal(run_dir);
    },
    assignment_path: function(assignment_id) {
        return assignment_path_internal(assignment_id);
    },
    rubric_file_path: function(assignment_id) {
        return rubric_file_path_internal(assignment_id);
    },
    load_and_validate_rubric: function(rubric_file) {
        return load_and_validate_rubric_internal(rubric_file);
    },
    check_for_empty_stderr: function(lines) {
        return check_for_empty_stderr_internal(lines);
    },
    parse_comma_separated_ints: function(ncores_str) {
        return parse_comma_separated_ints_internal(ncores_str);
    },
    get_file_size: function(path) {
        return get_file_size_internal(path);
    },
    max: function(l) {
        return max_internal(l);
    },
    pgquery: function(query, query_args, cb) {
        return pgquery_internal(query, query_args, cb);
    },
    failed_validation: function(err_msg) {
        return failed_validation_internal(err_msg);
    },
    get_score: function(run_id, cb) {
        pgquery_internal("SELECT * FROM runs WHERE run_id=($1)", [run_id], function(err, rows) {
            if (err) {
                log('Error fetching info on run_id ' + run_id);
                return cb(null);
            }
            var user_id = rows[0].user_id;
            var assignment_id = rows[0].assignment_id;
            var ncores = parse_comma_separated_ints_internal(rows[0].ncores);
            var run_status = rows[0].status;

            pgquery_internal("SELECT * FROM users WHERE user_id=($1)", [user_id], function(err, rows) {
                if (err) {
                    log('Error fetching username for user id ' + user+id);
                    return cb(null);
                }
                var username = rows[0].user_name;
                var run_dir = __dirname + '/submissions/' + username + '/' + run_id;

                var load_result = load_log_files_internal(run_dir);
                var log_files = load_result.log_files;

                var score = calculate_score_internal(assignment_id, log_files, ncores,
                    run_status, run_id);
                return cb(score);
            });
        });
    },
    MAX_DISPLAY_FILE_SIZE: MAX_DISPLAY_FILE_SIZE,
    MAX_FILE_SIZE: MAX_FILE_SIZE,
    excessiveFileSizeMsg: excessiveFileSizeMsg,
    TESTING_CORRECTNESS_STATUS: TESTING_CORRECTNESS_STATUS,
    IN_CLUSTER_QUEUE_STATUS: IN_CLUSTER_QUEUE_STATUS,
    TESTING_PERFORMANCE_STATUS: TESTING_PERFORMANCE_STATUS,
    FINISHED_STATUS: FINISHED_STATUS,
    CANCELLED_STATUS: CANCELLED_STATUS,
    FAILED_STATUS: FAILED_STATUS,
    PERF_TEST_LBL: PERF_TEST_LBL
};

