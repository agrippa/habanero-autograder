var http = require("http");
var express = require('express');
var session = require('express-session');
var bodyParser = require('body-parser');
var bcrypt = require('bcrypt-nodejs');
var pg = require('pg');
var multer = require('multer');
var ejs = require('ejs');
var fs = require('fs-extra');
var svn = require('svn-spawn');
var crypto = require('crypto');
var ssh = require('ssh2');
var scp = require('scp');
var child_process = require('child_process');
var nodemailer = require('nodemailer');
var url = require('url');
var moment = require('moment');
var archiver = require('archiver');
var temp = require('temp');

var maintenanceMsg = 'Job submission failed because the autograder is not ' +
    'currently accepting new submissions. This is most likely due to a ' +
    'planned maintenance.';
var permissionDenied = 'Permission denied. But you should shoot me an e-mail ' +
    'at jmaxg3@gmail.com. If you like playing around with systems, we have ' +
    'interesting research for you in the Habanero group.';
var excessiveFileSizeMsg = 'The submission appears to perform excessive ' +
    'prints, resulting in large log files. Please reduce the prints performed ' +
    'and resubmit. A truncated version of your output is included below.';

var upload = multer({ dest: 'uploads/' });

var KEEP_CLUSTER_DIRS = true;
var VERBOSE = false;

var LOCAL_JOB_ID = 'LOCAL';

var PERF_TEST_LBL = 'HABANERO-AUTOGRADER-PERF-TEST';

var PAGE_SIZE = 50;

function log(msg) {
    console.log(new Date().toLocaleString() + ' ' + msg);
}

function check_env(varname) {
  if (!(varname in process.env)) {
    log('The ' + varname + ' environment variable must be set');
    process.exit(1);
  }
  return process.env[varname];
}

var AUTOGRADER_HOME = check_env('AUTOGRADER_HOME');

var HOME = check_env('HOME');

var GMAIL_USER = check_env('GMAIL_USER');
var GMAIL_PASS = check_env('GMAIL_PASS');

var transporter = nodemailer.createTransport({
  service: 'Gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS
  }
});

function send_email(to, subject, body, cb) {
  log('send_email: to=' + to + ' subject="' + subject + '"');

  var options = {
    from: 'Habanero AutoGrader <' + GMAIL_USER + '>',
    to: to,
    subject: subject,
    text: body
  };
  transporter.sendMail(options, function(err, info) {
    cb(err);
  });
}

var POSTGRES_USERNAME = process.env.PGSQL_USER || 'postgres';
var POSTGRES_PASSWORD = process.env.PGSQL_PASSWORD || 'foobar';
var POSTGRES_USER_TOKEN = null;
if (POSTGRES_PASSWORD.length === 0) {
  POSTGRES_USER_TOKEN = POSTGRES_USERNAME;
} else {
  POSTGRES_USER_TOKEN = POSTGRES_USERNAME + ":" + POSTGRES_PASSWORD;
}

log('Connecting to local PGSQL instance with user ' + POSTGRES_USERNAME);

var SVN_USERNAME = process.env.SVN_USER || 'jmg3';
var SVN_PASSWORD = process.env.SVN_PASSWORD || '';
var SVN_REPO = process.env.SVN_REPO ||
    'https://svn.rice.edu/r/parsoft/projects/AutoGrader/student-runs';

log('Connecting to SVN repo ' + SVN_REPO + ' as user ' + SVN_USERNAME);

var VIOLA_HOST = process.env.VIOLA_HOST || 'localhost';
var VIOLA_PORT = parseInt(process.env.VIOLA_PORT || '8080');

log('Connecting to Viola at ' + VIOLA_HOST + ':' + VIOLA_PORT);

var CLUSTER_HOSTNAME = process.env.CLUSTER_HOSTNAME || 'stic.rice.edu';
var CLUSTER_USER = process.env.CLUSTER_USER || 'jmg3';
var CLUSTER_PRIVATE_KEY_PASSPHRASE = process.env.CLUSTER_PRIVATE_KEY_PASSPHRASE || null;
var clusterPrivateKey = fs.readFileSync(HOME + '/.ssh/id_rsa');
/*
 * We support cluster types of 'slurm' and 'local'. However, 'local' clusters are
 * purely for testing locally and should never be used in production, as they
 * block on every performance test.
 */
var CLUSTER_TYPE = process.env.CLUSTER_TYPE || 'slurm';
if (CLUSTER_TYPE !== 'slurm' && CLUSTER_TYPE !== 'local') {
  throw 'Unsupported cluster type ' + CLUSTER_TYPE;
}
var CHECK_CLUSTER_PERIOD_MS = 30 * 1000; // 30 seconds
var CHECK_CLUSTER_FILES_PERIOD_MS = 60 * 60 * 1000; // 60 minutes
var CLUSTER_FOLDER_RETENTION_TIME_S = 24 * 60 * 60; // 24 hours

// All run statuses
var TESTING_CORRECTNESS_STATUS = 'TESTING CORRECTNESS';
var IN_CLUSTER_QUEUE_STATUS = 'IN CLUSTER QUEUE';
var TESTING_PERFORMANCE_STATUS = 'TESTING PERFORMANCE';
var FINISHED_STATUS = 'FINISHED';
var CANCELLED_STATUS = 'CANCELLED';
var FAILED_STATUS = 'FAILED';

log('Connecting to remote cluster at ' + CLUSTER_HOSTNAME +
  ' of type ' + CLUSTER_TYPE + ' as ' + CLUSTER_USER);

// TODO load this from JSON file
var conString = "postgres://" + POSTGRES_USER_TOKEN + "@localhost/autograder";

var cancellationSuccessMsg = 'Successfully cancelled. Please give the job status a few minutes to update.';

temp.track();

function pgclient(cb) {
  log('pgclient: acquiring PGSQL client...');
  pg.connect(conString, function(err, client, done) {
      log("pgclient: finished acquiring PGSQL client, err=" + err);
      if (err) {
        done();
        return console.error('error fetching client from pool', err);
      }
      cb(client, done);
  });
}

function pgquery(query, query_args, cb) {
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

// A simpler pgquery that doesn't pass the error back to the user, simply redirects
function pgquery_no_err(query, query_args, res, req, cb) {
    pgquery(query, query_args, function(err, rows) {
        if (err) {
            log('pgquery_no_err: hit an err = ' + err);
            return redirect_with_err('/overview', res, req,
                'Internal error (pgquery_no_err)');
        }
        cb(rows);
    });
}

var svn_client = new svn({
        username: SVN_USERNAME,
        password: SVN_PASSWORD
    });

function svn_cmd(cmd, cb) {
    log('svn_cmd: ' + cmd.join(' '));
    return svn_client.cmd(cmd, cb);
}

var cluster_connection = null;

// Should only be used from run_cluster_cmd or cluster_scp
function connect_to_cluster(cb) {
    log('connect_to_cluster: Connecting to cluster ' + CLUSTER_HOSTNAME +
            ' of type ' + CLUSTER_TYPE + ' as user ' + CLUSTER_USER);
    if (CLUSTER_TYPE === 'slurm') {
        if (cluster_connection) {
            cb();
        } else {
            var conn = new ssh.Client();
            conn.on('ready', function() {
                cluster_connection = conn;
                cb();
            }).on('error', function(err) {
                log('connect_to_cluster: Error connecting to ' + CLUSTER_HOSTNAME +
                    ' as user ' + CLUSTER_USER + ': ' + err);
                connect_to_cluster(cb);
            }).on('end', function() {
                log('connect_to_cluster: connection to ' + CLUSTER_HOSTNAME +
                    ' ends');
            }).connect({
                host: CLUSTER_HOSTNAME,
                port: 22,
                username: CLUSTER_USER,
                privateKey: clusterPrivateKey,
                passphrase: CLUSTER_PRIVATE_KEY_PASSPHRASE,
                readyTimeout: 60000
            });
        }
    } else {
        // local
        cb();
    }
}

// Assume this is called after 'ready' event is triggered.
function run_cluster_cmd(lbl, cluster_cmd, cb) {
    log('run_cluster_cmd[' + lbl + ']: ' + cluster_cmd);

    if (CLUSTER_TYPE === 'slurm') {
        var handler = function(err, stream) {
            if (err) {
                log('[' + lbl + '] err=' + err);
                return cb(lbl, null, null);
            }
            var acc_stdout = '';
            var acc_stderr = '';
            stream.on('close', function(code, signal) {
                if (code !== 0) {
                    log('[' + lbl + '] code=' + code + ' signal=' + signal);
                    return cb(lbl, acc_stdout, acc_stderr);
                } else {
                    if (VERBOSE) {
                        log('[' + lbl + '] code=' + code + ' signal=' + signal);
                        log('[' + lbl + '] stdout=' + acc_stdout);
                        log('[' + lbl + '] stderr=' + acc_stderr);
                    }
                    return cb(null, acc_stdout, acc_stderr);
                }
            }).on('data', function(data) {
                acc_stdout = acc_stdout + data;
            }).stderr.on('data', function(data) {
                acc_stderr = acc_stderr + data;
            });
        };

        // Most of the time will return right away because cluster_connection will be initialized
        connect_to_cluster(function() {
            try {
                cluster_connection.exec(cluster_cmd, handler);
            } catch (err) {
                log('run_cluster_cmd: caught error from existing connection: ' + err);
                cluster_connection.end();
                connect_to_cluster(function() {
                    run_cluster_cmd(lbl, cluster_cmd, cb);
                });
            }
        });
    } else {
      var args = ['-c', cluster_cmd];
      var run = child_process.spawn('/bin/bash', args);

      var acc_stdout = '';
      var acc_stderr = '';
      run.stdout.on('data', function(data) { acc_stdout = acc_stdout + data; });
      run.stderr.on('data', function(data) { acc_stderr = acc_stderr + data; });
      run.on('close', function(code) {
        if (code !== 0) {
          log('[' + lbl + '] code=' + code + ', cluster_cmd=' + cluster_cmd);
          return cb(lbl, acc_stdout, acc_stderr);
        } else {
          if (VERBOSE) {
            log('[' + lbl + '] code=' + code);
            log('[' + lbl + '] stdout=' + acc_stdout);
            log('[' + lbl + '] stderr=' + acc_stderr);
          }
          return cb(null, acc_stdout, acc_stderr);
        }
      });
    }
}

var MAX_FILE_SIZE = 10 * 1024 * 1024;

function get_file_size(path) {
    var stats = fs.statSync(path);
    return stats.size;
}

// Only supports individual files, assumes parent directories are already created
function cluster_scp(src_file, dst_file, is_upload, cb) {
  if (is_upload) {
    if (dst_file.trim().search('/') === 0) {
      throw 'All remote directories should be relative, but got ' + dst_file;
    }
    log('cluster_scp: transferring ' + src_file + ' on local machine to ' + dst_file + ' on cluster');
  } else {
    if (src_file.trim().search('/') === 0) {
      throw 'All remote directories should be relative, but got ' + src_file;
    }
    log('cluster_scp: transferring ' + src_file + ' on cluster to ' + dst_file + ' on local machine');
  }

  if (CLUSTER_TYPE === 'slurm') {
      var start_time = new Date().getTime();

      // Ensure cluster_connection is initialized
      connect_to_cluster(function() {
          cluster_connection.sftp(function(err, sftp) {
              if (err) {
                  log('cluster_scp: setting up sftp returned an err: ' + err);
                  return cb(err);
              }

              if (is_upload) {
                  sftp.fastPut(src_file, dst_file, function(err) {
                      log('cluster_scp: upload from ' + src_file + ' took ' +
                          (new Date().getTime() - start_time) + ' ms, err=' + err);
                      cb(err);
                  });
              } else {
                  log('cluster_scp: download to ' + dst_file + ' took ' +
                      (new Date().getTime() - start_time) + ' ms, err=' + err);
                  sftp.fastGet(src_file, dst_file, function(err) {
                      cb(err);
                  });
              }
          });
      });
  } else {
      if (is_upload) {
        dst_file = process.env.HOME + '/' + dst_file;
      } else {
        src_file = process.env.HOME + '/' + src_file;
      }
      var src_contents = fs.readFileSync(src_file);
      fs.writeFileSync(dst_file, src_contents);
      cb(null);
  }
}

function batched_cluster_scp_helper(pair_index, file_pairs, is_upload, stat, cb) {
  if (pair_index >= file_pairs.length) {
    return cb(stat);
  }

  cluster_scp(file_pairs[pair_index].src, file_pairs[pair_index].dst, is_upload,
      function(err) {
        if (err) {
          stat.push({dst: file_pairs[pair_index].dst, success: false, err: err});
        } else {
          stat.push({dst: file_pairs[pair_index].dst, success: true});
        }
        return batched_cluster_scp_helper(pair_index + 1, file_pairs, is_upload, stat, cb);
      });
}

function batched_cluster_scp(file_pairs, is_upload, cb) {
  var stat = [];
  return batched_cluster_scp_helper(0, file_pairs, is_upload, stat, cb);
}

function create_cluster_dir(dirname, cb) {
  if (dirname.trim().search('/') === 0) {
    throw 'Remote directory names should be relative to $HOME, got ' + dirname;
  }

  var MKDIR_CMD = null;
  if (CLUSTER_TYPE === 'slurm') {
    MKDIR_CMD = 'mkdir -p ' + dirname;
  } else {
    MKDIR_CMD = 'mkdir -p ' + process.env.HOME + '/' + dirname;
  }

  run_cluster_cmd('creating dir', MKDIR_CMD, cb);
}

function get_cluster_env_var(varname, cb) {
  var ECHO_CMD = 'echo $' + varname;
  run_cluster_cmd('getting variable ' + varname, ECHO_CMD,
      function(err, stdout, stderr) {
        if (err) {
          cb(err, null);
        } else {
          cb(null, stdout.trim());
        }
      });
}

function batched_get_cluster_env_var_helper(index, varnames, acc, cb) {
  if (index >= varnames.length) {
    return cb(null, acc);
  }

  get_cluster_env_var(varnames[index], function(err, val) {
    if (err) {
      cb(err, null);
    } else {
      val = val.trim();
      if (val.length === 0) {
        cb('Missing cluster environment variable ' + varnames[index]);
      } else {
        acc[varnames[index]] = val;
        batched_get_cluster_env_var_helper(index + 1, varnames, acc, cb);
      }
    }
  });
}

function batched_get_cluster_env_var(varnames, cb) {
  return batched_get_cluster_env_var_helper(0, varnames, {}, cb);
}

function get_cluster_os(cb) {
  var UNAME_CMD = 'uname';
  run_cluster_cmd('get cluster OS', UNAME_CMD,
      function(err, stdout, stderr) {
        if (err) {
          log('get_cluster_os: err=' + err + ', stderr=' + stderr);
          cb(err, null);
        } else {
          stdout = stdout.trim();
          log('get_cluster_os: got ' + stdout);
          cb(null, stdout);
        }
      });
}

function string_starts_with(st, prefix) {
  return st.slice(0, prefix.length) === prefix;
}

function string_ends_with(st, suffix) {
    return st.indexOf(suffix, st.length - suffix.length) !== -1;
}

function string_ends_with(st, suffix) {
  return st.indexOf(suffix, st.length - suffix.length) !== -1;
}

function render_page(html_doc, res, req, render_vars) {
    render_vars = typeof render_vars !== 'undefined' ? render_vars : {};
    if ('err_msg' in req.session && req.session.err_msg !== null &&
            !('err_msg' in render_vars)) {
        render_vars.err_msg = req.session.err_msg;
    }
    req.session.err_msg = null;
    if ('success_msg' in req.session && req.session.success_msg !== null &&
            !('success_msg' in render_vars)) {
        render_vars.success_msg = req.session.success_msg;
    }
    req.session.success_msg = null;

    return res.render(html_doc, render_vars);
}

function redirect_with_err(target, res, req, err_msg) {
    log('redirect_with_err: target=' + target + ' err_msg=' + err_msg);
    req.session.err_msg = err_msg;
    return res.redirect(target);
}

function redirect_with_success(target, res, req, success_msg) {
    req.session.success_msg = success_msg;
    return res.redirect(target);
}

var app = express();
app.use(bodyParser.urlencoded());
app.use(session({secret: 'blarp', cookie:{maxAge: 7 * 24 * 3600 * 1000}}));
app.engine('html', ejs.renderFile);
app.set('view engine', 'html');
app.set('views', __dirname + "/views");

app.get('/status/:run_id', function(req, res, next) {
    var run_id = req.params.run_id;
    log('status: run_id=' + run_id);

    /*
     * Deliberately don't check permissions, it's okay to leave this endpoint
     * in the open.
     */
    pgquery("SELECT * FROM runs WHERE run_id=($1)", [run_id], function(err, rows) {
        if (err) {
            return res.send('INTERNAL FAILURE');
        }
        if (rows.length != 1) {
            return res.send('UNKNOWN RUN');
        }
        return res.send(rows[0].status);
    });
});

app.get('/latest_complete_run', function(req, res, next) {
    pgquery('SELECT MAX(run_id) FROM runs', [], function(err, rows) {
        if (err) {
            return res.send('INTERNAL FAILURE');
        }
        var max_run_id = rows[0].max;

        pgquery("SELECT MIN(run_id) FROM runs WHERE status='" +
                TESTING_CORRECTNESS_STATUS + "' OR status='" +
                IN_CLUSTER_QUEUE_STATUS + "' OR status='" +
                TESTING_PERFORMANCE_STATUS + "'", [], function(err, rows) {
            if (err) {
                return res.send('INTERNAL FAILURE');
            }

            if (rows[0].min === null) {
                if (max_run_id === null) {
                    return res.send('NO RUNS');
                } else {
                    return res.send(max_run_id.toString());
                }
            } else {
                return res.send((rows[0].min - 1).toString());
            }
        });
    });
});

/*
 * login/logout routes should always be the only routes above the wildcard '*' route
 */
app.get('/login', function(req, res, next) {
    return render_page('login.html', res, req);
});

app.post('/login', function(req, res, next) {
  var username = req.body.username;
  var password = req.body.pw.replace(/[^\x00-\x7F]/g, ""); // delete non-ascii

  log('login: username=' + username);

  // Check that user exists
  pgquery_no_err("SELECT * FROM users WHERE user_name=($1)", [username], res,
      req, function(rows) {
          if (rows.length === 0) {
              return redirect_with_err('/login', res, req,
                  'User "' + username + '" does not exist');
          } else if (rows.length == 1) {
            // Check that password matches
            if (bcrypt.compareSync(password, rows[0].password_hash)) {
              req.session.username = username;
              req.session.user_id = rows[0].user_id;
              req.session.is_admin = rows[0].is_admin;

              return res.redirect('/overview');
            } else {
              return redirect_with_err('/login', res, req,
                  'Incorrect password for user "' + username + '"');
            }
          } else {
            return redirect_with_err('/login', res, req,
                'Internal error (' + rows.length + ')');
          }
      });
});

app.get('/logout', function(req, res, next) {
  log('logout: username=' + req.session.username);

  req.session.username = null;
  req.session.user_id = null;
  req.session.is_admin = false;

  return res.redirect('/login');
});

app.get('*', function(req, res, next) {
  if (req.session.username) {
    res.locals.username = req.session.username;
    res.locals.is_admin = req.session.is_admin;

    next();
  } else {
    if (req.url.length > 1 && string_starts_with(req.url, '/third_party')) {
        next();
    } else {
        res.locals.username = null;
        res.locals.is_admin = false;

        return res.redirect('/login');
    }
  }
});

app.get('/profile', function(req, res, next) {
  var username = req.session.username;
  log('profile: username=' + username);

  pgquery_no_err('SELECT * FROM users WHERE user_name=($1)', [username], res,
      req, function(rows) {
          if (rows.length != 1) {
            return redirect_with_err('/overview', res, req,
                'User "' + username + '" does not exist');
          } else {
            var user_id = rows[0].user_id;
            var has_notifications_enabled = rows[0].receive_email_notifications;

            pgquery_no_err('SELECT COUNT(*) FROM runs WHERE user_id=($1)',
                [user_id], res, req, function(rows) {
                    var render_vars = {username: req.session.username,
                                       nruns: rows[0].count,
                                       notifications_enabled: has_notifications_enabled};
                    return render_page('profile.html', res, req, render_vars);
                });
          }
      });
});

app.post('/notifications/', function(req, res, next) {
  var enable_notifications = ('enable' in req.body);
  log('notifications: user=' + req.session.username +
      ' enable_notifications=' + enable_notifications);
  pgquery_no_err('UPDATE users SET receive_email_notifications=($1) WHERE ' +
      'user_name=($2)', [enable_notifications, req.session.username], res, req,
      function(rows) {
          return res.redirect('/profile');
      });
});

app.get('/overview/:page?', function(req, res, next) {
  var page_str = req.params.page;
  if (!page_str) page_str = '0';

  log('overview: user=' + req.session.username + ' page=' + page_str);

  if (isNaN(page_str)) {
      return render_page('overview.html', res, req,
          {err_msg: 'Invalid URL, ' + page_str + ' is not a number', runs: [],
              page: 0, npages: 1});
  }

  var page = parseInt(page_str);
  if (page < 0) {
      return render_page('overview.html', res, req,
          {err_msg: 'Invalid URL, ' + page + ' is < 0',
              runs: [], page: 0, npages: 1});
  }

  get_runs_for_username(req.session.username, function(runs, err) {
      if (err) {
          return render_page('overview.html', res, req,
              {err_msg: 'Error gathering runs', runs: [], assignments: [],
                  page: 0, npages: 1});
      }

      get_visible_assignments(function(assignments, err) {
          if (err) {
              return render_page('overview.html', res, req,
                  {err_msg: 'Error gathering assignments', runs: [],
                      assignments: [], page: 0, npages: 1});
          }
          var npages = Math.max(Math.ceil(runs.length / PAGE_SIZE), 1);
          // npages will be 0 when there are no runs for this user
          if (npages > 0 && page >= npages) {
              return render_page('overview.html', res, req,
                  {err_msg: 'Invalid URL, ' + page + ' is >= the # of pages, ' + npages,
                      runs: [], page: 0, npages: 1});
          }

          var subsetted_runs = [];
          var limit = (page + 1) * PAGE_SIZE;
          if (limit > runs.length) limit = runs.length;
          for (var i = page * PAGE_SIZE; i < limit; i++) {
              subsetted_runs.push(runs[i]);
          }
          return render_page('overview.html', res, req, {runs: subsetted_runs,
              page: page, npages: npages, assignments: assignments});
      });
  });
});

app.get('/leaderboard/:assignment_id?/:page?', function(req, res, next) {
  var target_assignment_id = req.params.assignment_id;
  var page = req.params.page;
  log('leaderboard: username=' + req.session.username +
      ' target_assignment_id=' + target_assignment_id + ' page=' + page);

  pgquery_no_err("SELECT assignment_id,name,correctness_only FROM " +
        "assignments WHERE visible=true ORDER BY assignment_id DESC", [], res,
        req, function(rows) {
            var render_vars = {assignments: rows};

            if (target_assignment_id) {
                var has_performance_tests = false;
                for (var i = 0; i < rows.length; i++) {
                    if (rows[i].assignment_id === target_assignment_id) {
                        if (!rows[i].correctness_only) {
                            has_performance_tests = true;
                        }
                        break;
                    }
                }
                render_vars.has_performance_tests = has_performance_tests;

                pgquery_no_err("SELECT run_id,status,passed_checkstyle,compiled," +
                    "passed_all_correctness,passed_performance,characteristic_speedup,user_id " +
                    "FROM runs WHERE assignment_id=($1) ORDER BY run_id DESC",
                    [target_assignment_id], res, req, function(rows) {
                        render_vars.runs = rows;

                        // Find the best runs for each user
                        var max_runs_only = {};
                        for (i = 0; i < rows.length; i++) {
                            if (rows[i].characteristic_speedup.length !== 0) {
                                var user_id = rows[i].user_id;
                                var user_speedup = parseFloat(rows[i].characteristic_speedup);

                                if (user_id in max_runs_only) {
                                    if (user_speedup > max_runs_only[user_id]) {
                                        max_runs_only[user_id] = user_speedup;
                                    }
                                } else {
                                    max_runs_only[user_id] = user_speedup;
                                }
                            }
                        }

                        // Find the min and max out of the best runs
                        var nbins = 10;
                        var bins = [];
                        for (var i = 0; i < nbins; i++) bins.push(0);
                        var max_speedup = -1.0;
                        var min_speedup = -1.0;
                        for (var min_max_user in max_runs_only) {
                            if (max_runs_only.hasOwnProperty(min_max_user)) {
                                var speedup = max_runs_only[min_max_user];
                                if (max_speedup < speedup) max_speedup = speedup;
                                if (min_speedup < 0.0 || speedup < min_speedup) min_speedup = speedup;
                            }
                        }

                        max_speedup += 0.001;
                        var bin_width = (max_speedup - min_speedup) / nbins;
                        log('leaderboard: found min speedup=' + min_speedup +
                                ' max speedup=' + max_speedup + ', using bin width=' +
                                bin_width + ' for nbins=' + nbins);
                        for (var bin_user in max_runs_only) {
                            if (max_runs_only.hasOwnProperty(bin_user)) {
                                var bin_speedup = max_runs_only[bin_user];
                                var delta_from_min = bin_speedup - min_speedup;
                                var bin = Math.floor(delta_from_min / bin_width);
                                log('leaderboard: placing speedup ' + bin_speedup + ' in bin ' + bin);
                                bins[bin] = bins[bin] + 1;
                            }
                        }

                        render_vars.speedup_bins = [];
                        for (var b = 0; b < nbins; b++) {
                            var lower_bound = min_speedup + b * bin_width;
                            var upper_bound = min_speedup + (b + 1) * bin_width;
                            var lbl = '[' + lower_bound.toFixed(2).toString() + ', ' + upper_bound.toFixed(2).toString() + ')';
                            render_vars.speedup_bins.push({lbl: lbl, count: bins[b] });
                        }

                        pgquery_no_err('SELECT name FROM assignments where ' +
                                'assignment_id=($1)', [target_assignment_id],
                                res, req, function(rows) {
                                    render_vars.assignment_name = rows[0].name;
                                    return render_page('leaderboard.html', res,
                                        req, render_vars);
                                });
                    });
            } else {
                return render_page('leaderboard.html', res, req, render_vars);
            }
        });
});

app.get('/comments', function(req, res, next) {
  return render_page('comments.html', res, req);
});

app.get('/user_guide', function(req, res, next) {
  log('user_guide: ' + req.session.username);
  return render_page('user_guide.html', res, req);
});

app.get('/faq', function(req, res, next) {
  log('faq: ' + req.session.username);
  return render_page('faq.html', res, req);
});

app.post('/comments', function(req, res, next) {
  var comment = req.body.comments;
  log('comments: comment="' + comment + '"');

  send_email('jmg3@rice.edu', 'AUTOGRADER COMMENT', comment, function(err) {
    if (err) {
      log('comments: err=' + err);
      return redirect_with_err('/comments', res, req, 'Error submitting comment');
    }
    return redirect_with_success('/overview', res, req, 'Thank you for your comment!');
  });
});

app.get('/admin', function(req, res, next) {
  if (req.session.is_admin) {
    get_all_assignments(function(assignments, err) {
        if (err) {
            return redirect_with_err('/overview', res, req, "Error fetching assignments");
        }
        var render_vars = {assignments: assignments};
        return render_page('admin.html', res, req, render_vars);
    });
  } else {
    return res.redirect('/overview');
  }
});

function is_actual_svn_err(err) {
  return (err && err.message.trim().search("200 OK") === -1);
}

// Create a new assignment with a given name, not visible to students
var assignment_file_fields = [
                              { name: 'zip', maxCount: 1 },
                              { name: 'instructor_pom', maxCount: 1 },
                              { name: 'rubric', maxCount: 1 },
                              { name: 'checkstyle_config', maxCount: 1 }
                             ];
app.post('/assignment', upload.fields(assignment_file_fields), function(req, res, next) {
  log('assignment: is_admin=' + req.session.is_admin);
  if (!req.session.is_admin) {
      return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    var assignment_name = req.body.assignment_name;
    if (assignment_name.length === 0) {
      return redirect_with_err('/admin', res, req,
        'Please provide a non-empty assignment name');
    }
    if (!req.files.zip) {
      return redirect_with_err('/admin', res, req,
        'Please provide test files for the assignment');
    }
    if (!req.files.instructor_pom) {
      return redirect_with_err('/admin', res, req,
        'Please provide an instructor pom for the assignment');
    }
    if (!req.files.rubric) {
      return redirect_with_err('/admin', res, req,
        'Please provide a rubric for the assignment');
    }
    if (!req.files.checkstyle_config) {
      return redirect_with_err('/admin', res, req,
        'Please provide a checkstyle configuration for the assignment');
    }

    var rubric_validated = load_and_validate_rubric(req.files.rubric[0].path);
    if (!rubric_validated.success) {
        return redirect_with_err('/admin', res, req, 'Error in rubric: ' + rubric_validated.msg);
    }

    var pom_validated = validate_instructor_pom(req.files.instructor_pom[0].path);
    if (!pom_validated.success) {
        return redirect_with_err('/admin', res, req, 'Error in POM: ' + pom_validated.msg);
    }

    pgquery_no_err("INSERT INTO assignments (name, visible) VALUES " +
            "($1,false) RETURNING assignment_id", [assignment_name], res, req,
            function(rows) {
                var assignment_id = rows[0].assignment_id;
                var assignment_dir = assignment_path(assignment_id);

                // Create the assignment directory on the conductor
                fs.mkdirSync(assignment_dir);

                // Copy all of the submitted instructor files into the assignment directory
                var remote_copies = [];
                fs.renameSync(req.files.zip[0].path,
                    assignment_dir + '/instructor.zip');
                remote_copies.push({src: assignment_dir + '/instructor.zip',
                    dst: 'autograder-assignments/' + assignment_id + '/instructor.zip'});

                fs.renameSync(req.files.instructor_pom[0].path,
                    assignment_dir + '/instructor_pom.xml');
                remote_copies.push({src: assignment_dir + '/instructor_pom.xml',
                    dst: 'autograder-assignments/' + assignment_id + '/instructor_pom.xml'});

                fs.renameSync(req.files.rubric[0].path,
                    assignment_dir + '/rubric.json');
                remote_copies.push({src: assignment_dir + '/rubric.json',
                    dst: 'autograder-assignments/' + assignment_id + '/rubric.json'});

                fs.renameSync(req.files.checkstyle_config[0].path,
                    assignment_dir + '/checkstyle.xml');
                remote_copies.push({src: assignment_dir + '/checkstyle.xml',
                    dst: 'autograder-assignments/' + assignment_id + '/checkstyle.xml'});

                create_cluster_dir('autograder-assignments/' + assignment_id, function(err, stdout, stderr) {
                    if (err) {
                        return redirect_with_err('/admin', res, req,
                            'Unable to create directory on cluster');
                    }

                    batched_cluster_scp(remote_copies, true, function(stat) {
                        for (var i = 0; i < stat.length; i++) {
                            if (!stat[i].success) {
                                return redirect_with_err('/admin', res, req,
                                    'Unable to upload to cluster');
                            }
                        }
                        return redirect_with_success('/admin', res, req, 'Uploaded assignment');
                    });
                });

            });
  }
});

function handle_reupload(req, res, missing_msg, target_filename) {
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    var assignment_id = req.params.assignment_id;

    if (!req.file) {
        return redirect_with_err('/admin', res, req, missing_msg);
    }

    pgquery_no_err("SELECT * FROM assignments WHERE assignment_id=($1)",
            [assignment_id], res, req, function(rows) {
                if (rows.length != 1) {
                    return redirect_with_err('/admin', res, req,
                        'That assignment doesn\'t seem to exist');
                }
                var assignment_dir = assignment_path(assignment_id);
                fs.renameSync(req.file.path, assignment_dir + '/' + target_filename);

                cluster_scp(assignment_dir + '/' + target_filename,
                    'autograder-assignments/' + assignment_id + '/' + target_filename, true,
                    function(err) {
                    if (err) {
                        return redirect_with_err('/admin', res, req,
                            'Unable to upload to cluster');
                    }
                    return redirect_with_success('/admin', res, req,
                        'Updated ' + target_filename + ' for assignment ' +
                        rows[0].name);
                });
            });
  }
}

function update_assignment_field(timeout_val, column_name, assignment_id, res, req) {
    pgquery_no_err("SELECT * FROM assignments WHERE assignment_id=($1)",
            [assignment_id], res, req, function(rows) {
                if (rows.length != 1) {
                  return redirect_with_err('/admin', res, req,
                    'That assignment doesn\'t seem to exist');
                }
                pgquery_no_err("UPDATE assignments SET " + column_name + "=" +
                    timeout_val + " WHERE assignment_id=($1)", [assignment_id], res,
                    req, function(rows) {
                        return redirect_with_success('/admin', res, req,
                            'Updated ' + column_name + ' to ' + timeout_val);
                    });
            });
}

app.post('/update_jvm_args/:assignment_id', function(req, res, next) {
  log('update_jvm_args: is_admin=' + req.session.is_admin + ', jvm_args=' + req.body.jvm_args);
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    if (!req.body.jvm_args) {
      return redirect_with_err('/admin', res, req, 'Malformed request, missing JVM args field?');
    }
    var assignment_id = req.params.assignment_id;
    var jvm_args = req.body.jvm_args;

    return update_assignment_field("'" + jvm_args + "'", 'jvm_args', assignment_id, res, req);
  }
});

app.post('/update_correctness_timeout/:assignment_id', function(req, res, next) {
  log('update_correctness_timeout: is_admin=' + req.session.is_admin +
      ', new timeout=' + req.body.correctness_timeout);
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    if (!req.body.correctness_timeout) {
      return redirect_with_err('/admin', res, req,
          'Malformed request, missing correctness timeout field?');
    }
    var assignment_id = req.params.assignment_id;
    var correctness_timeout = req.body.correctness_timeout;

    return update_assignment_field(correctness_timeout, 'correctness_timeout_ms',
        assignment_id, res, req);
  }
});

app.post('/update_custom_slurm_flags/:assignment_id', function(req, res, next) {
    log('update_custom_slurm_flags: is_admin=' + req.session.is_admin +
        ', new slurm flags = "' + req.body.custom_slurm_flags + '"');
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    if (!req.body.custom_slurm_flags) {
      return redirect_with_err('/admin', res, req,
          'Malformed request, missing custom slurm flags field?');
    }
    var assignment_id = req.params.assignment_id;
    var custom_slurm_flags = req.body.custom_slurm_flags;

    return update_assignment_field("'" + custom_slurm_flags + "'", 'custom_slurm_flags',
        assignment_id, res, req);
  }
});

app.post('/update_performance_timeout/:assignment_id', function(req, res, next) {
  log('update_performance_timeout: is_admin=' + req.session.is_admin +
      ', new timeout=' + req.body.performance_timeout);
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    if (!req.body.performance_timeout) {
      return redirect_with_err('/admin', res, req,
          'Malformed request, missing performance timeout field?');
    }
    var assignment_id = req.params.assignment_id;
    var performance_timeout = req.body.performance_timeout;

    return update_assignment_field("'" + performance_timeout + "'", 'performance_timeout_str',
        assignment_id, res, req);
  }
});

app.post('/update_ncores/:assignment_id', function(req, res, next) {
  log('update_ncores: is_admin=' + req.session.is_admin +
      ', new timeout=' + req.body.performance_timeout);
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    if (!req.body.ncores) {
      return redirect_with_err('/admin', res, req,
          'Malformed request, missing ncores field?');
    }
    var assignment_id = req.params.assignment_id;
    var ncores = req.body.ncores;

    return update_assignment_field(ncores, 'ncores', assignment_id, res, req);
  }
});

app.post('/upload_zip/:assignment_id', upload.single('zip'),
    function(req, res, next) {
      log('upload_zip: is_admin=' + req.session.is_admin);
      return handle_reupload(req, res, 'Please provide a ZIP', 'instructor.zip');
    });

app.post('/upload_instructor_pom/:assignment_id', upload.single('pom'),
    function(req, res, next) {
      log('upload_instructor_pom: is_admin=' + req.session.is_admin);

      if (!req.file) {
          return redirect_with_err('/admin', res, req, 'No POM provided');
      }

      var validated = validate_instructor_pom(req.file.path);
      if (!validated.success) {
          return redirect_with_err('/admin', res, req, 'Error in POM: ' + validated.msg);
      }

      return handle_reupload(req, res, 'Please provide an instructor pom.xml',
        'instructor_pom.xml');
    });

app.post('/upload_rubric/:assignment_id', upload.single('rubric'),
    function(req, res, next) {
      log('upload_rubric: is_admin=' + req.session.is_admin);

      if (!req.file) {
          return redirect_with_err('/admin', res, req, 'No rubric provided');
      }

      var validated = load_and_validate_rubric(req.file.path);
      if (!validated.success) {
          return redirect_with_err('/admin', res, req, 'Error in rubric: ' + validated.msg);
      }

      return handle_reupload(req, res, 'Please provide a rubric', 'rubric.json');
    });

app.post('/upload_checkstyle/:assignment_id', upload.single('checkstyle_config'),
    function(req, res, next) {
      log('upload_checkstyle: is_admin=' + req.session.is_admin);

      return handle_reupload(req, res, 'Please provide a checkstyle file', 'checkstyle.xml');
    });

app.post('/set_assignment_correctness_only/:assignment_id', function(req, res, next) {
  log('set_assignment_correctness_only: is_admin=' + req.session.is_admin);
  if (!req.session.is_admin) {
      return redirect_with_err('/overview', res, req, permissionDenied);
  }

  var assignment_id = req.params.assignment_id;
  var set_correctness_only = req.body.set_correctness_only;

  return update_assignment_field(set_correctness_only, 'correctness_only',
      assignment_id, res, req);
});

app.post('/set_assignment_visible/:assignment_id', function(req, res, next) {
  log('set_assignment_visible: is_admin=' + req.session.is_admin);
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  }

  var assignment_id = req.params.assignment_id;
  var set_visible = req.body.set_visible;


  return update_assignment_field(set_visible, 'visible',
      assignment_id, res, req);
});

function get_user_id_for_name(username, cb) {
    pgquery("SELECT * FROM users WHERE user_name=($1)", [username], function(err, rows) {
        if (err) {
           return cb(null, err);
        }
        if (rows.length === 0) {
            return cb(0, 'User ' + username + ' does not seem to exist');
        } else if (rows.length > 1) {
            return cb(0, 'There appear to be duplicate users ' + username);
        } else {
            // Got the user ID, time to get the assignment ID
            var user_id = rows[0].user_id;
            log('get_user_id_for_name: got user_id=' + user_id +
                ' for username=' + username);

            return cb(user_id, null);
        }
    });
}

function trigger_viola_run(run_dir, assignment_name, run_id, done_token,
        assignment_id, jvm_args, correctness_timeout, username, req, res, success_cb) {
    var viola_params = 'done_token=' + done_token + '&user=' + username +
        '&assignment=' + assignment_name + '&run=' + run_id +
        '&assignment_id=' + assignment_id + '&jvm_args=' + jvm_args +
        '&timeout=' + correctness_timeout + '&submission_path=' +
        run_dir_path(username, run_id) + '&assignment_path=' +
        assignment_path(assignment_id);
    var viola_options = { host: VIOLA_HOST,
        port: VIOLA_PORT, path: '/run?' + encodeURI(viola_params) };
    log('submit_run: sending viola request for run ' + run_id);
    http.get(viola_options, function(viola_res) {
        var bodyChunks = [];
        viola_res.on('data', function(chunk) {
            bodyChunks.push(chunk);
        });
        viola_res.on('end', function() {
            var body = Buffer.concat(bodyChunks);
            var result = JSON.parse(body);
            if (result.status === 'Success') {
                return success_cb(run_id);
            } else {
                return redirect_with_err('/overview', res, req,
                    'Viola error: ' + result.msg);
            }
        });
    }).on('error', function(err) {
        log('VIOLA err="' + err + '"');
        return redirect_with_err('/overview', res, req,
            'An error occurred launching the local tests');
    });
}

function run_setup_failed(run_id, res, req, err_msg, svn_err) {
    log('run_setup_failed: run_id=' + run_id + ' err_msg="' + err_msg +
            '" err="' + svn_err + '"');
    pgquery("UPDATE runs SET status='" + FAILED_STATUS + "'," +
            "finish_time=CURRENT_TIMESTAMP WHERE run_id=($1)", [run_id],
            function(err, rows) {
                if (err) {
                    log('Error storing failure setting up tests for run_id=' +
                        run_id + ': ' + err);
                    return redirect_with_err('/overview', res, req, err_msg);
                }
                log('Failure initiating tests for run_id=' + run_id + ': ' +
                    err_msg);
                return redirect_with_err('/overview', res, req, err_msg);
            });
}

function submit_run(user_id, username, assignment_name, correctness_only,
        enable_profiling, use_zip, svn_url, res, req, success_cb) {

      pgquery_no_err("SELECT * FROM assignments WHERE name=($1)", [assignment_name], res, req, function(rows) {
        if (rows.length === 0) {
          return redirect_with_err('/overview', res, req,
            'Assignment ' + assignment_name + ' does not seem to exist');
        } else if (rows.length > 1) {
          return redirect_with_err('/overview', res, req,
            'There appear to be duplicate assignments ' + assignment_name);
        } else {
          var assignment_id = rows[0].assignment_id;
          var jvm_args = rows[0].jvm_args;
          var correctness_timeout = rows[0].correctness_timeout_ms;
          log('submit_run: found assignment_id=' + assignment_id +
              ' jvm_args="' + jvm_args + '" correctness_timeout=' +
              correctness_timeout + ' for user_id=' + user_id);

          // Allow assignment settings to override user-provided setting
          var assignment_correctness_only = rows[0].correctness_only;
          if (assignment_correctness_only) correctness_only = true;

          crypto.randomBytes(48, function(ex, buf) {
              log('submit_run: got random bytes');
              var done_token = buf.toString('hex');

              pgquery_no_err("INSERT INTO runs (user_id,assignment_id," +
                  "done_token,status,correctness_only,enable_profiling) " +
                  "VALUES ($1,$2,$3,'" + TESTING_CORRECTNESS_STATUS +
                  "',$4,$5) RETURNING run_id", [user_id, assignment_id,
                  done_token, correctness_only, enable_profiling], res, req,
                  function(rows) {
                var run_id = rows[0].run_id;
                log('submit_run: got run_id=' + run_id +
                    ' for user_id=' + user_id + ' on assignment_id=' +
                    assignment_id);
                var run_dir = run_dir_path(username, run_id);
                var svn_dir = SVN_REPO + '/' + username + '/' + run_id;

                // Create run directory to store information on this run
                var mkdir_msg = '"mkdir ' + username + ' ' + assignment_name + ' ' + run_id + '"';
                fs.mkdirSync(run_dir);

                // Move submitted file into newly created local SVN working copy
                if (use_zip) {
                  fs.renameSync(req.file.path, run_dir + '/student.zip');
                  return trigger_viola_run(run_dir,
                      assignment_name, run_id, done_token,
                      assignment_id, jvm_args, correctness_timeout, username, req, res, success_cb);
                } else {
                  temp.mkdir('conductor', function(err, temp_dir) {
                    if (err) {
                        return run_setup_failed(run_id, res, req,
                            'Internal error creating temporary directory', err);
                    }

                    // Export student submission from their SVN folder
                    svn_cmd(['export', svn_url, temp_dir + '/submission_svn_folder'], function(err, data) {
                      if (is_actual_svn_err(err)) {
                          return run_setup_failed(run_id, res, req,
                              'An error occurred exporting from "' + svn_url + '"', err);
                      } 

                      var output = fs.createWriteStream(run_dir + '/student.zip');
                      var archive = archiver('zip');
                      output.on('close', function() {
                        temp.cleanupSync();
                        return trigger_viola_run(run_dir,
                            assignment_name, run_id, done_token,
                            assignment_id, jvm_args, correctness_timeout, username, req, res, success_cb);
                      });
                      archive.on('error', function(err){
                          return run_setup_failed(run_id, res, req,
                              'An error occurred zipping your submission.', err);
                      });
                      archive.pipe(output);
                      archive.bulk([{expand: true, cwd: temp_dir, src: ["**/*"], dot: true }
                            ]);
                      archive.finalize();
                    });
                  });
                }
              });
          });
        }
      });
}

app.post('/submit_run_as', function(req, res, next) {
    log('submit_run_as: enabled? ' + (fs.existsSync(__dirname + '/enable_run_as')));
    if (!fs.existsSync(__dirname + '/enable_run_as')) {
        return res.send('submit_run_as not enabled');
    }

    var required_fields = ['username', 'for_username', 'svn_url', 'assignment_name'];
    for (var field in required_fields) {
        if (!(required_fields[field] in req.query)) {
            return res.send('Missing "' + required_fields[field] +
                '" parameter to submit_run_as');
        }
    }

    var username = req.query.username;
    var for_username = req.query.for_username;
    var svn_url = req.query.svn_url;
    var assignment_name = req.query.assignment_name;
    log('submit_run_as: username="' + username + '" for_username="' +
        for_username + '" svn_url="' + svn_url + '" assignment_name="' +
        assignment_name + '"');

    get_user_id_for_name(username, function(user_id, err) {
        if (err) {
            return res.send('Failed getting user ID for "' + username + '"');
        }
        get_user_id_for_name(for_username, function(for_user_id, err) {
            if (err) {
                return res.send('Failed getting user ID for "' + for_username + '"');
            }
            return submit_run(user_id, username, assignment_name, false, false,
                false, svn_url, res, req, function(run_id) {
                    pgquery("UPDATE runs SET on_behalf_of=($1) WHERE " +
                        "run_id=($2)", [for_user_id, run_id],
                        function(err, rows) {
                            if (err) {
                                return res.send('Failed updating on_behalf_of');
                            }
                            return res.send('submitted ' + run_id + ' as ' +
                                username + ' on behalf of ' + for_username);
                    });
                });
        });
    });
});

app.post('/submit_run', upload.single('zip'), function(req, res, next) {

    if (fs.existsSync(__dirname + '/block_submissions')) {
        return redirect_with_err('/overview', res, req, maintenanceMsg);
    }

    var assignment_name = req.body.assignment;
    var correctness_only = false;
    if ('correctness_only' in req.body && req.body.correctness_only === 'on') {
        correctness_only = true;
    }
    var enable_profiling = false;
    if ('enable_profiling' in req.body && req.body.enable_profiling === 'on') {
        enable_profiling = true;
    }
    log('submit_run: username=' + req.session.username + ' assignment="' +
        assignment_name + '" correctness_only=' + correctness_only +
        ' enable_profiling=' + enable_profiling);

    if (assignment_name.length === 0) {
      return redirect_with_err('/overview', res, req, 'Please select an assignment');
    }

    if (!req.file && (!req.body.svn_url || req.body.svn_url.length === 0)) {
      return redirect_with_err('/overview', res, req, 'Please provide a ZIP ' +
          'file or SVN URL for your assignment.');
    }
    if (req.file && req.body.svn_url && req.body.svn_url.length > 0) {
      return redirect_with_err('/overview', res, req, 'Please provide either ' +
          'a ZIP file or SVN URL for your assignment, not both.');
    }
    var use_zip = true;
    if (!req.file && req.body.svn_url && req.body.svn_url.length > 0) {
      use_zip = false;
    }

    var svn_url = req.body.svn_url;
    if (svn_url.substring(0, 7) === 'http://') {
      svn_url = 'https://' + svn_url.substring(7);
    } else if (svn_url.substring(0, 8) !== 'https://') {
      svn_url = 'https://' + svn_url;
    }

    var user_id = req.session.user_id;
    var username = req.session.username;

    return submit_run(user_id, username, assignment_name, correctness_only,
            enable_profiling, use_zip, svn_url, res, req, function(run_id) {
                return redirect_with_success('/overview', res, req, 'Successfully launched run #' + run_id); });
});

function get_cello_work_dir(home_dir, run_id) {
  return home_dir + "/autograder/" + run_id;
}

function get_scalability_tests(ncores) {
  var tests = [];
  // tests.push(1);
  tests.push(ncores);
  /*
  var curr_cores = 1;
  while (curr_cores < ncores) {
    tests.push(curr_cores);
    curr_cores = 2 * curr_cores;
  }
  if (curr_cores / 2 != ncores) {
    tests.push(ncores);
  }
  */
  return tests;
}

function loop_over_all_perf_tests(cmd) {
  var acc = '';
  acc += 'for F in $(find src/test/java -name "*PerformanceTest.java"); do\n';
  acc += '    CLASSNAME=${F:14}\n';
  acc += '    CLASSNAME=${CLASSNAME:0:${#CLASSNAME}-5}\n';
  acc += '    CLASSNAME=${CLASSNAME//\\//.}\n';
  acc += '    ' + cmd + '\n';
  acc += 'done\n';
  acc += '\n';
  return acc;
}

function get_slurm_file_contents(run_id, home_dir, username, assignment_id,
    assignment_name, java_profiler_dir, os, ncores, junit_jar, hamcrest_jar, hj_jar,
    asm_jar, rr_agent_jar, rr_runtime_jar, assignment_jvm_args, timeout_str,
    enable_profiling, custom_slurm_flags) {
  var slurmFileContents =
    "#!/bin/bash\n" +
    "\n" +
    "#SBATCH --job-name=habanero-autograder-" + run_id + "\n" +
    "#SBATCH --nodes=1\n" +
    "#SBATCH --ntasks-per-node=1\n" +
    "#SBATCH --cpus-per-task=" + ncores + "\n" +
    "#SBATCH --mem=16000m\n" +
    "#SBATCH --time=" + timeout_str + "\n" +
    "#SBATCH --export=ALL\n" +
    "#SBATCH --partition=commons\n" +
    "#SBATCH --account=scavenge\n" +
    "#SBATCH --output=" + home_dir + "/autograder/" + run_id + "/stdout.txt\n" +
    "#SBATCH --error=" + home_dir + "/autograder/" + run_id + "/stderr.txt\n\n";
  for (var i = 0; i < custom_slurm_flags.length; i++) {
      slurmFileContents += '#SBATCH ' + custom_slurm_flags[i] + '\n';
  }
  slurmFileContents += "\n" +
    "export CELLO_WORK_DIR=" + get_cello_work_dir(home_dir, run_id) + "\n";
  if (CLUSTER_TYPE === 'slurm') {
    slurmFileContents += "echo Job $SLURM_JOBID\n";
  } else {
    slurmFileContents += "echo Local job\n";
  }
  slurmFileContents += "echo CELLO_WORK_DIR=$CELLO_WORK_DIR\n\n";

  slurmFileContents += 'function cleanup() {\n';
  slurmFileContents += '    echo Cleaning up\n';
  slurmFileContents += '    rm -f /tmp/performance*\n';
  slurmFileContents += '}\n';
  slurmFileContents += 'trap cleanup SIGHUP SIGINT SIGTERM\n\n';

  slurmFileContents += 'mkdir $CELLO_WORK_DIR/submission/student\n';
  slurmFileContents += 'unzip -qq $CELLO_WORK_DIR/submission/student.zip -d $CELLO_WORK_DIR/submission/student/\n';
  slurmFileContents += 'rm -f -r $CELLO_WORK_DIR/submission/student/.svn\n';
  slurmFileContents += 'rm -f -r $CELLO_WORK_DIR/submission/student/__MACOSX\n';
  slurmFileContents += 'NSTUDENT_FILES=$(ls -l $CELLO_WORK_DIR/submission/student/ | grep -v total | wc -l)\n';
  slurmFileContents += 'NSTUDENT_FILES=${NSTUDENT_FILES//[[:blank:]]/}\n';
  slurmFileContents += 'if [[ $NSTUDENT_FILES != 1 ]]; then\n';
  slurmFileContents += '    echo "AUTOGRADER-ERROR Unexpected number of student files: $NSTUDENT_FILES"\n';
  slurmFileContents += '    exit 1\n';
  slurmFileContents += 'fi\n';
  slurmFileContents += 'STUDENT_DIR=$(ls $CELLO_WORK_DIR/submission/student/)\n';

  slurmFileContents += 'mkdir $CELLO_WORK_DIR/assignment/instructor\n';
  slurmFileContents += 'unzip -qq $CELLO_WORK_DIR/assignment/instructor.zip -d $CELLO_WORK_DIR/assignment/instructor/\n';
  slurmFileContents += 'NINSTRUCTOR_FILES=$(ls -l $CELLO_WORK_DIR/assignment/instructor/ | grep -v total | wc -l);\n';
  slurmFileContents += 'NINSTRUCTOR_FILES=${NINSTRUCTOR_FILES//[[:blank:]]/}\n';
  slurmFileContents += 'if [[ $NINSTRUCTOR_FILES != 1 ]]; then\n';
  slurmFileContents += '    echo "AUTOGRADER-ERROR Unexpected number of instructor files: $NINSTRUCTOR_FILES"\n';
  slurmFileContents += '    exit 1\n';
  slurmFileContents += 'fi\n';
  slurmFileContents += 'INSTRUCTOR_DIR=$(ls $CELLO_WORK_DIR/assignment/instructor/)\n';

  slurmFileContents += 'cp -r $CELLO_WORK_DIR/assignment/instructor/$INSTRUCTOR_DIR/src/test/* $CELLO_WORK_DIR/submission/student/$STUDENT_DIR/src/test/\n';
  slurmFileContents += 'cp $CELLO_WORK_DIR/assignment/instructor_pom.xml $CELLO_WORK_DIR/submission/student/$STUDENT_DIR/pom.xml\n';

  slurmFileContents += 'for F in $(find $CELLO_WORK_DIR/submission/student/$STUDENT_DIR/ -name "*CorrectnessTest.java"); do\n';
  slurmFileContents += '    rm $F\n';
  slurmFileContents += 'done\n';
  slurmFileContents += '\n';
  slurmFileContents += 'mvn -Dcheckstyle.skip=true -f $CELLO_WORK_DIR/submission/student/$STUDENT_DIR/pom.xml clean compile test-compile\n';
  slurmFileContents += 'cd $CELLO_WORK_DIR/submission/student/$STUDENT_DIR\n';

  var remotePolicyPath = '$CELLO_WORK_DIR/security.policy';
  var securityFlags = '-Djava.security.manager -Djava.security.policy==' + remotePolicyPath;
  var tests = get_scalability_tests(ncores);
  var classpath = ['.', 'target/classes', 'target/test-classes', junit_jar,
                   hamcrest_jar, hj_jar, asm_jar];
  for (var t = 0; t < tests.length; t++) {
    var curr_cores = tests[t];
    var output_file = '/tmp/performance.' + run_id + '.' + curr_cores + '.txt';
    var final_output_file = '$CELLO_WORK_DIR/performance.' + curr_cores + '.txt';

    // Limit the number of cores this test can use
    var cpu_list = '0';
    for (var c = 1; c < curr_cores; c++) {
        cpu_list += ',' + c;
    }

    slurmFileContents += 'touch ' + output_file + '\n';
    slurmFileContents += 'touch ' + final_output_file + '\n';
    slurmFileContents += loop_over_all_perf_tests('taskset --cpu-list ' +
        cpu_list + ' java ' + securityFlags + ' -Dhj.numWorkers=' + curr_cores +
        ' -javaagent:' + hj_jar + ' -cp ' + classpath.join(':') + ' ' +
        'org.junit.runner.JUnitCore $CLASSNAME >> ' + output_file + ' 2>&1');
    slurmFileContents += 'NBYTES=$(cat ' + output_file + ' | wc -c)\n';
    slurmFileContents += 'if [[ "$NBYTES" -gt "' + MAX_FILE_SIZE + '" ]]; then\n';
    slurmFileContents += '    echo "' + excessiveFileSizeMsg + '" > ' + final_output_file + '\n';
    slurmFileContents += '    echo "" >> ' + final_output_file + '\n';
    slurmFileContents += '    truncate --size ' + MAX_FILE_SIZE + ' ' + output_file + '\n';
    slurmFileContents += 'fi\n';
    slurmFileContents += 'cat ' + output_file + ' >> ' + final_output_file + '\n';
    slurmFileContents += 'rm -f ' + output_file + '\n';
  }
  slurmFileContents += '\n';

  if (enable_profiling) {
      var profiler_output = '$CELLO_WORK_DIR/profiler.txt';
      slurmFileContents += 'touch ' + profiler_output + '\n';
      slurmFileContents += loop_over_all_perf_tests(
        'java ' + securityFlags + ' -Dhj.numWorkers=' + ncores +
        ' -agentpath:' + java_profiler_dir + '/liblagent.so ' +
        '-javaagent:' + hj_jar + ' -cp ' + classpath.join(':') + ' ' +
        'org.junit.runner.JUnitCore $CLASSNAME >> ' + profiler_output + ' 2>&1 ; ' +
        'echo ===== Profiling test $CLASSNAME ===== >> $CELLO_WORK_DIR/traces.txt; ' +
        'cat $CELLO_WORK_DIR/submission/student/$STUDENT_DIR/traces.txt >> ' +
        '$CELLO_WORK_DIR/traces.txt');
      slurmFileContents += 'awk \'BEGIN { doPrint = 1; } /Profiling/ { ' +
        'doPrint = 0; print $0; } /Total trace count/ { doPrint = 1; } /Failures:/ { doPrint = 0; } { ' +
        'if (doPrint) print $0; }\' $CELLO_WORK_DIR/traces.txt > ' +
        '$CELLO_WORK_DIR/traces.filtered.txt\n';
      slurmFileContents += 'mv $CELLO_WORK_DIR/traces.filtered.txt ' +
        '$CELLO_WORK_DIR/traces.txt\n';
      slurmFileContents += '\n';
  }

  /*
   * A bug in JDK 8 [1] leads to the FastTrack data race detector crashing on
   * Mac OS.
   *
   * [1] http://bugs.java.com/bugdatabase/view_bug.do?bug_id=8022291
   */
  // if (os !== 'Darwin') {
  //   var rr_output = '$CELLO_WORK_DIR/datarace.txt';
  //   slurmFileContents += loop_over_all_perf_tests('java ' +
  //     assignment_jvm_args + ' ' + securityFlags + ' -cp ' +
  //     classpath.join(':') + ' -Dhj.numWorkers=' + ncores + ' -javaagent:' +
  //     hj_jar + ' -javaagent:' + rr_agent_jar + ' -Xbootclasspath/p:' +
  //     rr_runtime_jar + ' rr.RRMain -toolpath= -maxTid=80 -tool=FT_CHECKER ' +
  //     '-noWarn=+edu.rice.hj.runtime.* -classpath=' + classpath.join(':') +
  //     ' -maxWarn=20 -quiet org.junit.runner.JUnitCore $CLASSNAME >> ' +
  //     rr_output + ' 2>&1');
  // }

  return slurmFileContents;
}

function failed_starting_perf_tests(res, failure_msg, run_id) {
  pgquery(
      "UPDATE runs SET status='" + FAILED_STATUS + "',finish_time=CURRENT_TIMESTAMP," +
      "cello_msg='An internal error occurred initiating the performance " +
      "tests, please contact the teaching staff' WHERE run_id=($1)",
      [run_id], function(err, rows) {
          if (err) {
              return log('Error storing failure starting perf tests: ' + err);
          }
          log('Failure initiating performance tests: ' + failure_msg);
          return res.send(JSON.stringify({status: 'Failure', msg: failure_msg}));
      });
}

function email_for_user(username) {
  var email = username + '@rice.edu';
  if (username === 'admin') {
    email = 'jmg3@rice.edu';
  }
  return email;
}

function count_new_lines(content) {
  var count = 0;
  for (var i = 0; i < content.length; i++) {
    if (content.charAt(i) == 10) count++;
  }
  return count;
}

app.post('/local_run_finished', function(req, res, next) {
    var done_token = req.body.done_token;
    var viola_err_msg = req.body.err_msg;

    log('local_run_finished: done_token=' + done_token + ' err_msg="' +
        viola_err_msg + '"');

    // Can only be one match here because of SQL schema constraints
    pgquery_no_err("SELECT * FROM runs WHERE done_token=($1)", [done_token],
        res, req, function(rows) {
      if (rows.length != 1) {
          return failed_starting_perf_tests(res, 'Unexpected # of rows', -1);
      } else if (rows[0].status !== TESTING_CORRECTNESS_STATUS) {
          log('local_run_finished: received duplicate local run ' +
              'completion notifications from viola for run ' +
              rows[0].run_id);
          return res.send(JSON.stringify({ status: 'Success' }));
      } else {
        var run_id = rows[0].run_id;
        var user_id = rows[0].user_id;
        var assignment_id = rows[0].assignment_id;
        var correctness_only = rows[0].correctness_only;
        var enable_profiling = rows[0].enable_profiling;

        log('local_run_finished: run_id=' + run_id + ' user_id=' +
            user_id + ' assignment_id=' + assignment_id +
            ' correctness_only=' + correctness_only + ' enable_profiling=' +
            enable_profiling);

        pgquery_no_err("SELECT * FROM users WHERE user_id=($1)", [user_id], res,
                req, function(rows) {
          if (rows.length != 1) {
              return failed_starting_perf_tests(res, 'Invalid user ID', run_id);
          } else {
            var username = rows[0].user_name;
            var wants_notification = rows[0].receive_email_notifications;
            var run_dir = run_dir_path(username, run_id);

            /*
             * Update the status of these tests in the 'runs' table for
             * display in the leaderboard. These files should have already
             * been transferred on to the conductor by the viola component.
             */
            var compile_txt = run_dir + '/compile.txt';
            var checkstyle_txt = run_dir + '/checkstyle.txt';
            var correct_txt = run_dir + '/correct.txt';
            var compile_passed = false;
            var checkstyle_passed = false;
            var correctness_tests_passed = false;
             
            if (fs.existsSync(checkstyle_txt) &&
                  get_file_size(checkstyle_txt) < MAX_FILE_SIZE) {
                // Checkstyle passed?
                var checkstyle_contents = fs.readFileSync(checkstyle_txt, 'utf8');
                var checkstyle_new_lines = count_new_lines(checkstyle_contents);
                checkstyle_passed = (checkstyle_new_lines === 0);
                if (checkstyle_passed && fs.existsSync(compile_txt) &&
                    get_file_size(compile_txt) < MAX_FILE_SIZE) {
                  // Successfully compiled?
                  var compile_contents = fs.readFileSync(compile_txt, 'utf8');
                  compile_passed = (compile_contents.indexOf('BUILD SUCCESS') != -1);
                  if (compile_passed && fs.existsSync(correct_txt) &&
                          get_file_size(correct_txt) < MAX_FILE_SIZE) {
                    // Correctness tests passed?
                    var correct_contents = fs.readFileSync(correct_txt, 'utf8');
                    var lines = correct_contents.split('\n');
                    var any_failures = false;
                    for (var l = 0; l < lines.length && !any_failures; l++) {
                      var line = lines[l];
                      if (string_starts_with(line, 'There were ') && string_ends_with(line, ' failures:')) {
                        any_failures = true;
                      } else if (string_starts_with(line, 'There was ') && string_ends_with(line, ' failure:')) {
                        any_failures = true;
                      }
                    }
                    var any_nonempty_stderr_lines = check_for_empty_stderr(lines);
                    correctness_tests_passed = !any_failures && !any_nonempty_stderr_lines;
                  }
                }
            }

            pgquery_no_err('UPDATE runs SET passed_checkstyle=($1),' +
                'compiled=($2),passed_all_correctness=($3) WHERE run_id=($4)',
                [checkstyle_passed, compile_passed, correctness_tests_passed,
                run_id], res, req, function(rows) {
              var run_status = FINISHED_STATUS;
              if (viola_err_msg === 'Cancelled by user') {
                  run_status = CANCELLED_STATUS;
              }
              if (correctness_only || run_status === CANCELLED_STATUS) {
                  pgquery_no_err("UPDATE runs SET status='" + run_status +
                      "',viola_msg=$1,finish_time=CURRENT_TIMESTAMP WHERE run_id=($2)",
                      [viola_err_msg, run_id], res, req, function(rows) {
                      if (wants_notification) {
                        var subject = 'Habanero AutoGrader Run ' + run_id + ' Finished';
                        send_email(email_for_user(username), subject, '', function(err) {
                          if (err) {
                            return failed_starting_perf_tests(res,
                              'Failed sending notification e-mail, err=' + err, run_id);
                          } else {
                            return res.send(
                              JSON.stringify({ status: 'Success' }));
                          }
                        });
                      } else {
                        return res.send(
                          JSON.stringify({ status: 'Success' }));
                      }
                  });
              } else {
                  pgquery_no_err(
                    "SELECT * FROM assignments WHERE assignment_id=($1)",
                    [assignment_id], res, req, function(rows) {
                    var assignment_name = rows[0].name; 
                    var assignment_jvm_args = rows[0].jvm_args;
                    var timeout_str = rows[0].performance_timeout_str;
                    var ncores = rows[0].ncores;
                    var custom_slurm_flags_str = rows[0].custom_slurm_flags;
                    var custom_slurm_flags_list =
                      custom_slurm_flags_str.split(',');

                  pgquery_no_err("UPDATE runs SET status='" +
                      IN_CLUSTER_QUEUE_STATUS + "',viola_msg=$1," +
                      "ncores=$2 WHERE run_id=($3)",
                      [viola_err_msg, ncores, run_id], res, req, function(rows) {
                        log('local_run_finished: Connecting to ' +
                            CLUSTER_USER + '@' + CLUSTER_HOSTNAME);
                        // Launch on the cluster

                        var vars = ['HOME',
                                    'LIGHTWEIGHT_JAVA_PROFILER_HOME',
                                    'JUNIT_JAR', 'HAMCREST_JAR',
                                    'ASM_JAR', 'RR_AGENT_JAR', 'RR_RUNTIME_JAR'];
                        batched_get_cluster_env_var(vars, function(err, vals) {
                          if (err) {
                            return failed_starting_perf_tests(res,
                              'Error getting cluster env variables, err=' + err, run_id);
                          }

                          var home_dir = vals.HOME;
                          var java_profiler_dir = vals.LIGHTWEIGHT_JAVA_PROFILER_HOME;
                          var rr_agent_jar = vals.RR_AGENT_JAR;
                          var rr_runtime_jar = vals.RR_RUNTIME_JAR;

                          var cello_work_dir = get_cello_work_dir(home_dir, run_id);
                          var dependency_list_cmd = 'mvn -f ' +
                              cello_work_dir +
                              '/assignment/instructor_pom.xml ' +
                              '-DoutputAbsoluteArtifactFilename=true ' +
                              'dependency:list';
                          var localPolicyPath = AUTOGRADER_HOME + '/shared/security.policy';

                          var junit = vals.JUNIT_JAR;
                          var hamcrest = vals.HAMCREST_JAR;
                          var asm = vals.ASM_JAR;

                          get_cluster_os(function(err, os) {
                            if (err) {
                              return failed_starting_perf_tests(res,
                                'Failed getting cluster OS', run_id);
                            }

                            create_cluster_dir('autograder/' + run_id + '/submission',
                                function(err, stdout, stderr) {
                                  if (err) {
                                    return failed_starting_perf_tests(res,
                                      'Failed creating autograder dir', run_id);
                                  }
                                  cluster_scp(run_dir_path(username, run_id) + '/student.zip', 'autograder/' + run_id + '/submission/student.zip', true, function(err) {
                                      if (err) {
                                        return failed_starting_perf_tests(res,
                                             'Failed checking out student code', run_id);
                                      }
                                      run_cluster_cmd(
                                              'instructor files cp',
                                              'cp -r autograder-assignments/' + assignment_id + ' autograder/' + run_id + '/assignment', function(err, stdout, stderr) {
                                          if (err) {
                                            return failed_starting_perf_tests(res,
                                                  'Failed checking out assignment code', run_id);
                                          }
                                          run_cluster_cmd('get dependencies', dependency_list_cmd,
                                            function(err, stdout, stderr) {
                                              if (err) {
                                                return failed_starting_perf_tests(res, 'Failed getting dependencies', run_id);
                                              }
                                              var dependency_lines = stdout.split('\n');
                                              var dependency_lines_index = 0;
                                              while (dependency_lines_index < dependency_lines.length &&
                                                  dependency_lines[dependency_lines_index] !== '[INFO] The following files have been resolved:') {
                                                dependency_lines_index += 1;
                                              }
                                              var hj = null;
                                              while (dependency_lines_index < dependency_lines.length &&
                                                  dependency_lines[dependency_lines_index] !== '[INFO] ') {
                                                var curr = dependency_lines[dependency_lines_index];
                                                var components = curr.split(':');
                                                var path = components[5];

                                                if (components[1] == 'hjlib-cooperative') {
                                                  hj = path;
                                                }
                                                dependency_lines_index += 1;
                                              }
                                              if (hj === null) {
                                                return failed_starting_perf_tests(res, 'Unable to find HJ JAR on cluster', run_id);
                                              }

                                              fs.appendFileSync(run_dir + '/cello.slurm',
                                                get_slurm_file_contents(run_id, home_dir,
                                                  username, assignment_id, assignment_name,
                                                  java_profiler_dir, os, ncores, junit,
                                                  hamcrest, hj, asm, rr_agent_jar, rr_runtime_jar,
                                                  assignment_jvm_args, timeout_str, enable_profiling,
                                                  custom_slurm_flags_list));

                                              var copies = [{src: run_dir + '/cello.slurm',
                                                             dst: 'autograder/' + run_id + '/cello.slurm'},
                                                            {src: localPolicyPath,
                                                             dst: 'autograder/' + run_id + '/security.policy'}];
                                              batched_cluster_scp(copies, true, function(stat) {
                                                  for (var i = 0; i < stat.length; i++) {
                                                    if (!stat[i].success) {
                                                      log('scp err copying to ' + stat[i].dst + ' from ' + stat[i].src + ', ' + stat[i].err);
                                                      return failed_starting_perf_tests(res,
                                                        'Failed scp-ing cello.slurm+security.policy', run_id);
                                                    }
                                                  }

                                                  if (CLUSTER_TYPE === 'slurm') {
                                                      run_cluster_cmd('sbatch',
                                                          'sbatch ~/autograder/' + run_id + '/cello.slurm',
                                                          function(err, stdout, stderr) {
                                                              if (err) {
                                                                return failed_starting_perf_tests(res,
                                                                  'Failed submitting job', run_id);
                                                              }
                                                              // stdout == Submitted batch job 474297
                                                              if (stdout.search('Submitted batch job ') !== 0) {
                                                                  return failed_starting_perf_tests(res,
                                                                          'Failed submitting batch job', run_id);
                                                              }

                                                              var tokens = stdout.trim().split(' ');
                                                              var job_id = tokens[tokens.length - 1];
                                                              pgquery_no_err('UPDATE runs SET job_id=($1) WHERE run_id=($2)', [job_id, run_id], res, req, function(rows) {
                                                                      return res.send(
                                                                          JSON.stringify({ status: 'Success' }));
                                                                  });
                                                          });
                                                  } else {
                                                    // local cluster
                                                    var cello_script = process.env.HOME + '/autograder/' + run_id + '/cello.slurm';
                                                    log('local_run_finished: starting local run from ' + cello_script);
                                                    var run_cmd = '/bin/bash ' + cello_script;

                                                    run_cluster_cmd('local perf run', run_cmd,
                                                        function(err, stdout, stderr) {

                                                          fs.appendFileSync(process.env.HOME + '/autograder/' + run_id + '/stdout.txt', stdout);
                                                          fs.appendFileSync(process.env.HOME + '/autograder/' + run_id + '/stderr.txt', stderr);

                                                          if (err) {
                                                            return failed_starting_perf_tests(res,
                                                              'Failed running on local cluster', run_id);
                                                          }

                                                          pgquery_no_err('UPDATE runs SET job_id=($1) WHERE run_id=($2)', [LOCAL_JOB_ID, run_id], res, req, function(rows) {
                                                                  return res.send(
                                                                      JSON.stringify({ status: 'Success' }));
                                                              });
                                                        });
                                                  }
                                              });
                                        });
                                      });
                                    });
                                });
                          });
                          });
                      });
                  });
              }
            });
          }
        });
      }
    });
});

function get_all_assignments(cb) {
    pgquery("SELECT * FROM assignments ORDER BY assignment_id ASC", [], function(err, rows) {
        if (err) {
            cb(null, err);
        } else {
            cb(rows, null);
        }
    });
}

function get_visible_assignments(cb) {
    pgquery("SELECT * FROM assignments WHERE visible=true", [], function(err, rows) {
        if (err) {
            cb(null, err);
        } else {
            cb(rows, null);
        }
    });
}

function get_runs_for_username(username, cb) {
    pgquery("SELECT * FROM users WHERE user_name=($1)", [username], function(err, rows) {
        if (err) return cb(null, err);
        var user_id = rows[0].user_id;

        pgquery("SELECT * FROM runs WHERE user_id=($1) ORDER BY run_id DESC",
              [user_id], function(err, rows) {
                  if (err) return cb(null, err);

                  var runs = rows;

                  pgquery("SELECT * FROM assignments", [], function(err, rows) {
                      if (err) return cb(null, err);

                      var assignment_mapping = {};
                      for (var i = 0; i < rows.length; i++) {
                          assignment_mapping[rows[i].assignment_id] = rows[i].name;
                      }
                      var translated_runs = [];
                      for (var r = 0; r < runs.length; r++) {
                          var name = assignment_mapping[runs[r].assignment_id];
                          translated_runs.push({run_id: runs[r].run_id,
                              assignment_name: name,
                              status: runs[r].status,
                              finish_time: runs[r].finish_time });
                      }
                      return cb(translated_runs, null);
                  });
              });
    });
}

var dont_display = ['profiler.txt'];

function arr_contains(target, arr) {
  for (var i = 0; i < arr.length; i++) {
    if (target === arr[i]) {
      return true;
    }
  }
  return false;
}

function failed_validation(err_msg) {
    log('failed_validation: ' + err_msg);
    return {success: false, msg: err_msg};
}

function validate_instructor_pom(pom_file) {
  var xml = fs.readFileSync(pom_file, 'utf8');
  var hjlib_version_tag = '<hjlib.version>';
  var found = xml.search(hjlib_version_tag);
  if (found === -1) {
    return failed_validation('The provided instructor POM does not seem to ' +
            'contain a hjlib.version property');
  }
  var version_index = found + hjlib_version_tag.length;
  var end_version = version_index;
  while (end_version < xml.length && xml[end_version] != '<') {
    end_version++;
  }
  var version_str = xml.substring(version_index, end_version);
  var split = version_str.split('.');
  if (split.length != 3 || isNaN(split[0]) || isNaN(split[1])) {
    return failed_validation('The provided instructor POM does not seem to ' +
        'contain a valid hjlib.version property, expected a version number ' +
        'separated with two periods');
  }
  
  return { success: true, version: version_str };
}

function load_and_validate_rubric(rubric_file) {
  var rubric = null;
  try {
    rubric = JSON.parse(fs.readFileSync(rubric_file));
  } catch (err) {
    return failed_validation('Failed to parse rubric JSON: ' + err.message);
  }

  if (!rubric.hasOwnProperty('correctness')) {
    return failed_validation('Rubric is missing correctness section');
  }
  if (!rubric.hasOwnProperty('performance')) {
    return failed_validation('Rubric is missing performance section');
  }
  if (!rubric.hasOwnProperty('style')) {
    return failed_validation('Rubric is missing style section');
  }

  if (!rubric.performance.hasOwnProperty('tests')) {
    return failed_validation('Rubric is missing tests field of performance ' +
            'section');
  }

  if (rubric.performance.tests.length > 0 &&
          !rubric.performance.hasOwnProperty('characteristic_test')) {
    return failed_validation('Rubric is missing characteristic_test field of ' +
            'performance section');
  }

  for (var c = 0; c < rubric.correctness.length; c++) {
    if (!rubric.correctness[c].hasOwnProperty('testname')) {
      return failed_validation('Correctness test is missing name');
    }
    if (!rubric.correctness[c].hasOwnProperty('points_worth') ||
        rubric.correctness[c].points_worth < 0.0) {
      return failed_validation('Correctness test is missing valid points_worth');
    }
  }

  for (var p = 0; p < rubric.performance.tests.length; p++) {
    if (!rubric.performance.tests[p].hasOwnProperty('testname')) {
      return failed_validation('Performance test is missing name');
    }
    if (!rubric.performance.tests[p].hasOwnProperty('points_worth')) {
      return failed_validation('Performance test is missing points_worth');
    }
    var points_worth = rubric.performance.tests[p].points_worth;
    if (!rubric.performance.tests[p].hasOwnProperty('grading')) {
      return failed_validation('Performance test is missing speedup grading');
    }

    for (var g = 0; g < rubric.performance.tests[p].grading.length; g++) {
      if (!rubric.performance.tests[p].grading[g].hasOwnProperty('bottom_inclusive')) {
        return failed_validation('Performance test grading is missing bottom_inclusive');
      }
      if (!rubric.performance.tests[p].grading[g].hasOwnProperty('top_exclusive')) {
        return failed_validation('Performance test grading is missing top_exclusive');
      }
      if (!rubric.performance.tests[p].grading[g].hasOwnProperty('points_off')) {
        return failed_validation('Performance test grading is missing points_off');
      }
      if (rubric.performance.tests[p].grading[g].points_off > points_worth) {
        return failed_validation('Performance test grading is more than points_worth');
      }
    }
  }

  if (!rubric.style.hasOwnProperty('points_per_error')) {
    return failed_validation('Style section is missing points_per_error');
  }
  if (!rubric.style.hasOwnProperty('max_points_off')) {
    return failed_validation('Style section is missing max_points_off');
  }

  return { success: true, rubric: rubric };
}

function find_correctness_test_with_name(name, rubric) {
  for (var c = 0; c < rubric.correctness.length; c++) {
    if (rubric.correctness[c].testname === name) {
      return rubric.correctness[c];
    }
  }
  return null;
}

function find_performance_test_with_name(name, rubric) {
  for (var p = 0; p < rubric.performance.tests.length; p++) {
    if (rubric.performance.tests[p].testname === name) {
      return rubric.performance.tests[p];
    }
  }
  return null;
}

function check_for_empty_stderr(lines) {
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

function run_completed(run_status) {
  return run_status !== FAILED_STATUS && run_status !== CANCELLED_STATUS;
}

// Conductor-local assignment directory path
function assignment_path(assignment_id) {
    return __dirname + '/instructor-tests/' + assignment_id;
}

function rubric_file_path(assignment_id) {
    return assignment_path(assignment_id) + '/rubric.json';
}

// Local run directory
function run_dir_path(username, run_id) {
    return __dirname + '/submissions/' + username + '/' + run_id;
}

function calculate_score(assignment_id, log_files, ncores, run_status, run_id) {
  var rubric_file = rubric_file_path(assignment_id);

  var validated = load_and_validate_rubric(rubric_file);
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
  if (run_completed(run_status) && 'correct.txt' in log_files) {
    var correctness_content = log_files['correct.txt'].toString('utf8');
    var correctness_lines = correctness_content.split('\n');

    /*
     * First check if anything was printed to STDERR. This may indicate anything
     * (from harmless prints by the student, to OutOfMemoryException) so we
     * conservatively give zero points if STDERR is non-empty.
     */
    var any_nonempty_stderr_lines = check_for_empty_stderr(correctness_lines);

    if (any_nonempty_stderr_lines) {
      log('calculate_score: setting correctness score to 0 for run ' +
              run_id + ' due to non-empty stderr');
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
                correctness -= correctness_test.points_worth;
              }
            }
          }
        }
      }
    }
  } else {
    log('calculate_score: setting correctness score to 0 for run ' +
            run_id + ', run_status=' + run_status +
            ', correct.txt in log files? ' + ('correct.txt' in log_files));
    correctness = 0.0;
  }

  // Compute performance score based on performance of each test
  var performance = 0.0;
  if (run_completed(run_status) && 'performance.' + ncores + '.txt' in log_files) {
    var multi_thread_content = log_files['performance.' + ncores + '.txt'].toString('utf8');

    var multi_thread_lines = multi_thread_content.split('\n');

    for (var multi_thread_line in multi_thread_lines) {
      if (string_starts_with(multi_thread_line, PERF_TEST_LBL)) {
        var tokens = multi_thread_line.split(' ');
        var performance_testname = tokens[2];
        var seq_time = parseInt(tokens[3]);
        var parallel_time = parseInt(tokens[4]);

        log('calculate_score: found multi thread perf for test=' +
                performance_testname + ', seq_time=' + seq_time + ', parallel_time=' +
                parallel_time + ' for run ' + run_id);

        var performance_test = find_performance_test_with_name(performance_testname, rubric);
        if (performance_test) {
          var speedup = seq_time / parallel_time;
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
        }
      }
    }
  } else {
      log('calculate_score: forcing performance to 0 for run ' +
              run_id + ', run_status=' + run_status + ', have performance ' +
              'log file? ' + ('performance.' + ncores + '.txt' in log_files));
  }

  // Compute style score based on number of style violations
  var style = rubric.style.max_points_off;
  if ('checkstyle.txt' in log_files) {
    var checkstyle_content = log_files['checkstyle.txt'].toString('utf8');
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

    style -= errorCount * rubric.style.points_per_error;
    if (style < 0.0) style = 0.0;
  } else {
    style = 0.0;
  }

  return { total: correctness + performance + style,
           total_possible: total_possible,
           breakdown: [
                       { name: 'Correctness', points: correctness,
                         total: total_correctness_possible },
                       { name: 'Performance', points: performance,
                         total: total_performance_possible },
                       { name: 'Style', points: style,
                         total: rubric.style.max_points_off }
                      ]};
}

app.get('/run/:run_id', function(req, res, next) {
    var run_id = req.params.run_id;
    log('run: run_id=' + run_id);

    pgquery_no_err("SELECT * FROM runs WHERE run_id=($1)", [run_id], res, req, function(rows) {
        if (rows.length === 0) {
            return redirect_with_err('/overview', res, req, 'Unknown run');
        }
        var user_id = rows[0].user_id;
        var run_status = rows[0].status;
        var assignment_id = rows[0].assignment_id;
        var viola_err_msg = rows[0].viola_msg;
        var cello_msg = rows[0].cello_msg;
        var ncores = rows[0].ncores; 
        var passed_checkstyle = rows[0].passed_checkstyle;
        var compiled = rows[0].compiled;
        var passed_all_correctness = rows[0].passed_all_correctness;
        // e.g. 2016-02-13 18:30:20.028665
        var start_time = moment(rows[0].start_time);
        var correctness_only = rows[0].correctness_only;
        var passed_performance = rows[0].passed_performance;

        var elapsed_time = null;
        var diff_ms = null;
        var finished = false;
        if (rows[0].finish_time) {
          diff_ms = moment(rows[0].finish_time).diff(start_time);
          finished = true;
        } else {
          diff_ms = moment().diff(start_time);
        }
        var minutes = Math.floor(diff_ms / 60000);
        var seconds = Math.floor(diff_ms / 1000) - (minutes * 60);
        var milliseconds = diff_ms - (minutes * 60000) - (seconds * 1000);
        var started = false;
        if (minutes > 0) {
          elapsed_time = elapsed_time + minutes + 'm';
          started = true;
        }
        if (seconds > 0) {
          if (started) elapsed_time = elapsed_time + ', ';
          elapsed_time = elapsed_time + seconds + 's';
          started = true;
        }
        if (milliseconds > 0) {
          if (started) elapsed_time = elapsed_time + ', ';
          elapsed_time = elapsed_time + milliseconds + 'ms';
        }

        if (rows[0].on_behalf_of !== null) {
            // If this is an instructor run using a student submission, that student can view this submission
            if (!req.session.is_admin && rows[0].on_behalf_of != req.session.user_id) {
                return res.sendStatus(401);
            }
        } else {
            // Instructors can view all submissions, students can only view their own submissions
            if (!req.session.is_admin && user_id != req.session.user_id) {
                return res.sendStatus(401);
            }
        }

        pgquery_no_err("SELECT name FROM assignments WHERE assignment_id=($1)",
                [assignment_id], res, req, function(rows) {
            var assignment_name = rows[0].name;

            pgquery_no_err("SELECT * FROM users WHERE user_id=($1)", [user_id],
                res, req, function(rows) {

                var username = rows[0].user_name;
                var run_dir = __dirname + '/submissions/' + username + '/' + run_id;
                /*
                 * If bugs cause submissions to fail, their storage may not exist.
                 * This shouldn't happen in a bugless AutoGrader.
                 */
                if (!fs.existsSync(run_dir)) {
                  return render_page('missing_run.html', res, req, { run_id: run_id });
                } else {
                  var cello_err = null;
                  var log_files = {};
                  fs.readdirSync(run_dir).forEach(function(file) {
                    if (file.indexOf('.txt', file.length - '.txt'.length) !== -1 &&
                          !arr_contains(file, dont_display)) {
                        log('run: run_id=' + run_id + ' reading file ' + run_dir + '/' + file);
                        var path = run_dir + '/' + file;
                        if (get_file_size(path) < MAX_FILE_SIZE) {
                          var contents = fs.readFileSync(run_dir + '/' + file, 'utf8');
                          log_files[file] = contents;

                          if (cello_err === null) {
                              if (file === 'cluster-stdout.txt') {
                                  var lines = contents.split('\n');
                                  for (var i = 0; i < lines.length; i++) {
                                      if (string_starts_with(lines[i], 'AUTOGRADER-ERROR')) {
                                          cello_err = lines[i].substring(17);
                                          break;
                                      }
                                  }
                              } else if (file === 'cluster-stderr.txt') {
                                  cello_err = contents;
                              }
                          }
                        } else {
                            log_files[file] = 'Unusually large file, unable to display.';
                        }
                    }
                  });

                  if (cello_err === null && cello_msg.length > 0) {
                      cello_err = cello_msg;
                  }

                  var score = calculate_score(assignment_id, log_files, ncores,
                          run_status, run_id);
                  var render_vars = {run_id: run_id, log_files: log_files,
                                     viola_err: viola_err_msg, cello_err: cello_err,
                                     passed_checkstyle: passed_checkstyle,
                                     compiled: compiled,
                                     passed_all_correctness: passed_all_correctness,
                                     elapsed_time: elapsed_time, finished: finished,
                                     has_performance_tests: !correctness_only,
                                     passed_performance: passed_performance,
                                     run_status: run_status,
                                     assignment_name: assignment_name};
                  if (score) {
                    log('run: calculated score ' + score.total + '/' +
                            score.total_possible + ' for run ' + run_id);
                    render_vars.score = score;
                  } else {
                    log('run: error calculating score for run ' + run_id);
                    render_vars.score = {total: 0.0, total_possible: 0.0,
                        breakdown: []};
                    render_vars.err_msg = 'Error calculating score';
                  }

                  return render_page('run.html', res, req, render_vars);
                }
            });
        });
    });
});

app.post('/cancel/:run_id', function(req, res, next) {
    log('cancel: run_id=' + req.params.run_id + ' user=' + req.session.username);
    if (!req.params.run_id) {
        return redirect_with_err('/overview', res, req,
            'No run ID was provided for cancellation');
    }

    // Check permission to cancel this run
    pgquery('SELECT * FROM runs WHERE (user_id=($1)) AND (run_id=($2))',
        [req.session.user_id, req.params.run_id], res, req, function(rows) {
        if (rowCount != 1) {
            return redirect_with_err('/overview', res, req,
                'You do not appear to have permission to cancel that run');
        }
        var correctness_only = rows[0].correctness_only;
        var run_status = rows[0].status;

        if (run_status === FINISHED_STATUS ||
            run_status === CANCELLED_STATUS || run_status === FAILED_STATUS) {
            return redirect_with_success('/overview', res, req,
                'That run has already completed');
        }

        var viola_params = 'done_token=' + rows[0].done_token;
        var viola_options = { host: VIOLA_HOST,
            port: VIOLA_PORT, path: '/cancel?' + encodeURI(viola_params) };
        log('cancel: signaling Viola to cancel run ' + req.params.run_id);
        http.get(viola_options, function(viola_res) {
            var bodyChunks = [];
            viola_res.on('data', function(chunk) {
                bodyChunks.push(chunk);
            });
            viola_res.on('end', function() {
                var body = Buffer.concat(bodyChunks);
                var result = JSON.parse(body);
                if (result.status === 'Success') {
                    var found_run_on_viola = result.found;
                    if (found_run_on_viola || correctness_only) {
                        // We can be confident the run was killed or completed on Viola before reaching the cluster
                        log('cancel: run ' + req.params.run_id + ' successfully cancelled on Viola');
                        return redirect_with_success('/overview', res, req,
                            cancellationSuccessMsg);
                    } else {
                        /*
                         * At some point in the future, the
                         * local_run_finished endpoint will try to create a
                         * cluster job for this run. If it doesn't seem to
                         * have happened yet, report an error message to the
                         * user to try again in the future.
                         */
                        log('cancel: run cancellation did not find run ' + req.params.run_id + ' on Viola');
                        pgquery_no_err('SELECT * FROM runs WHERE run_id=($1)', [req.params.run_id], res, req, function(rows) {
                            if (rows[0].job_id && rows[0].job_id.length > 0) {
                                var job_id = rows[0].job_id;
                                if (job_id === LOCAL_JOB_ID) {
                                    return redirect_with_success('/overview',
                                        res, req, cancellationSuccessMsg);
                                } else {
                                    run_cluster_cmd('job cancellation', 'scancel ' + job_id, function(err, stdout, stderr) {
                                        if (err) {
                                            return redirect_with_err('/overview', res, req, 'Failed cancelling job on cluster');
                                        }
                                        return redirect_with_success('/overview', res, req, cancellationSuccessMsg);
                                    });
                                }
                            } else {
                                return redirect_with_err('/overview', res, req,
                                    'Failed cancelling job on cluster. Please try again.');
                            }
                        });
                    }
                } else {
                    return redirect_with_err('/overview', res, req, 'Viola error: ' + result.msg);
                }
            });
        }).on('error', function(err) {
            log('VIOLA err="' + err + '"');
            return redirect_with_err('/overview', res, req,
                'An error occurred cancelling run ' + req.params.run_id);
        });
    });
});

// Should be the last route in this file
app.get('/', function(req, res, next) {
  return res.redirect('overview');
});

var checkClusterActive = false;
function set_check_cluster_timeout(t) {
    log('set_check_cluster_timeout: timeout=' + t);
    checkClusterActive = false;
    setTimeout(check_cluster, t);
}

function abort_and_reset_perf_tests(err, lbl) {
  log('abort_and_reset_perf_tests: ' + lbl + ' err=' + err);
  set_check_cluster_timeout(CHECK_CLUSTER_PERIOD_MS);
}

function finish_perf_tests(run_status, run, perf_runs,
        current_perf_runs_index) {
    pgquery('SELECT * FROM users WHERE user_id=($1)', [run.user_id], function(err, rows) {
        if (err) {
            set_check_cluster_timeout(CHECK_CLUSTER_PERIOD_MS);
            return;
        }

        if (rows.length != 1) {
            log('Missing user, user_id=' + run.user_id);
            set_check_cluster_timeout(CHECK_CLUSTER_PERIOD_MS);
            return;
        }

        var username = rows[0].user_name;
        var wants_notification = rows[0].receive_email_notifications;

        var REMOTE_FOLDER = 'autograder/' + run.run_id;
        var REMOTE_PROFILER = REMOTE_FOLDER + '/profiler.txt';
        var REMOTE_TRACES = REMOTE_FOLDER + '/traces.txt';
        var REMOTE_DATARACE = REMOTE_FOLDER + '/datarace.txt';
        var REMOTE_STDOUT = REMOTE_FOLDER + '/stdout.txt';
        var REMOTE_STDERR = REMOTE_FOLDER + '/stderr.txt';
        var LOCAL_FOLDER = __dirname + '/submissions/' +
            username + '/' + run.run_id;
        var LOCAL_PROFILER = LOCAL_FOLDER + '/profiler.txt';
        var LOCAL_TRACES = LOCAL_FOLDER + '/traces.txt';
        var LOCAL_DATARACE = LOCAL_FOLDER + '/datarace.txt';
        var LOCAL_STDOUT = LOCAL_FOLDER + '/cluster-stdout.txt';
        var LOCAL_STDERR = LOCAL_FOLDER + '/cluster-stderr.txt';
        var LOCAL_SLURM = LOCAL_FOLDER + '/cello.slurm';

        get_cluster_os(function(err, os) {
            if (err) {
                return abort_and_reset_perf_tests(err, 'OS');
            }

            var copies = [{ src: REMOTE_STDOUT, dst: LOCAL_STDOUT },
                { src: REMOTE_STDERR, dst: LOCAL_STDERR }];
            if (run.enable_profiling) {
                copies.push({ src: REMOTE_TRACES, dst: LOCAL_TRACES });
            }
            // { src: REMOTE_PROFILER, dst: LOCAL_PROFILER },
            // if (os !== 'Darwin') {
            //   copies.push({ src: REMOTE_DATARACE, dst: LOCAL_DATARACE });
            // }

            var tests = get_scalability_tests(run.ncores);
            for (var i = 0; i < tests.length; i++) {
                var curr_cores = tests[i];
                var local = LOCAL_FOLDER + '/performance.' + curr_cores + '.txt';
                var remote = REMOTE_FOLDER + '/performance.' + curr_cores + '.txt';

                copies.push({ src: remote, dst: local });
            }

            batched_cluster_scp(copies, false, function(stat) {
                var any_missing_files = false;
                var any_infrastructure_failures = false;
                for (var i = 0; i < stat.length; i++) {
                    if (stat[i].success) {
                        log('finish_perf_tests: successfully copied back to ' + stat[i].dst);
                    } else {
                        if (string_ends_with(stat[i].err.toString().trim(), 'No such file or directory')) {
                            log('finish_perf_tests: failed copying ' + stat[i].dst + ' because it didn\'t exist on the cluster');
                            any_missing_files = true;
                        } else {
                            log('finish_perf_tests: scp err copying to ' + stat[i].dst + ', err=' +
                                stat[i].err);
                            any_infrastructure_failures = true;
                        }
                    }
                }
                log('finish_perf_tests: run=' + run.run_id +
                    ', any_missing_files? ' + any_missing_files +
                    ', any_infrastructure_failures? ' +
                    any_infrastructure_failures);

                if (any_infrastructure_failures) {
                    return abort_and_reset_perf_tests(err, 'cluster infrastructure');
                }

                var characteristic_speedup = "";
                if (!any_missing_files) {
                    var rubric_file = rubric_file_path(run.assignment_id);
                    var validated = load_and_validate_rubric(rubric_file);
                    if (validated.success) {
                        var rubric = validated.rubric;
                        var characteristic_test = rubric.performance.characteristic_test;
                        var performance_path = LOCAL_FOLDER + '/performance.' +
                            run.ncores + '.txt';
                        if (get_file_size(performance_path) < MAX_FILE_SIZE) {
                            var test_contents = fs.readFileSync(performance_path, 'utf8');
                            var test_lines = test_contents.split('\n');
                            for (var line_index in test_lines) {
                                if (string_starts_with(test_lines[line_index], PERF_TEST_LBL)) {
                                    var tokens = test_lines[line_index].split(' ');
                                    var testname = tokens[2];
                                    if (testname === characteristic_test) {
                                        var seq_time = parseInt(tokens[3]);
                                        var parallel_time = parseInt(tokens[4]);
                                        var speedup = seq_time / parallel_time;
                                        characteristic_speedup = speedup.toFixed(3);
                                        log('finish_perf_tests: run=' + run.run_id + ', setting characteristic speedup ' + characteristic_speedup);
                                        break;
                                    }
                                }
                            }
                        } else {
                            log('finish_perf_tests: ' + performance_path +
                                    ' is >= ' + MAX_FILE_SIZE + ' bytes');
                        }
                    }
                }

                pgquery("UPDATE runs SET status='" + run_status + "'," +
                        "finish_time=CURRENT_TIMESTAMP," +
                        "passed_performance=($1)," +
                        "characteristic_speedup=($2) WHERE run_id=($3)",
                        [!any_missing_files, characteristic_speedup, run.run_id],
                    function(err, rows) {
                        if (err) {
                            log('Error updating performance run state: ' + err);
                            set_check_cluster_timeout(CHECK_CLUSTER_PERIOD_MS);
                            return;
                        }

                        if (wants_notification) {
                            var email = username + '@rice.edu';
                            if (username === 'admin') {
                                email = 'jmg3@rice.edu';
                            }
                            var subject = 'Habanero AutoGrader Run ' + run.run_id + ' Finished';
                            send_email(email_for_user(username), subject, '', function(err) {
                                if (err) {
                                    return abort_and_reset_perf_tests(err,
                                        'sending notification email');
                                }
                                check_cluster_helper(perf_runs,
                                    current_perf_runs_index + 1);
                            });
                        } else {
                            check_cluster_helper(perf_runs,
                                current_perf_runs_index + 1);
                        }
                });
            });
        });
    });
}

function check_cluster_helper(perf_runs, i) {
    if (i >= perf_runs.length) {
        set_check_cluster_timeout(CHECK_CLUSTER_PERIOD_MS);
    } else {
        var run = perf_runs[i];
        log('check_cluster_helper: ' + (i + 1) + '/' +
                perf_runs.length + ' ' + JSON.stringify(run));

        if (CLUSTER_TYPE === 'slurm') {
            var SACCT = "sacct --noheader -j " + run.job_id + " -u " + CLUSTER_USER + " " +
                "--format=JobName,State | grep hab | awk '{ print $2 }'";
            run_cluster_cmd('checking job status', SACCT, function(err, stdout, stderr) {
                if (err) {
                  set_check_cluster_timeout(CHECK_CLUSTER_PERIOD_MS);
                  return;
                }
                stdout = stdout.trim();

                log('check_cluster_helper: got status "' + stdout +
                    '" back from cluster for job ' + run.job_id);

                var finished = false;
                var run_status = null;
                if (stdout === FAILED_STATUS || stdout === 'TIMEOUT') {
                    log('check_cluster_helper: marking ' + run.run_id + ' ' + FAILED_STATUS);
                    run_status = FAILED_STATUS;
                    finished = true;
                } else if (string_starts_with(stdout, CANCELLED_STATUS)) {
                    log('check_cluster_helper: marking ' + run.run_id + ' ' + CANCELLED_STATUS);
                    run_status = CANCELLED_STATUS;
                    finished = true;
                } else if (stdout === 'COMPLETED') {
                    log('check_cluster_helper: marking ' + run.run_id + ' ' + FINISHED_STATUS);
                    run_status = FINISHED_STATUS;
                    finished = true;
                } else if (stdout === 'RUNNING') {
                    log('check_cluster_helper: marking ' + run.run_id + ' as ' +
                            TESTING_PERFORMANCE_STATUS);
                    run_status = TESTING_PERFORMANCE_STATUS;
                }

                if (run_status) {
                    if (finished) {
                        finish_perf_tests(run_status, run, perf_runs, i);
                    } else {
                        pgquery("UPDATE runs SET status='" +
                                TESTING_PERFORMANCE_STATUS +
                                "' WHERE run_id=($1)", [run.run_id], function(err, rows) {
                                    if (err) {
                                        log('Error updating running perf tests: ' + err);
                                        set_check_cluster_timeout(CHECK_CLUSTER_PERIOD_MS);
                                        return;
                                    }
                                    check_cluster_helper(perf_runs, i + 1);
                                });
                    }
                } else {
                    check_cluster_helper(perf_runs, i + 1);
                }
            });
        } else {
            if (run.job_id !== LOCAL_JOB_ID) {
                log('Unexpected job_id "' + run.job_id + '" for local cluster');
                check_cluster_helper(perf_runs, i + 1);
            } else {
                log('check_cluster_helper: marking ' + run.run_id + ' ' +
                        FINISHED_STATUS);
                finish_perf_tests(FINISHED_STATUS, run, perf_runs, i);
            }
        }
    }
}

// Cluster functionality
function check_cluster() {
    if (checkClusterActive) {
        console.log('check_cluster: woke up and a cluster checker was already active?!');
    } else {
        checkClusterActive = true;
        pgquery("SELECT * FROM runs WHERE (job_id IS NOT " +
            "NULL) AND ((status='" + TESTING_PERFORMANCE_STATUS + "') OR " +
            "(status='IN CLUSTER QUEUE'))", [], function(err, rows) {
                if (err) {
                    log('Error looking up running perf tests: ' + err);
                    set_check_cluster_timeout(CHECK_CLUSTER_PERIOD_MS);
                    return;
                }

                var perf_runs = rows;
                var running_jobs_str = '[';
                for (var i = 0; i < perf_runs.length; i++) {
                    running_jobs_str = running_jobs_str + ' ' + perf_runs[i].run_id;
                }
                running_jobs_str = running_jobs_str + ' ]';
                log('check_cluster: found ' + perf_runs.length +
                    ' running jobs ' + running_jobs_str);
                check_cluster_helper(perf_runs, 0);
        });
    }
}

function abort_and_reset_cluster_file_checking(err) {
  if (err) log('abort_and_reset_cluster_file_checking: err=' + err);
  setTimeout(check_for_old_runs_on_cluster, CHECK_CLUSTER_FILES_PERIOD_MS);
}

function delete_old_folders(folder_index, folder_list) {
    if (folder_index >= folder_list.length) {
        return abort_and_reset_cluster_file_checking(null);
    }

    var folder = folder_list[folder_index];
    run_cluster_cmd('stat run dir', 'stat --format=%Y autograder/' + folder,
            function(err, stdout, stderr) {
                if (err) {
                    return abort_and_reset_cluster_file_checking(err);
                }
                var current_epoch_time = Math.floor((new Date()).getTime() / 1000);
                var folder_epoch = parseInt(stdout);
                if (current_epoch_time - folder_epoch >= CLUSTER_FOLDER_RETENTION_TIME_S) {
                    log('delete_old_folders: deleting old cluster dir autograder/' + folder);

                    run_cluster_cmd('delete old cluster dir',
                        'rm -r autograder/' + folder,
                        function(err, stdout, stderr) {
                            if (err) {
                                return abort_and_reset_cluster_file_checking(err);
                            }
                            delete_old_folders(folder_index + 1, folder_list);
                        });
                } else {
                    delete_old_folders(folder_index + 1, folder_list);
                }
            });
}

function check_for_old_runs_on_cluster() {
    log('check_for_old_runs_on_cluster: starting...');

    run_cluster_cmd('list run dirs', "ls -l autograder/",
        function(err, stdout, stderr) {
            if (err) {
                return abort_and_reset_cluster_file_checking(err);
            }
            var run_dirs = [];
            var lines = stdout.split('\n');
            for (var l = 1; l < lines.length; l++) {
                var line = lines[l];
                var tokens = line.split(' ');
                if (tokens.length == 9) {
                    run_dirs.push(tokens[8]);
                }
            }

            delete_old_folders(0, run_dirs);
        });
}

function launch() {
    set_check_cluster_timeout(0);
    setTimeout(check_for_old_runs_on_cluster, CHECK_CLUSTER_FILES_PERIOD_MS);

    var port = process.env.PORT || 8000;

    var oneDay = 86400000;
    app.use(express.static(__dirname + '/views', { maxAge: oneDay }));

    var server = app.listen(port, function() {
        log('Server listening at http://%s:%s', 
            server.address().address,
            server.address().port);
    });
}

/*
 * At one point, we conservatively marked all running jobs as failed on startup.
 * However, Viola has been refactored to continually retry conductor
 * notifications and the cluster job status can be checked at any time, so it
 * appears it is safe to pick up running jobs on reboot. We still allow this to
 * enabled by a CLI flag, but it is disabled by default.
 */

if (process.argv.length > 2 && process.argv[2] === 'kill-running-jobs') {
    /*
     * Mark any in-progress tests as failed on reboot.
     */
    pgquery("UPDATE runs SET status='" + FAILED_STATUS + "'," +
        "finish_time=CURRENT_TIMESTAMP WHERE status='" +
        TESTING_CORRECTNESS_STATUS + "' OR status='" +
        TESTING_PERFORMANCE_STATUS + "' OR status='" + IN_CLUSTER_QUEUE_STATUS +
        "'", [], function(err, rows) {
            if (err) {
                log('Error on initial cleanup, err=' + err);
                return process.exit(1);
            }
            launch();
    });
} else {
    launch();
}
