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
var child_process = require('child_process');
var nodemailer = require('nodemailer');
var url = require('url');
var moment = require('moment');
var archiver = require('archiver');
var temp = require('temp');
var os_package = require('os');
var path_pkg = require('path');
var score_module = require('./score');

var maintenanceMsg = 'Job submission failed because the autograder is not ' +
    'currently accepting new submissions. This is most likely due to a ' +
    'planned maintenance. Please wait 5-10 minutes and try re-submitting.';
var permissionDenied = 'Permission denied. But you should shoot me an e-mail ' +
    'at jmaxg3@gmail.com. If you like playing around with systems, we have ' +
    'interesting research for you in the Habanero group.';
var cancellationSuccessMsg = 'Successfully cancelled. Please give the job ' +
    'status a few minutes to update.';
var markDisabledRunMsg = "You are not permitted to change a run's final status if " +
    "the assignment it is associated with is disabled.";

var upload = multer({ dest: 'uploads/' });

var VERBOSE = false;

var LOCAL_JOB_ID = 'LOCAL';

// For pagination
var PAGE_SIZE = 50;

// Logging utility, includes a timestamp with the log message
function log(msg) {
    console.log(new Date().toLocaleString() + ' ' + msg);
}

// Check the environment for a given variable, and return it if present.
// Otherwise, exit with an error message.
function check_env(varname) {
  if (!(varname in process.env)) {
    log('The ' + varname + ' environment variable must be set');
    process.exit(1);
  }
  return process.env[varname];
}

var AUTOGRADER_HOME = check_env('AUTOGRADER_HOME');

var HOME = check_env('HOME');

var CLUSTER_HOME = null;
var CLUSTER_LIGHTWEIGHT_JAVA_PROFILER_HOME = null;
var CLUSTER_JUNIT_JAR = null;
var CLUSTER_HAMCREST_JAR = null;
var CLUSTER_ASM_JAR = null;
var CLUSTER_RR_AGENT_JAR = null;
var CLUSTER_RR_RUNTIME_JAR = null;

// A gmail account that can be used to send messages from the autograder to users.
var GMAIL_USER = check_env('GMAIL_USER');
var GMAIL_PASS = check_env('GMAIL_PASS');

// Used for sending e-mail messages
var transporter = nodemailer.createTransport({
  service: 'Gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS
  }
});

// Send an e-mail to the provided destination e-mail address with the provided
// subject and body. Call cb when this completes, passing an error code or null.
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

function send_mass_email(to, subject, body, cb) {
  log('send_mass_email: to=' + to + ' subject="' + subject + '"');

  var options = {
    from: 'Habanero AutoGrader <' + GMAIL_USER + '>',
    bcc: to,
    subject: subject,
    text: body
  };
  transporter.sendMail(options, function(err, info) {
    cb(err);
  });
}

function send_email_to_each_active_user(subject, body, cb) {
    get_all_active_users(function(rows, err) {
        if (err) {
            return cb(null, err);
        }

        var active_users = [];
        for (var i = 0; i < rows.length; i++) {
            active_users.push(email_for_user(rows[i].user_name));
        }

        send_mass_email(active_users, subject, body, function(err) {
            if (err) {
                return cb(err);
            } else {
                return cb(null);
            }
        });
    });
}

// Delete a directory, including all files and directories beneath it.
function rmdir_recursively(dir) {
    var list = fs.readdirSync(dir);
    for (var i = 0; i < list.length; i++) {
        var filename = path_pkg.join(dir, list[i]);
        var stat = fs.statSync(filename);

        if (filename == "." || filename == "..") {
        } else if (stat.isDirectory()) {
            rmdir_recursively(filename);
        } else {
            fs.unlinkSync(filename);
        }
    }
    fs.rmdirSync(dir);
};

// Account credentials to a shared SVN instance that users can upload submission
// to for the autograder to pull down. Alternatively, users can also choose to
// simply upload ZIP files of their submission.
var SVN_USERNAME = process.env.SVN_USER || 'jmg3';
var SVN_PASSWORD = process.env.SVN_PASSWORD || '';

// The location of the viola component, to be used to do lightweight correctness
// testing.
var VIOLA_HOST = process.env.VIOLA_HOST || 'localhost';
var VIOLA_PORT = parseInt(process.env.VIOLA_PORT || '8080');

log('Connecting to Viola at ' + VIOLA_HOST + ':' + VIOLA_PORT);

// Information on a SLURM-based compute cluster on which we run heavyweight
// performance tests. In the future, support should be extended to include other
// server infrastructures, such as EC2, GCE, etc.
var CLUSTER_HOSTNAME = process.env.CLUSTER_HOSTNAME || 'stic.rice.edu';
var CLUSTER_USER = process.env.CLUSTER_USER || 'jmg3';
var CLUSTER_PRIVATE_KEY_PASSPHRASE = process.env.CLUSTER_PRIVATE_KEY_PASSPHRASE || null;
var clusterPrivateKey = fs.readFileSync(HOME + '/.ssh/id_rsa');


// We support cluster types of 'slurm' and 'local'. However, 'local' clusters are
// purely for testing locally and should never be used in production, as they
// block on every performance test.
var CLUSTER_TYPE = process.env.CLUSTER_TYPE || 'slurm';
if (CLUSTER_TYPE !== 'slurm' && CLUSTER_TYPE !== 'local') {
  throw 'Unsupported cluster type ' + CLUSTER_TYPE;
}
var CHECK_CLUSTER_PERIOD_MS = 30 * 1000; // 30 seconds
var CHECK_CLUSTER_FILES_PERIOD_MS = 10 * 60 * 1000; // 10 minutes
var CLUSTER_FOLDER_RETENTION_TIME_MS = 1 * 60 * 60 * 1000; // 1 hour

log('Connecting to remote cluster at ' + CLUSTER_HOSTNAME +
  ' of type ' + CLUSTER_TYPE + ' as ' + CLUSTER_USER);

// A simpler pgquery that doesn't pass the error back to the user, simply
// redirects to the main page with a vague internal error message.
function pgquery_no_err(query, query_args, res, req, cb) {
    score_module.pgquery(query, query_args, function(err, rows) {
        if (err) {
            log('pgquery_no_err: hit an err = ' + err);
            return redirect_with_err('/overview', res, req,
                'Internal error (pgquery_no_err)');
        }
        cb(rows);
    });
}

// Connection information for the configured SVN instance
var svn_client = new svn({
        username: SVN_USERNAME,
        password: SVN_PASSWORD
    });

// Issue an SVN command to the configured SVN repo, using a callback to handle
// the results.
function svn_cmd(cmd, cb) {
    log('svn_cmd: ' + cmd.join(' '));
    return svn_client.cmd(cmd, cb);
}

var cluster_connection = null;
var cluster_sftp = null;

// Set up an sftp connection to the configured compute cluster, saving the
// connection in the global cluster_sftp variable so that it can be reused by
// multiple sftp commands. In the past, the autograder has experience issues
// with SSH throttling as clusters detect excessive connection requests from a
// single IP. To deal with this, we share SSH connections as much as possible.
function sftp_connect_to_cluster(cb) {
    log('sftp_connect_to_cluster: Connecting to cluster ' + CLUSTER_HOSTNAME);
    if (CLUSTER_TYPE === 'slurm') {
        cluster_connection.sftp(function(err, sftp) {
            if (err) {
                log('sftp_connect_to_cluster: Error sftp-ing to ' +
                    CLUSTER_HOSTNAME + ' as user ' + CLUSTER_USER + ': ' +
                    err);
                return sftp_connect_to_cluster(cb);
            }
            cluster_sftp = sftp;
            cb();
        });
    } else {
        cb();
    }
}

// Create an SSH connection to the configured cluster, doing the same connection
// caching as we do in sftp_connect_to_cluster. This should only be used from
// run_cluster_cmd or cluster_scp, and is not intended to be used from many
// places in the code.
function connect_to_cluster(cb) {
    log('connect_to_cluster: Connecting to cluster ' + CLUSTER_HOSTNAME +
            ' of type ' + CLUSTER_TYPE + ' as user ' + CLUSTER_USER);
    if (CLUSTER_TYPE === 'slurm') {
        log('connect_to_cluster: Setting up actual connection');
        var conn = new ssh.Client();
        conn.on('ready', function() {
            cluster_connection = conn;
            sftp_connect_to_cluster(cb);
        }).on('error', function(err) {
            log('connect_to_cluster: Error connecting to ' + CLUSTER_HOSTNAME +
                ' as user ' + CLUSTER_USER + ': ' + err);
            connect_to_cluster(cb);
        }).on('end', function() {
            log('connect_to_cluster: connection to ' + CLUSTER_HOSTNAME +
                ' emitted end event');
        }).on('timeout', function() {
            log('connect_to_cluster: connection to ' + CLUSTER_HOSTNAME +
                ' emitted timeout event');
        }).on('close', function() {
            log('connect_to_cluster: connection to ' + CLUSTER_HOSTNAME +
                ' emitted close event');
            clear_in_flight_cmds();
        }).connect({
            host: CLUSTER_HOSTNAME,
            port: 22,
            username: CLUSTER_USER,
            privateKey: clusterPrivateKey,
            passphrase: CLUSTER_PRIVATE_KEY_PASSPHRASE,
            readyTimeout: 60000
        });
    } else {
        // local
        cb();
    }
}

// Keep track of all in-flight SSH commands. If our SSH connection to the
// cluster is cut, this list is used to ensure no commands/callbacks are left
// handing indefinitely (even if they fail, we need to ensure this failure is
// reported up the chain).
var in_flight_cmds = {};

// Called when our connection to the cluster is ended. For each command still
// in in_flight_cmds, we call its callback indicating that an error has
// occurred. The callback is expected to handle this error gracefully.
function clear_in_flight_cmds() {
    var save = in_flight_cmds;
    in_flight_cmds = {};

    var tokens = [];
    for (token in save) {
        log('clear_in_flight_cmds: found token "' + token + '"');
        tokens.push(token);
    }
    for (var t = 0; t < tokens.length; t++) {
        var token = tokens[t];
        var curr = save[token];
        log('clear_in_flight_cmds: marking command "' + curr.cmd +
            '" as failed, calling its handler');
        curr.handler('Failed due to SSH disconnect from cluster', null);
    }
}

// Run a given shell command on the remote compute cluster. lbl is used to
// uniquely identify the command issued for error and informational reporting.
// cluster_cmd is a string storing the command to issue. cb is called when the
// command completes, and may be passed an error code if the command fails.
function run_cluster_cmd(lbl, cluster_cmd, cb) {
    log('run_cluster_cmd[' + lbl + ']: ' + cluster_cmd);

    if (CLUSTER_TYPE === 'slurm') {
        crypto.randomBytes(48, function(ex, buf) {
            var token = buf.toString('hex');
            var save_in_flight_cmds = in_flight_cmds;

            var handler = function(err, stream) {
                if (!(token in save_in_flight_cmds)) {
                    // We seem to have gotten called twice, so avoid calling callback twice
                    log('run_cluster_cmd: cmd "' + cluster_cmd + '" returned ' +
                        'but did not find its token in the list of in-flight ' +
                        'commands, aborting');
                    return;
                }
                log('run_cluster_cmd: cmd "' + cluster_cmd + '" returned.');

                if (err) {
                    log('[' + lbl + '] err=' + err);
                    delete save_in_flight_cmds[token];
                    return cb(lbl, null, null);
                }

                var acc_stdout = '';
                var acc_stderr = '';
                stream.on('close', function(code, signal) {
                    if (code !== 0) {
                        log('[' + lbl + '] code=' + code + ' signal=' + signal);
                        delete save_in_flight_cmds[token];
                        return cb(lbl, acc_stdout, acc_stderr);
                    } else {
                        if (VERBOSE) {
                            log('[' + lbl + '] code=' + code + ' signal=' + signal);
                            log('[' + lbl + '] stdout=' + acc_stdout);
                            log('[' + lbl + '] stderr=' + acc_stderr);
                        }
                        delete save_in_flight_cmds[token];
                        return cb(null, acc_stdout, acc_stderr);
                    }
                }).on('exit', function(exitCode) {
                    log('run_cluster_cmd: exit event from cmd "' +
                        cluster_cmd + '", exitCode=' + exitCode);
                }).on('data', function(data) {
                    acc_stdout = acc_stdout + data;
                }).stderr.on('data', function(data) {
                    acc_stderr = acc_stderr + data;
                });
            };

            log('run_cluster_cmd: storing "' + cluster_cmd + '" in in-flight ' +
                    'commands using token "' + token + '"');
            in_flight_cmds[token] = {cmd: cluster_cmd, handler: handler};

            try {
                cluster_connection.exec(cluster_cmd, handler);
            } catch (err) {
                log('run_cluster_cmd: caught error from existing connection (' +
                        err + ') during execution of "' + cluster_cmd + '"');
                if (cluster_connection !== null) {
                    cluster_connection.end();
                }
                cluster_connection = null;
                cluster_sftp = null;
                delete in_flight_cmds[token];

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

// Copy from src_file to dst_file. is_upload specifies the direction of the
// transfer. If is_upload is true, then the copy is to the cluster. Else, it is
// from the cluster. On completion, cb is called with a single error argument.
// Only supports individual files, assumes parent directories are already
// created.
function cluster_copy(src_file, dst_file, is_upload, cb) {
  if (is_upload) {
    if (dst_file.trim().search('/') === 0) {
      throw 'All remote directories should be relative, but got ' + dst_file;
    }
    log('cluster_copy: transferring ' + src_file + ' on local machine to ' + dst_file + ' on cluster');
  } else {
    if (src_file.trim().search('/') === 0) {
      throw 'All remote directories should be relative, but got ' + src_file;
    }
    log('cluster_copy: transferring ' + src_file + ' on cluster to ' + dst_file + ' on local machine');
  }

  if (CLUSTER_TYPE === 'slurm') {
      var start_time = new Date().getTime();

      try {
          if (is_upload) {
              cluster_sftp.fastPut(src_file, dst_file, function(err) {
                  log('cluster_copy: upload from ' + src_file + ' took ' +
                      (new Date().getTime() - start_time) + ' ms, err=' + err);
                  cb(err);
              });
          } else {
              cluster_sftp.fastGet(src_file, dst_file, function(err) {
                  log('cluster_copy: download to ' + dst_file + ' took ' +
                      (new Date().getTime() - start_time) + ' ms, err=' + err);
                  cb(err);
              });
          }
      } catch (err) {
          log('cluster_copy: caught error from existing connection: ' + err);
          cluster_connection.end();
          cluster_connection = null;
          cluster_sftp = null;
          connect_to_cluster(function() {
              cluster_copy(src_file, dst_file, is_upload, cb);
          });
      }
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

// A helper for issuing multiple copies in a batch. This handles a single copy
// in the last, and recurses to handle the next. The success/failure of each
// copy is aggregated in the stat list.
function batched_cluster_copy_helper(pair_index, file_pairs, is_upload, stat, cb) {
  if (pair_index >= file_pairs.length) {
    return cb(stat);
  }

  cluster_copy(file_pairs[pair_index].src, file_pairs[pair_index].dst, is_upload,
      function(err) {
        if (err) {
          stat.push({dst: file_pairs[pair_index].dst, success: false, err: err});
        } else {
          stat.push({dst: file_pairs[pair_index].dst, success: true});
        }
        return batched_cluster_copy_helper(pair_index + 1, file_pairs, is_upload, stat, cb);
      });
}

// Perform multiple copies in a single call, where file_pairs specifies the
// pairs of source and destination files and is_upload specifies the direction
// of these copies.
function batched_cluster_copy(file_pairs, is_upload, cb) {
  var stat = [];
  return batched_cluster_copy_helper(0, file_pairs, is_upload, stat, cb);
}

// Create a directory on the cluster, including any missing parent directories.
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

// Get the value of an environment variable on the cluster.
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

// Helper for batched fetching of environment variables from the cluster. This
// function handles a single variable in the list, and then recurses on the rest
// of the list.
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

// Fetch the values for multiple environment variables at once from the cluster.
function batched_get_cluster_env_var(varnames, cb) {
  return batched_get_cluster_env_var_helper(0, varnames, {}, cb);
}

// Check the cluster operating system using the uname command.
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

// Utility for checking if a string starts with the specified prefix.
function string_starts_with(st, prefix) {
  return st.slice(0, prefix.length) === prefix;
}

// Utility for checking if a string ends with the specified suffix.
function string_ends_with(st, suffix) {
    return st.indexOf(suffix, st.length - suffix.length) !== -1;
}

// Utility function for rendering a specific page that checks for success and
// error messages in the session and sets the appropriate render variables, such
// that these messages will appear on the rendered page.
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

// Redirect to the specified page with an error message at the top of the page.
function redirect_with_err(target, res, req, err_msg) {
    log('redirect_with_err: target=' + target + ' err_msg=' + err_msg);
    req.session.err_msg = err_msg;
    return res.redirect(target);
}

// Redirect to the specified page with a success message displayed.
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

// Fetch a status for the specified run ID. This API is insecure (i.e. users can
// query run statuses for runs that are not their own).
app.get('/status/:run_id', function(req, res, next) {
    var run_id = req.params.run_id;
    log('status: run_id=' + run_id);

    // Deliberately don't check permissions, it's okay to leave this endpoint
    // in the open.
    score_module.pgquery("SELECT * FROM runs WHERE run_id=($1)", [run_id], function(err, rows) {
        if (err) {
            return res.send('INTERNAL FAILURE');
        }
        if (rows.length != 1) {
            return res.send('UNKNOWN RUN');
        }
        return res.send(rows[0].status);
    });
});

// Look up the most recently completed run for which all runs with a run ID less
// than it have also completed.
app.get('/latest_complete_run', function(req, res, next) {
    score_module.pgquery('SELECT MAX(run_id) FROM runs', [], function(err, rows) {
        if (err) {
            return res.send('INTERNAL FAILURE');
        }
        var max_run_id = rows[0].max;

        score_module.pgquery("SELECT MIN(run_id) FROM runs WHERE status='" +
                score_module.TESTING_CORRECTNESS_STATUS + "' OR status='" +
                score_module.IN_CLUSTER_QUEUE_STATUS + "' OR status='" +
                score_module.TESTING_PERFORMANCE_STATUS + "'", [], function(err, rows) {
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

// Render the log in page.
app.get('/login', function(req, res, next) {
    return render_page('login.html', res, req);
});

// Check user credentials and start a session for them if they are correct.
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

// Terminate this user's session.
app.get('/logout', function(req, res, next) {
  log('logout: username=' + req.session.username);

  req.session.username = null;
  req.session.user_id = null;
  req.session.is_admin = false;

  return res.redirect('/login');
});

// For all paths below this set up information on the user's name and
// permissions for later endpoints to use.
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

// Display the user's profile page, where they can change their e-mail
// notification settings and view run statistics for their account.
app.get('/profile', function(req, res, next) {
  var username = req.session.username;
  log('profile: username=' + username);

  pgquery_no_err('SELECT * FROM users WHERE user_name=($1)', [username], res,
      req, function(rows) {
          if (rows.length != 1) {
            return redirect_with_err('/overview', res, req,
                'User "' + username + '" does not exist');
          } else {
            var user_obj = rows[0];
            var user_id = user_obj.user_id;
            var has_notifications_enabled = user_obj.receive_email_notifications;

            pgquery_no_err('SELECT COUNT(*) FROM runs WHERE user_id=($1)',
                [user_id], res, req, function(rows) {

                    get_all_assignments(function(assignments, err) {
                        if (err) {
                            return redirect_with_err('/overview', res, req, "Error fetching assignments");
                        }

                        get_all_final_runs(res, req, assignments, function(final_runs) {

                            var final_runs_info =
                                compute_remaining_slip_days_for(user_obj,
                                    final_runs, assignments);
                            var remaining_slip_days = final_runs_info.remaining_slip_days;
                            var final_runs = final_runs_info.collected_final_runs;

                            var render_vars = {username: req.session.username,
                                               nruns: rows[0].count,
                                               remaining_slip_days: remaining_slip_days,
                                               final_runs: final_runs,
                                               notifications_enabled: has_notifications_enabled};
                            return render_page('profile.html', res, req, render_vars);
                        });
                    });
                });
          }
      });
});

// Change a user's e-mail notification settings
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

// Render a user's overview page.
app.get('/overview/:page?', function(req, res, next) {
  var page_str = req.params.page;
  if (!page_str) page_str = '0';

  log('overview: user=' + req.session.username + ' page=' + page_str);

  // Validate the page being loaded
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

  // Fetch all runs for this user, to be displayed on the overview page.
  get_runs_for_username(req.session.username, function(runs, err) {
      if (err) {
          return render_page('overview.html', res, req,
              {err_msg: 'Error gathering runs', runs: [], assignments: [],
                  page: 0, npages: 1});
      }

      // Fetch all visible assignments this user can submit for, for displaying
      // on the overview page alongside the upload dialogue.
      get_visible_assignments(function(assignments, err) {
          if (err) {
              return render_page('overview.html', res, req,
                  {err_msg: 'Error gathering assignments', runs: [],
                      assignments: [], page: 0, npages: 1});
          }

          get_all_final_runs_for_user(req.session.user_id, res, req,
              assignments, function(final_runs) {

              var npages = Math.max(Math.ceil(runs.length / PAGE_SIZE), 1);
              // npages will be 0 when there are no runs for this user
              if (npages > 0 && page >= npages) {
                  return render_page('overview.html', res, req,
                      {err_msg: 'Invalid URL, ' + page + ' is >= the # of pages, ' + npages,
                          runs: [], page: 0, npages: 1});
              }

              // Generate a subset of runs to display based on the overview page
              // being loaded.
              var subsetted_runs = [];
              var limit = (page + 1) * PAGE_SIZE;
              if (limit > runs.length) limit = runs.length;
              for (var i = page * PAGE_SIZE; i < limit; i++) {
                  var is_final = false;
                  for (var j = 0; j < final_runs.length; j++) {
                      if (runs[i].run_id === final_runs[j].run_id) {
                          is_final = true;
                          break;
                      }
                  }
                  runs[i].is_final = is_final;
                  subsetted_runs.push(runs[i]);
              }
              return render_page('overview.html', res, req,
                  {runs: subsetted_runs,
                   page: page,
                   npages: npages,
                   assignments: assignments,
                   });
          });
      });
  });
});

// Render the leaderboard for the specified assignment, paginated.
app.get('/leaderboard/:assignment_id?/:page?', function(req, res, next) {
  var target_assignment_id = req.params.assignment_id;
  var page = req.params.page;
  log('leaderboard: username=' + req.session.username +
      ' target_assignment_id=' + target_assignment_id + ' page=' + page);

  // Get the metadata for the selected assignment
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

                // Find all runs for the selected assignment, for display in the leaderboard.
                pgquery_no_err("SELECT run_id,status,passed_checkstyle,compiled," +
                    "passed_all_correctness,passed_performance," +
                    "characteristic_speedup,user_id,job_id,correctness_only," +
                    "enable_profiling FROM runs WHERE assignment_id=($1) ORDER BY run_id DESC",
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
                                    if (rows.length == 0) {
                                        return redirect_with_err('/overview', res, req,
                                            'No assignment with that assignment ID');
                                    }

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

// Render the comments page, where users  can leave anonymous comments on the
// autograder.
app.get('/comments', function(req, res, next) {
  return render_page('comments.html', res, req);
});

// Render the user guide page for the autograder.
app.get('/user_guide', function(req, res, next) {
  log('user_guide: ' + req.session.username);
  return render_page('user_guide.html', res, req);
});

// Render the FAQ page for the autograder.
app.get('/faq', function(req, res, next) {
  log('faq: ' + req.session.username);
  return render_page('faq.html', res, req);
});

// Post a comment made by the user, by sending an e-mail to a hard-coded e-mail
// address.
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

// Render the admin page, only accessible to admin users.
app.get('/admin', function(req, res, next) {
  if (req.session.is_admin) {
    get_all_assignments(function(assignments, err) {
        if (err) {
            return redirect_with_err('/overview', res, req, "Error fetching assignments");
        }

        get_all_users(function(users, err) {
            if (err) {
                return redirect_with_err('/overview', res, req, "Error fetching users");
            }

            get_all_final_runs(res, req, assignments, function(final_runs) {
                for (var i = 0; i < users.length; i++) {
                    var curr_user = users[i];
                    /*
                     * For each assignment, determine if this user has selected a
                     * final run for this assignment. If they have, determine the
                     * delta between the deadline for that assignment and the
                     * timestamp on that final run selection. Use this to calculate
                     * slip day usage.
                     */
                    curr_user.remaining_slip_days =
                        compute_remaining_slip_days_for(curr_user, final_runs,
                            assignments).remaining_slip_days;
                }

                var render_vars = {assignments: assignments, users: users};
                return render_page('admin.html', res, req, render_vars);
            });
        });
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
// Upload a new assignment, consisting of an assignment name, a ZIP file
// containing instructor tests, a POM file for compilation, a rubric, and a
// checkstyle XML file.
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

    var assignment_deadline = req.body.assignment_deadline;
    if (assignment_deadline.length === 0) {
      return redirect_with_err('/admin', res, req,
          'Please provide a non-empty assignment deadline');
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

    var rubric_validated = score_module.load_and_validate_rubric(req.files.rubric[0].path);
    if (!rubric_validated.success) {
        return redirect_with_err('/admin', res, req,
                'Error in rubric: ' + rubric_validated.msg);
    }

    var pom_validated = validate_instructor_pom(req.files.instructor_pom[0].path);
    if (!pom_validated.success) {
        return redirect_with_err('/admin', res, req, 'Error in POM: ' + pom_validated.msg);
    }

    pgquery_no_err("INSERT INTO assignments (name, visible, deadline) VALUES " +
            "($1,false,to_timestamp($2, 'MM/DD,YYYY hh24:mi:ss')) " +
            "RETURNING assignment_id", [assignment_name, assignment_deadline],
            res, req, function(rows) {
                var assignment_id = rows[0].assignment_id;
                var assignment_dir = score_module.assignment_path(assignment_id);

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

                    batched_cluster_copy(remote_copies, true, function(stat) {
                        for (var i = 0; i < stat.length; i++) {
                            if (!stat[i].success) {
                                return redirect_with_err('/admin', res, req,
                                    'Unable to upload to cluster');
                            }
                        }

                        return update_assignment_jars(assignment_id, function(err, hj_jar, pom_jars) {
                            if (err) {
                                return redirect_with_err('/admin', res, req,
                                    'Error updating assignment JARs: ' + err);
                            } else {
                                return redirect_with_success('/admin', res, req,
                                    'Uploaded assignment');
                            }
                        });
                    });
                });

            });
  }
});

// Handle a re-upload of one of the files that make up an assignment
// configuration. This includes both updating the file locally and remotely on
// the cluster.
function handle_reupload(req, res, missing_msg, target_filename, success_cb) {
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
                var assignment_dir = score_module.assignment_path(assignment_id);
                fs.renameSync(req.file.path, assignment_dir + '/' + target_filename);

                cluster_copy(assignment_dir + '/' + target_filename,
                    'autograder-assignments/' + assignment_id + '/' + target_filename, true,
                    function(err) {
                    if (err) {
                        return redirect_with_err('/admin', res, req,
                            'Unable to upload to cluster');
                    }

                    if (success_cb !== null) {
                        return success_cb(function(err) {
                            if (err) {
                                return redirect_with_err('/admin', res, req, err);
                            } else {
                                return redirect_with_success('/admin', res, req,
                                    'Updated ' + target_filename + ' for assignment ' +
                                    rows[0].name);
                            }
                        });
                    } else {
                        return redirect_with_success('/admin', res, req,
                            'Updated ' + target_filename + ' for assignment ' +
                            rows[0].name);
                    }
                });
            });
  }
}

// Update some metadata for an assignment.
function update_user_field(val, column_name, user_id, res, req) {
    pgquery_no_err("SELECT * FROM users WHERE user_id=($1)", [user_id], res,
            req, function(rows) {
                if (rows.length != 1) {
                  return redirect_with_err('/admin', res, req,
                    'That user doesn\'t seem to exist');
                }
                pgquery_no_err("UPDATE users SET " + column_name + "=" +
                    val + " WHERE user_id=($1)", [user_id], res,
                    req, function(rows) {
                        return redirect_with_success('/admin', res, req,
                            'Updated ' + column_name + ' to ' + val);
                    });
            });
}

app.post('/update_slip_days/:user_id', function(req, res, next) {
  log('update_slip_days: is_admin=' + req.session.is_admin + ', slip_days=' +
      req.body.slip_days);
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    if (req.body.slip_days === null) {
      return redirect_with_err('/admin', res, req, 'Malformed request, missing slip days field?');
    }
    var user_id = req.params.user_id;
    var slip_days = req.body.slip_days;

    return update_user_field(slip_days, 'allowed_slip_days', user_id, res, req);
  }
});

// Update some metadata for an assignment.
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

// Update the arguments passed to the JVM when testing a user submission for a
// given assignment.
app.post('/update_jvm_args/:assignment_id', function(req, res, next) {
  log('update_jvm_args: is_admin=' + req.session.is_admin + ', jvm_args=' + req.body.jvm_args);
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    if (req.body.jvm_args === null) {
      return redirect_with_err('/admin', res, req, 'Malformed request, missing JVM args field?');
    }
    var assignment_id = req.params.assignment_id;
    var jvm_args = req.body.jvm_args;

    return update_assignment_field("'" + jvm_args + "'", 'jvm_args', assignment_id, res, req);
  }
});

// Update the deadline for an assignment
app.post('/update_deadline/:assignment_id', function(req, res, next) {
  log('update_deadline: is_admin=' + req.session.is_admin + ', jvm_args=' + req.body.deadline);
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    if (req.body.deadline === null) {
      return redirect_with_err('/admin', res, req, 'Malformed request, missing deadline field?');
    }
    var assignment_id = req.params.assignment_id;
    var deadline = req.body.deadline;

    return update_assignment_field("'" + deadline + "'", 'deadline', assignment_id, res, req);
  }
});

// Update the timeout allowed for the correctness tests for a given assignment.
app.post('/update_correctness_timeout/:assignment_id', function(req, res, next) {
  log('update_correctness_timeout: is_admin=' + req.session.is_admin +
      ', new timeout=' + req.body.correctness_timeout);
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    if (req.body.correctness_timeout === null) {
      return redirect_with_err('/admin', res, req,
          'Malformed request, missing correctness timeout field?');
    }
    var assignment_id = req.params.assignment_id;
    var correctness_timeout = req.body.correctness_timeout;

    return update_assignment_field(correctness_timeout, 'correctness_timeout_ms',
        assignment_id, res, req);
  }
});

// Add some custom SLURM flags to be used when running performance tests for a
// given assignment.
app.post('/update_custom_slurm_flags/:assignment_id', function(req, res, next) {
    log('update_custom_slurm_flags: is_admin=' + req.session.is_admin +
        ', new slurm flags = "' + req.body.custom_slurm_flags + '"');
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    if (req.body.custom_slurm_flags === null) {
      return redirect_with_err('/admin', res, req,
          'Malformed request, missing custom slurm flags field?');
    }
    var assignment_id = req.params.assignment_id;
    var custom_slurm_flags = req.body.custom_slurm_flags;

    return update_assignment_field("'" + custom_slurm_flags + "'", 'custom_slurm_flags',
        assignment_id, res, req);
  }
});

// Add some custom assignment-specific files that are required.
app.post('/update_required_files/:assignment_id', function(req, res, next) {
    log('update_required_files: is_admin=' + req.session.is_admin +
        ', new required files = "' + req.body.required_files + '"');
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    if (req.body.required_files === null) {
      return redirect_with_err('/admin', res, req,
          'Malformed request, missing required files field?');
    }
    var assignment_id = req.params.assignment_id;
    var required_files = req.body.required_files;

    return update_assignment_field("'" + required_files + "'", 'required_files',
        assignment_id, res, req);
  }
});

// Update the timeout allowed for the performance tests for a given assignment.
app.post('/update_performance_timeout/:assignment_id', function(req, res, next) {
  log('update_performance_timeout: is_admin=' + req.session.is_admin +
      ', new timeout=' + req.body.performance_timeout);
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    if (req.body.performance_timeout === null) {
      return redirect_with_err('/admin', res, req,
          'Malformed request, missing performance timeout field?');
    }
    var assignment_id = req.params.assignment_id;
    var performance_timeout = req.body.performance_timeout;

    return update_assignment_field("'" + performance_timeout + "'", 'performance_timeout_str',
        assignment_id, res, req);
  }
});

// Update the list of the number of cores per node to test a given submission
// with.
app.post('/update_ncores/:assignment_id', function(req, res, next) {
  log('update_ncores: is_admin=' + req.session.is_admin +
      ', new # cores=' + req.body.ncores);
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    if (req.body.ncores === null) {
      return redirect_with_err('/admin', res, req,
          'Malformed request, missing ncores field?');
    }
    var assignment_id = req.params.assignment_id;
    var ncores = req.body.ncores;

    var tokens = ncores.split(',');
    for (var t = 0; t < tokens.length; t++) {
        if (isNaN(tokens[t])) {
            return redirect_with_err('/admin', res, req,
                'Invalid format for ncores, must be comma separated integers');
        }
    }

    return update_assignment_field("'" + ncores + "'", 'ncores', assignment_id, res, req);
  }
});

// Update the list of number of nodes to test a given submission with.
app.post('/update_n_nodes/:assignment_id', function(req, res, next) {
  log('update_n_nodes: is_admin=' + req.session.is_admin +
      ', new # nodes=' + req.body.n_nodes);
  if (!req.session.is_admin) {
    return redirect_with_err('/overview', res, req, permissionDenied);
  } else {
    if (req.body.n_nodes === null) {
      return redirect_with_err('/admin', res, req,
          'Malformed request, missing n_nodes field?');
    }
    var assignment_id = req.params.assignment_id;
    var n_nodes = req.body.n_nodes;

    var tokens = n_nodes.split(',');
    for (var t = 0; t < tokens.length; t++) {
        if (isNaN(tokens[t])) {
            return redirect_with_err('/admin', res, req,
                'Invalid format for n_nodes, must be comma separated integers');
        }
    }

    if (CLUSTER_TYPE === 'local') {
        if (tokens.length !== 1 || parseInt(tokens[0]) !== 1) {
            return redirect_with_err('/admin', res, req,
                    'Only single node assignments permitted for local ' +
                    'cluster configurations');
        }
    }

    return update_assignment_field("'" + n_nodes + "'", 'n_nodes',
            assignment_id, res, req);
  }
});

// Re-upload the ZIP file containing instructor tests for a given assignment.
app.post('/upload_zip/:assignment_id', upload.single('zip'),
    function(req, res, next) {
      log('upload_zip: is_admin=' + req.session.is_admin);
      return handle_reupload(req, res, 'Please provide a ZIP', 'instructor.zip',
          null);
    });

function update_assignment_jars(assignment_id, cb) {
    var dependency_list_cmd = 'mvn -f ' +
      '~/autograder-assignments/' + assignment_id +
      '/instructor_pom.xml -DoutputAbsoluteArtifactFilename=true ' +
      'dependency:list';

    run_cluster_cmd('get dependencies', dependency_list_cmd,
      function(err, stdout, stderr) {
        if (err) {
          return cb(err, null, null);
        }

        var dependency_lines = stdout.split('\n');
        var dependency_lines_index = 0;
        while (dependency_lines_index < dependency_lines.length &&
            dependency_lines[dependency_lines_index] !== '[INFO] The following files have been resolved:') {
          dependency_lines_index += 1;
        }
        var pom_jars = '';
        var hj = '';
        while (dependency_lines_index < dependency_lines.length &&
            dependency_lines[dependency_lines_index] !== '[INFO] ') {
          var curr = dependency_lines[dependency_lines_index];
          var components = curr.split(':');
          var path = components[5];

          pom_jars += ':' + path;

          if (components[1] == 'hjlib-cooperative') {
            hj = path;
          }
          dependency_lines_index += 1;
        }

        score_module.pgquery("UPDATE assignments SET hj_jar='" + hj +
                "',pom_jars='" + pom_jars + "' WHERE assignment_id=" +
                assignment_id, [], function(err, rows) {
                    if (err) {
                        return cb(err, null, null);
                    }

                    cb(null, hj, pom_jars);
        });
      });
}

// Re-upload the instructor POM file for a given assignment.
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

      if (!req.session.is_admin) {
        return redirect_with_err('/overview', res, req, permissionDenied);
      } else {
          var assignment_id = req.params.assignment_id;

          return handle_reupload(req, res, 'Please provide an instructor pom.xml',
            'instructor_pom.xml', function(cb) {
                return update_assignment_jars(assignment_id, function(err, hj_jar, pom_jars) {
                    return cb(err);
                });
            });
      }
    });

// Re-upload the grading rubric for a given assignment.
app.post('/upload_rubric/:assignment_id', upload.single('rubric'),
    function(req, res, next) {
      log('upload_rubric: is_admin=' + req.session.is_admin);

      if (!req.file) {
          return redirect_with_err('/admin', res, req, 'No rubric provided');
      }

      var validated = score_module.load_and_validate_rubric(req.file.path);
      if (!validated.success) {
          return redirect_with_err('/admin', res, req, 'Error in rubric: ' + validated.msg);
      }

      return handle_reupload(req, res, 'Please provide a rubric', 'rubric.json',
          null);
    });

// Update the checkstyle file used for a given assignment.
app.post('/upload_checkstyle/:assignment_id', upload.single('checkstyle_config'),
    function(req, res, next) {
      log('upload_checkstyle: is_admin=' + req.session.is_admin);

      return handle_reupload(req, res, 'Please provide a checkstyle file',
          'checkstyle.xml', null);
    });

// Toggle whether an assignment's tests should only ever run correctness tests.
// By default, this is false.
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

// Toggle whether an assignment should cost a student slip days.
app.post('/set_assignment_costs_slip_days/:assignment_id', function(req, res, next) {
  log('set_assignment_costs_slip_days: is_admin=' + req.session.is_admin);
  if (!req.session.is_admin) {
      return redirect_with_err('/overview', res, req, permissionDenied);
  }

  var assignment_id = req.params.assignment_id;
  var set_costs_slip_days = req.body.set_costs_slip_days;

  return update_assignment_field(set_costs_slip_days, 'costs_slip_days',
      assignment_id, res, req);
});

// Toggle whether a reminder email should be sent out for the given assignment.
app.post('/set_send_reminder_emails/:assignment_id', function(req, res, next) {
  log('set_send_reminder_emails: is_admin=' + req.session.is_admin);
  if (!req.session.is_admin) {
      return redirect_with_err('/overview', res, req, permissionDenied);
  }

  var assignment_id = req.params.assignment_id;
  var set_send_reminder_emails = req.body.set_send_reminder_emails;

  return update_assignment_field(set_send_reminder_emails,
      'send_reminder_emails', assignment_id, res, req);
});

// Toggle whether a given assignment is visible to users.
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

// Update the user-specified tag for a given run. Tags are provided as a way for
// users to keep notes on each experiment they run, so that they can recall what
// they were testing with each run.
app.post('/update_tag/:run_id', function(req, res, next) {
    var run_id = req.params.run_id;
    var tag = req.body.tag;

    log('update_tag: run_id=' + run_id + ', tag="' + tag + '"');

    pgquery_no_err('SELECT * FROM runs WHERE run_id=($1)', [run_id], res, req, function(rows) {
        if (rows.length != 1) {
            return redirect_with_err('/overview', res, req, 'Invalid run');
        }

        // Permission check
        if (rows[0].user_id !== req.session.user_id) {
            return res.sendStatus(401);
        }

        pgquery_no_err("UPDATE runs SET tag=($1) WHERE run_id=($2)", [tag, run_id], res, req, function(rows) {
            return redirect_with_success('/run/' + run_id, res, req, 'Updated tag');
        });
    });
});

// Fetch the user ID for a given username.
function get_user_id_for_name(username, cb) {
    score_module.pgquery("SELECT * FROM users WHERE user_name=($1)", [username], function(err, rows) {
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

// Launch the correctness tests for a user submission on the viola component.
function trigger_viola_run(run_dir, assignment_name, run_id, done_token,
        assignment_id, jvm_args, correctness_timeout, username, required_files) {
    var viola_params = 'done_token=' + done_token + '&user=' + username +
        '&assignment=' + assignment_name + '&run=' + run_id +
        '&assignment_id=' + assignment_id + '&jvm_args=' + jvm_args +
        '&timeout=' + correctness_timeout + '&submission_path=' +
        run_dir_path(username, run_id) + '&assignment_path=' +
        score_module.assignment_path(assignment_id) + '&required_files=' + required_files;
    var viola_options = { host: VIOLA_HOST,
        port: VIOLA_PORT, path: '/run?' + encodeURI(viola_params) };
    log('submit_run: sending viola request for run ' + run_id);

    // Send viola the metadata for this run so that it can handle the
    // correctness testing for us.
    http.get(viola_options, function(viola_res) {
        var bodyChunks = [];
        viola_res.on('data', function(chunk) {
            bodyChunks.push(chunk);
        });
        viola_res.on('end', function() {
            var body = Buffer.concat(bodyChunks);
            var result = JSON.parse(body);
            if (result.status === 'Success') {
                return;
            } else {
                return viola_trigger_failed(run_id, 'Viola error: ' + result.msg, null);
            }
        });
    }).on('error', function(err) {
        log('VIOLA err="' + err + '"');
        return viola_trigger_failed(run_id,
            'An error occurred launching the local tests', null);
    });
}

// Called when triggering correctness tests on the Viola component fail. Mostly,
// we signal here that the run has failed.
function viola_trigger_failed(run_id, err_msg, svn_err) {
    log('viola_trigger_failed: run_id=' + run_id + ' err_msg="' + err_msg +
            '" err="' + svn_err + '"');
    score_module.pgquery("UPDATE runs SET status='" + score_module.FAILED_STATUS + "'," +
            "finish_time=CURRENT_TIMESTAMP,viola_msg=($2) WHERE run_id=($1)",
            [run_id, err_msg], function(err, rows) {
                if (err) {
                    log('Error storing failure setting up tests for run_id=' +
                        run_id + ': ' + err);
                } else {
                    log('Failure initiating tests for run_id=' + run_id + ': ' +
                        err_msg);
                }
            });
}

// Called if some error occurs during run configuration, and simply marks that
// run as failed.
function run_setup_failed(run_id, res, req, err_msg, svn_err) {
    log('run_setup_failed: run_id=' + run_id + ' err_msg="' + err_msg +
            '" err="' + svn_err + '"');
    score_module.pgquery("UPDATE runs SET status='" + score_module.FAILED_STATUS + "'," +
            "finish_time=CURRENT_TIMESTAMP,viola_msg=($2) WHERE run_id=($1)",
            [run_id, err_msg], function(err, rows) {
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

// Given the URL to a student's SVN directory, export that directory into a ZIP
// file and kick off a viola run using it.
function kick_off_svn_export(svn_url, temp_dir, run_id, run_dir,
        assignment_name, done_token, assignment_id, jvm_args,
        correctness_timeout, username, required_files) {
    svn_cmd(['export', svn_url, temp_dir + '/submission_svn_folder'], function(err, stdout) {
      if (is_actual_svn_err(err)) {
          return viola_trigger_failed(run_id,
              'An error occurred exporting from "' + svn_url + '"', err);
      }

      svn_cmd(['log', svn_url, '-l', '1'], function(err, stdout) {
          if (is_actual_svn_err(err)) {
              return viola_trigger_failed(run_id,
                  'An error occurred getting the log messages from SVN', err);
          }

          var stdout_lines = stdout.trim().match(/[^\r\n]+/g);
          // ignore the 1st, 2nd, 3rd, and last lines
          var tag = 'revision ' + stdout_lines[1].split(' ')[0] + ': ';
          for (var i = 2; i < stdout_lines.length - 1; i++) {
              tag = tag + stdout_lines[i] + ' ';
          }
          tag = tag.trim();

          score_module.pgquery('UPDATE runs SET tag=($1) WHERE run_id=($2)', [tag, run_id],
              function(err, rows) {
                  if (err) {
                      return viola_trigger_failed(run_id,
                          'An error occurred setting the run tag', err);
                  }

                  var output = fs.createWriteStream(run_dir + '/student.zip');
                  var archive = archiver('zip');
                  output.on('close', function() {
                    rmdir_recursively(temp_dir);

                    return trigger_viola_run(run_dir,
                        assignment_name, run_id, done_token,
                        assignment_id, jvm_args, correctness_timeout, username, required_files);
                  });
                  archive.on('error', function(err){
                      return viola_trigger_failed(run_id,
                          'An error occurred zipping your submission.', err);
                  });
                  archive.pipe(output);
                  archive.bulk([{expand: true, cwd: temp_dir, src: ["**/*"], dot: true }
                        ]);
                  archive.finalize();
              });
      });
    });
}

// Main logic for handing a user submission.
function submit_run(user_id, username, assignment_name, correctness_only,
        enable_profiling, use_zip, svn_url, res, req, success_cb) {

    // Check that this assignment exists.
    pgquery_no_err("SELECT * FROM assignments WHERE name=($1)",
            [assignment_name], res, req, function(rows) {
      if (rows.length === 0) {
        return redirect_with_err('/overview', res, req,
          'Assignment ' + assignment_name + ' does not seem to exist');
      } else if (rows.length > 1) {
        return redirect_with_err('/overview', res, req,
          'There appear to be duplicate assignments ' + assignment_name);
      } else {

        var assignment_id = rows[0].assignment_id;
        var jvm_args = rows[0].jvm_args;
        var required_files = rows[0].required_files;
        var correctness_timeout = rows[0].correctness_timeout_ms;
        log('submit_run: found assignment_id=' + assignment_id +
            ' jvm_args="' + jvm_args + '" correctness_timeout=' +
            correctness_timeout + ' for user_id=' + user_id);

        // Allow assignment settings to override user-provided setting
        var assignment_correctness_only = rows[0].correctness_only;
        if (assignment_correctness_only) correctness_only = true;

        // Generate a unique and long token for identifying this submission.
        // This is passed back to us by the viola component when the correctness
        // tests complete.
        crypto.randomBytes(48, function(ex, buf) {
            log('submit_run: got random bytes');
            var done_token = buf.toString('hex');

            // Add the submission metadata to the runs table.
            pgquery_no_err("INSERT INTO runs (user_id,assignment_id," +
                "done_token,status,correctness_only,enable_profiling) " +
                "VALUES ($1,$2,$3,'" + score_module.TESTING_CORRECTNESS_STATUS +
                "',$4,$5) RETURNING run_id", [user_id, assignment_id,
                done_token, correctness_only, enable_profiling], res, req,
                function(rows) {
              var run_id = rows[0].run_id;
              log('submit_run: got run_id=' + run_id +
                  ' for user_id=' + user_id + ' on assignment_id=' +
                  assignment_id);
              var run_dir = run_dir_path(username, run_id);

              // Create run directory to store information on this run
              var mkdir_msg = '"mkdir ' + username + ' ' + assignment_name + ' ' + run_id + '"';
              fs.mkdirSync(run_dir);

              if (use_zip) {
                // Trigger viola run using the uploaded ZIP file
                fs.renameSync(req.file.path, run_dir + '/student.zip');
                trigger_viola_run(run_dir,
                    assignment_name, run_id, done_token,
                    assignment_id, jvm_args, correctness_timeout, username, required_files);
                return success_cb(run_id);
              } else {
                // Create a ZIP file from the user-provided SVN location, and
                // then trigger a viola run using it.
                temp.mkdir('conductor', function(err, temp_dir) {
                  if (err) {
                      return run_setup_failed(run_id, res, req,
                          'Internal error creating temporary directory', err);
                  }

                  kick_off_svn_export(svn_url, temp_dir, run_id, run_dir,
                      assignment_name, done_token, assignment_id, jvm_args,
                      correctness_timeout, username, required_files);

                  return success_cb(run_id);
                });
              }
            });
        });
      }
    });
}

// This API is normally disabled, but it allows us to submit runs on behalf of
// any user. Paired with the scripts in habanero-autograder/submit_run_as, this
// capability allows the creation of runs that can be used to give user feedback
// to the entire class on their submitted code (and check that their submitted
// code is performing as they expect). The run is performed using a given user
// (usually the 'admin' user) but is visible by someone else as well.
app.post('/submit_run_as', function(req, res, next) {
    log('submit_run_as: enabled? ' + (fs.existsSync(__dirname + '/enable_run_as')));
    if (!fs.existsSync(__dirname + '/enable_run_as')) {
        return res.send('submit_run_as not enabled');
    }

    var required_fields = ['username', 'for_username', 'svn_url',
        'assignment_name', 'correctness_only'];
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
    var correctness_only = req.query.correctness_only;
    log('submit_run_as: username="' + username + '" for_username="' +
        for_username + '" svn_url="' + svn_url + '" assignment_name="' +
        assignment_name + '" correctness_only="' + correctness_only + '"');

    get_user_id_for_name(username, function(user_id, err) {
        if (err) {
            return res.send('Failed getting user ID for "' + username + '"');
        }
        get_user_id_for_name(for_username, function(for_user_id, err) {
            if (err) {
                return res.send('Failed getting user ID for "' + for_username + '"');
            }
            return submit_run(user_id, username, assignment_name,
                (correctness_only === 'true'), false, false, svn_url, res, req,
                function(run_id) {
                    score_module.pgquery("UPDATE runs SET on_behalf_of=($1) WHERE " +
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

// Main endpoint for user-submitted runs, which mostly checks inputs and then
// hands control to submit_run().
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

    var svn_url = req.body.svn_url.trim();
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

// Get the working directory on the compute cluster for a given run.
function get_cello_work_dir(home_dir, run_id) {
  return home_dir + "/autograder/" + run_id;
}

// Emit some code that runs the provided command for each performance test.
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

// Return a string representing the contents of the SLURM file we generate to
// pass to a SLURM-based cluster for executing all performance tests (as well as
// some performance profiling tests, if enabled). ncores should be an array of
// integers specifying the scalability tests we would like to run.
function get_slurm_file_contents(run_id, home_dir, username, assignment_id,
    assignment_name, java_profiler_dir, ncores, junit_jar, hamcrest_jar, hj_jar,
    asm_jar, rr_agent_jar, rr_runtime_jar, assignment_jvm_args, timeout_str,
    enable_profiling, custom_slurm_flags, n_nodes, pom_jars) {
  var max_n_cores = score_module.max(ncores);
  var max_n_nodes = score_module.max(n_nodes);

  var slurmFileContents =
    "#!/bin/bash\n" +
    "\n" +
    "#SBATCH --job-name=habanero-autograder-" + run_id + "\n" +
    "#SBATCH --nodes=" + max_n_nodes + "\n" +
    "#SBATCH --ntasks-per-node=1\n" +
    "#SBATCH --cpus-per-task=" + max_n_cores + "\n" +
    "#SBATCH --mem=16000m\n" +
    "#SBATCH --time=" + timeout_str + "\n" +
    "#SBATCH --export=ALL\n" +
    "#SBATCH --exclusive\n" +
    "#SBATCH --partition=commons\n" +
    "#SBATCH --output=" + home_dir + "/autograder/" + run_id + "/stdout.txt\n" +
    "#SBATCH --error=" + home_dir + "/autograder/" + run_id + "/stderr.txt\n\n";
  // "#SBATCH --account=scavenge\n" +
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
  slurmFileContents += "echo CELLO_WORK_DIR=$CELLO_WORK_DIR\n";
  slurmFileContents += "echo SLURM_NODELIST=$SLURM_NODELIST\n\n";

  slurmFileContents += 'function cleanup() {\n';
  slurmFileContents += '    echo Cleaning up\n';
  slurmFileContents += '    rm -f /tmp/performance.' + run_id + '.* /tmp/profiler.' + run_id + '*\n';
  slurmFileContents += '}\n';
  slurmFileContents += 'trap cleanup SIGHUP SIGINT SIGTERM EXIT\n\n';

  slurmFileContents += 'mkdir $CELLO_WORK_DIR/submission/student\n';
  slurmFileContents += 'unzip -qq $CELLO_WORK_DIR/submission/student.zip -d $CELLO_WORK_DIR/submission/student/\n';
  // Clean up several files for disk space
  slurmFileContents += 'for SVN_DIR in $(find $CELLO_WORK_DIR/submission/student -name ".svn"); do\n';
  slurmFileContents += '    rm -f -r $SVN_DIR\n';
  slurmFileContents += 'done\n';
  slurmFileContents += 'rm -f -r $CELLO_WORK_DIR/submission/student/__MACOSX\n';
  slurmFileContents += 'rm -f $CELLO_WORK_DIR/submission/student.zip\n';
  slurmFileContents += 'NSTUDENT_FILES=$(ls -l $CELLO_WORK_DIR/submission/student/ | grep -v total | wc -l)\n';
  slurmFileContents += 'NSTUDENT_FILES=${NSTUDENT_FILES//[[:blank:]]/}\n';
  slurmFileContents += 'if [[ $NSTUDENT_FILES != 1 ]]; then\n';
  slurmFileContents += '    echo "AUTOGRADER-ERROR Unexpected number of student files: $NSTUDENT_FILES"\n';
  slurmFileContents += '    exit 1\n';
  slurmFileContents += 'fi\n';
  slurmFileContents += 'STUDENT_DIR=$(ls $CELLO_WORK_DIR/submission/student/)\n';

  slurmFileContents += 'mkdir -p $CELLO_WORK_DIR/assignment/instructor\n';
  slurmFileContents += 'unzip -qq ~/autograder-assignments/' + assignment_id + '/instructor.zip -d $CELLO_WORK_DIR/assignment/instructor/\n';
  slurmFileContents += 'NINSTRUCTOR_FILES=$(ls -l $CELLO_WORK_DIR/assignment/instructor/ | grep -v total | wc -l);\n';
  slurmFileContents += 'NINSTRUCTOR_FILES=${NINSTRUCTOR_FILES//[[:blank:]]/}\n';
  slurmFileContents += 'if [[ $NINSTRUCTOR_FILES != 1 ]]; then\n';
  slurmFileContents += '    echo "AUTOGRADER-ERROR Unexpected number of instructor files: $NINSTRUCTOR_FILES"\n';
  slurmFileContents += '    exit 1\n';
  slurmFileContents += 'fi\n';
  slurmFileContents += 'INSTRUCTOR_DIR=$(ls $CELLO_WORK_DIR/assignment/instructor/)\n';

  slurmFileContents += 'mkdir -p "$CELLO_WORK_DIR/submission/student/$STUDENT_DIR/src/test"\n';
  slurmFileContents += 'cp -r $CELLO_WORK_DIR/assignment/instructor/$INSTRUCTOR_DIR/src/test/* "$CELLO_WORK_DIR/submission/student/$STUDENT_DIR/src/test/"\n';
  slurmFileContents += 'cp ~/autograder-assignments/' + assignment_id +
    '/instructor_pom.xml "$CELLO_WORK_DIR/submission/student/$STUDENT_DIR/pom.xml"\n';
  slurmFileContents += 'rm -r "$CELLO_WORK_DIR/assignment"\n';

  slurmFileContents += 'find "$CELLO_WORK_DIR/submission/student/$STUDENT_DIR/" -name "*CorrectnessTest.java" | while read F; do\n';
  slurmFileContents += '    rm "$F"\n';
  slurmFileContents += 'done\n';
  slurmFileContents += '\n';
  slurmFileContents += 'mvn -Dcheckstyle.skip=true -f "$CELLO_WORK_DIR/submission/student/$STUDENT_DIR/pom.xml" clean compile test-compile\n';
  slurmFileContents += 'cd "$CELLO_WORK_DIR/submission/student/$STUDENT_DIR"\n';

  var remotePolicyPath = '$CELLO_WORK_DIR/security.policy';
  var securityFlags = '-Djava.security.manager -Djava.security.policy==' + remotePolicyPath;
  var classpath = ['.', 'target/classes', 'target/test-classes', junit_jar,
                   hamcrest_jar, asm_jar];
  if (hj_jar.length > 0) {
      classpath.push(hj_jar);
  }

  if (!enable_profiling) {
    // Loop over scalability tests
    for (var n = 0; n < n_nodes.length; n++) {
      var curr_n_nodes = n_nodes[n];

      for (var t = 0; t < ncores.length; t++) {
        var curr_cores = ncores[t];
        var output_file = '/tmp/performance.' + run_id + '.' + curr_cores + '.txt';
        var final_output_file = '$CELLO_WORK_DIR/performance.' + curr_cores + '.txt';

        // Limit the number of cores this test can use
        var cpu_list = '0';
        for (var c = 1; c < curr_cores; c++) {
            cpu_list += ',' + c;
        }

        slurmFileContents += 'touch ' + output_file + '\n';
        slurmFileContents += 'touch ' + final_output_file + '\n';
        var launch_cmd = '';
        if (CLUSTER_TYPE === 'slurm') {
            launch_cmd = 'srun --nodes=' + curr_n_nodes + ' --ntasks=' +
                curr_n_nodes + ' --distribution=cyclic --tasks-per-node=1 ' +
                'taskset --cpu-list ' + cpu_list + ' ';
        }
        slurmFileContents += loop_over_all_perf_tests(launch_cmd + 'java ' +
            securityFlags + ' -Dautograder.nranks=' +
            curr_n_nodes + ' -Dautograder.ncores=' +
            curr_cores + ' -Dhj.numWorkers=' + curr_cores +
            ' ' + assignment_jvm_args +
            ((hj_jar.length > 0) ? (' -javaagent:' + hj_jar) : ' ') + ' -cp ' + classpath.join(':') + pom_jars + ' ' +
            'org.junit.runner.JUnitCore $CLASSNAME >> ' + output_file + ' 2>&1');
        slurmFileContents += 'NBYTES=$(cat ' + output_file + ' | wc -c)\n';
        slurmFileContents += 'if [[ "$NBYTES" -gt "' + score_module.MAX_FILE_SIZE + '" ]]; then\n';
        slurmFileContents += '    echo "' + score_module.excessiveFileSizeMsg + '" > ' + final_output_file + '\n';
        slurmFileContents += '    echo "" >> ' + final_output_file + '\n';
        slurmFileContents += '    truncate --size ' + score_module.MAX_FILE_SIZE + ' ' + output_file + '\n';
        slurmFileContents += 'fi\n';
        slurmFileContents += 'cat ' + output_file + ' >> ' + final_output_file + '\n';
        slurmFileContents += 'rm -f "' + output_file + '"\n';
      }
    }
    slurmFileContents += '\n';
  } else { // enable_profiling
      var profiler_output = '/tmp/profiler.' + run_id + '.txt';
      slurmFileContents += 'touch ' + profiler_output + '\n';
      slurmFileContents += loop_over_all_perf_tests(
        'java ' + securityFlags + ' -Dhj.numWorkers=' + max_n_cores +
        ' ' + assignment_jvm_args +
        ' -agentpath:' + java_profiler_dir + '/liblagent.so ' +
        ((hj_jar.length > 0) ? ('-javaagent:' + hj_jar) : '') + ' -cp ' + classpath.join(':') + pom_jars + ' ' +
        'org.junit.runner.JUnitCore $CLASSNAME >> ' + profiler_output + ' 2>&1 ; ' +
        'echo ===== Profiling test $CLASSNAME ===== >> $CELLO_WORK_DIR/traces.txt; ' +
        'cat "$CELLO_WORK_DIR/submission/student/$STUDENT_DIR/traces.txt" >> ' +
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

  return slurmFileContents;
}

// Called when launching the performance tests on the cluster fails, marks the
// current submission as failed.
function failed_starting_perf_tests(res, failure_msg, run_id) {
  score_module.pgquery(
      "UPDATE runs SET status='" + score_module.FAILED_STATUS + "',finish_time=CURRENT_TIMESTAMP," +
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

// Get an e-mail address for a given username. This is currently hard-coded for
// Rice University.
function email_for_user(username) {
  var email = username + '@rice.edu';
  if (username === 'admin') {
    email = 'jmg3@rice.edu';
  }
  return email;
}

// Count the number of new line characters in the provided string.
function count_new_lines(content) {
  var count = 0;
  for (var i = 0; i < content.length; i++) {
    if (content.charAt(i) == 10) count++;
  }
  return count;
}

function launch_on_cluster(run_id, username, assignment_id, assignment_name,
        ncores, hj, assignment_jvm_args, timeout_str, enable_profiling,
        custom_slurm_flags_list, n_nodes, pom_jars, viola_err_msg, ncores_str, res, req) {
    var run_dir = run_dir_path(username, run_id);
    var localPolicyPath = AUTOGRADER_HOME + '/shared/security.policy';

    // Generate a SLURM file for executing the performance tests.
    fs.appendFileSync(run_dir + '/cello.slurm',
      get_slurm_file_contents(run_id, CLUSTER_HOME,
        username, assignment_id, assignment_name,
        CLUSTER_LIGHTWEIGHT_JAVA_PROFILER_HOME,
        ncores, CLUSTER_JUNIT_JAR,
        CLUSTER_HAMCREST_JAR, hj,
        CLUSTER_ASM_JAR, CLUSTER_RR_AGENT_JAR,
        CLUSTER_RR_RUNTIME_JAR,
        assignment_jvm_args, timeout_str, enable_profiling,
        custom_slurm_flags_list, n_nodes, pom_jars));

    log('local_run_finished: Generated SLURM ' +
            'file for run ' + run_id);

    var copies = [{src: run_dir + '/cello.slurm',
                   dst: 'autograder/' + run_id + '/cello.slurm'},
                  {src: localPolicyPath,
                   dst: 'autograder/' + run_id + '/security.policy'}];
    batched_cluster_copy(copies, true, function(stat) {
        for (var i = 0; i < stat.length; i++) {
          if (!stat[i].success) {
            log('err copying to ' + stat[i].dst + ' from ' + stat[i].src + ', ' + stat[i].err);
            return failed_starting_perf_tests(res,
              'Failed copying cello.slurm+security.policy', run_id);
          }
        }

        log('local_run_finished: Transferred ' +
            'SLURM and policy files to ' +
            'cluster for run ' + run_id);

        if (CLUSTER_TYPE === 'slurm') {
            // Submit the performance tests to the cluster
            run_cluster_cmd('sbatch',
                'sbatch ~/autograder/' + run_id + '/cello.slurm',
                function(err, stdout, stderr) {
                    if (err) {
                      return failed_starting_perf_tests(res,
                        'Failed submitting job', run_id);
                    }

                    log('local_run_finished: Launched run ' + run_id + ' on the cluster');

                    // stdout == Submitted batch job 474297
                    if (stdout.search('Submitted batch job ') !== 0) {
                        return failed_starting_perf_tests(res,
                                'Failed submitting batch job', run_id);
                    }

                    var tokens = stdout.trim().split(' ');
                    var job_id = tokens[tokens.length - 1];
                    pgquery_no_err("UPDATE runs SET job_id=($1),status='" +
                        score_module.IN_CLUSTER_QUEUE_STATUS + "',viola_msg=$2," +
                        "ncores=$3 WHERE run_id=($4)",
                        [job_id, viola_err_msg, ncores_str, run_id],
                        res, req, function(rows) {
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

                pgquery_no_err('UPDATE runs SET job_id=($1) WHERE run_id=($2)',
                    [LOCAL_JOB_ID, run_id], res, req, function(rows) {
                        return res.send(
                            JSON.stringify({ status: 'Success' }));
                    });
              });
        }
    });
}

// This endpoint is hit by the viola component when the correctness tests for a
// given run completes. It passes back the token created for this run to
// uniquely identify the completed submission.
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
      } else if (rows[0].status !== score_module.TESTING_CORRECTNESS_STATUS) {
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
                  score_module.get_file_size(checkstyle_txt) < score_module.MAX_DISPLAY_FILE_SIZE) {
                // Checkstyle passed?
                var checkstyle_contents = fs.readFileSync(checkstyle_txt, 'utf8');
                var checkstyle_new_lines = count_new_lines(checkstyle_contents);
                checkstyle_passed = (checkstyle_new_lines === 0);
                if (checkstyle_passed && fs.existsSync(compile_txt) &&
                    score_module.get_file_size(compile_txt) < score_module.MAX_DISPLAY_FILE_SIZE) {
                  // Successfully compiled?
                  var compile_contents = fs.readFileSync(compile_txt, 'utf8');
                  compile_passed = (compile_contents.indexOf('BUILD SUCCESS') != -1);
                  if (compile_passed && fs.existsSync(correct_txt) &&
                          score_module.get_file_size(correct_txt) < score_module.MAX_DISPLAY_FILE_SIZE) {
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
                    var any_nonempty_stderr_lines = score_module.check_for_empty_stderr(lines);
                    correctness_tests_passed = !any_failures && !any_nonempty_stderr_lines;
                  }
                }
            }

            pgquery_no_err('UPDATE runs SET passed_checkstyle=($1),' +
                'compiled=($2),passed_all_correctness=($3) WHERE run_id=($4)',
                [checkstyle_passed, compile_passed, correctness_tests_passed,
                run_id], res, req, function(rows) {
              var run_status = score_module.FINISHED_STATUS;
              if (viola_err_msg === 'Cancelled by user') {
                  run_status = score_module.CANCELLED_STATUS;
              }

              if (correctness_only || run_status === score_module.CANCELLED_STATUS) {
                  // If only the correctness tests should be run, send an
                  // immediate e-mail notification.
                  pgquery_no_err("UPDATE runs SET status='" + run_status +
                      "',viola_msg=$1,finish_time=CURRENT_TIMESTAMP WHERE run_id=($2)",
                      [viola_err_msg, run_id], res, req, function(rows) {
                      if (wants_notification) {
                        var subject = 'Habanero AutoGrader Run ' + run_id + ' Finished';
                        var body = 'http://' + os_package.hostname() + '/run/' + run_id;
                        send_email(email_for_user(username), subject, body, function(err) {
                          /*
                           * Notification emails can fail for a number of
                           * reasons, none of them related to student code.
                           * Forcing the whole job to fail as a result is a bit
                           * too harsh. Here we just log the error and return
                           * success.
                           */
                          log('Failed sending notification e-mail for run ' +
                              run_id + ', err=' + err);
                          return res.send(
                            JSON.stringify({ status: 'Success' }));
                        });
                      } else {
                        return res.send(
                          JSON.stringify({ status: 'Success' }));
                      }
                  });
              } else {
                  // Otherwise trigger the performance tests on the cluster.
                  pgquery_no_err(
                    "SELECT * FROM assignments WHERE assignment_id=($1)",
                    [assignment_id], res, req, function(rows) {
                    var assignment_name = rows[0].name; 
                    var assignment_jvm_args = rows[0].jvm_args;
                    var timeout_str = rows[0].performance_timeout_str;
                    var ncores_str = rows[0].ncores;
                    var ncores = score_module.parse_comma_separated_ints(ncores_str);
                    var n_nodes_str = rows[0].n_nodes;
                    var n_nodes = score_module.parse_comma_separated_ints(n_nodes_str);
                    var custom_slurm_flags_str = rows[0].custom_slurm_flags;
                    var custom_slurm_flags_list =
                      custom_slurm_flags_str.split('|');

                    log('local_run_finished: Connecting to ' +
                        CLUSTER_USER + '@' + CLUSTER_HOSTNAME);

                     var cello_work_dir = get_cello_work_dir(CLUSTER_HOME, run_id);
                     var dependency_list_cmd = 'mvn -f ' +
                       '~/autograder-assignments/' + assignment_id +
                       '/instructor_pom.xml -DoutputAbsoluteArtifactFilename=true ' +
                       'dependency:list';

                     // Create a working directory for these performance tests
                     create_cluster_dir('autograder/' + run_id + '/submission',
                         function(err, stdout, stderr) {
                           if (err) {
                             return failed_starting_perf_tests(res,
                               'Failed creating autograder dir', run_id);
                           }

                           log('local_run_finished: Created cluster directory for run ' + run_id);

                           cluster_copy(run_dir_path(username, run_id) +
                               '/student.zip', 'autograder/' + run_id +
                               '/submission/student.zip', true, function(err) {
                               if (err) {
                                 return failed_starting_perf_tests(res,
                                      'Failed checking out student code', run_id);
                               }

                               log('local_run_finished: Transferred student ' +
                                   'submission to cluster for run ' + run_id);

                               var hj = rows[0].hj_jar;
                               var pom_jars = rows[0].pom_jars;

                               if (hj === null) {
                                   /*
                                    * The JARs for this assignment haven't been
                                    * filled in yet, must have been uploaded
                                    * prior to caching them for each assignment.
                                    */
                                   return update_assignment_jars(assignment_id,
                                       function(err, hj, pom_jars) {
                                           return launch_on_cluster(run_id,
                                               username, assignment_id,
                                               assignment_name, ncores, hj,
                                               assignment_jvm_args, timeout_str,
                                               enable_profiling,
                                               custom_slurm_flags_list, n_nodes,
                                               pom_jars, viola_err_msg,
                                               ncores_str, res, req);
                                   });
                               } else {
                                   return launch_on_cluster(run_id,
                                           username, assignment_id,
                                           assignment_name, ncores, hj,
                                           assignment_jvm_args, timeout_str,
                                           enable_profiling,
                                           custom_slurm_flags_list, n_nodes,
                                           pom_jars, viola_err_msg,
                                           ncores_str, res, req);
                               }
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

// Get a list of all assignments. This is used for displaying the admin view.
function get_all_assignments(cb) {
    score_module.pgquery("SELECT * FROM assignments ORDER BY assignment_id ASC", [], function(err, rows) {
        if (err) {
            cb(null, err);
        } else {
            cb(rows, null);
        }
    });
}

// Get a list of all users. This is used for displaying the admin view.
function get_all_users(cb) {
    score_module.pgquery("SELECT * FROM users ORDER BY user_id DESC", [], function(err, rows) {
        if (err) {
            cb(null, err);
        } else {
            cb(rows, null);
        }
    });
}

// Get a list of all active users. This is used for displaying the admin view.
function get_all_active_users(cb) {
    score_module.pgquery("SELECT * FROM users WHERE active=TRUE ORDER BY user_id DESC", [], function(err, rows) {
        if (err) {
            cb(null, err);
        } else {
            cb(rows, null);
        }
    });
}

// Get a list of all assignments visible to users.
function get_visible_assignments(cb) {
    score_module.pgquery("SELECT * FROM assignments WHERE visible=true", [], function(err, rows) {
        if (err) {
            cb(null, err);
        } else {
            cb(rows, null);
        }
    });
}

// Get a list of runs for a given username. The metadata returned for each run
// includes its run ID, assignment name, status, and completion time.
function get_runs_for_username(username, cb) {
    score_module.pgquery("SELECT * FROM users WHERE user_name=($1)", [username], function(err, rows) {
        if (err) return cb(null, err);
        var user_id = rows[0].user_id;

        score_module.pgquery("SELECT * FROM runs WHERE user_id=($1) ORDER BY run_id DESC",
              [user_id], function(err, rows) {
                  if (err) return cb(null, err);

                  var runs = rows;

                  score_module.pgquery("SELECT * FROM assignments", [], function(err, rows) {
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


// Check that the provided POM file has certain required properties set.
function validate_instructor_pom(pom_file) {
  var xml = fs.readFileSync(pom_file, 'utf8');
  var hjlib_version_tag = '<hjlib.version>';
  var found = xml.search(hjlib_version_tag);
  if (found === -1) {
    return score_module.failed_validation('The provided instructor POM does not seem to ' +
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
    return score_module.failed_validation('The provided instructor POM does not seem to ' +
        'contain a valid hjlib.version property, expected a version number ' +
        'separated with two periods');
  }
  
  return { success: true, version: version_str };
}

// Local run directory
function run_dir_path(username, run_id) {
    return __dirname + '/submissions/' + username + '/' + run_id;
}

// Update the submission to be marked as final
app.post('/mark_final/:run_id', function(req, res, next) {
    var run_id = req.params.run_id;

    log('mark_final: run_id=' + run_id);

    pgquery_no_err('SELECT * FROM runs WHERE run_id=($1)', [run_id], res, req,
    function(rows) {
        if (rows.length != 1) {
            // checking if primary key is valid
            return redirect_with_err('/overview', res, req, 'Invalid run');
        }

        // Permission check (only mark final on runs that are ours)
        if (rows[0].user_id !== req.session.user_id) {
            return res.sendStatus(401);
        }

        var username = req.session.username;
        var run_dir = run_dir_path(username, run_id);
        var loaded = score_module.load_log_files(run_dir);
        var log_files = loaded.log_files;

        if (!('files.txt' in log_files)) {
            return redirect_with_err('/run/' + run_id, res, req,
                'Cannot mark run final before it has completed correctness ' +
                'tests.');
        }

        pgquery_no_err('SELECT * FROM assignments WHERE assignment_id=($1)',
                [rows[0].assignment_id], res, req, function(assignment_rows) {
           if (assignment_rows.length != 1) {
               return redirect_with_err('/overview', res, req, 'Invalid assignment');
           }

           if (!assignment_rows[0].visible) {
               return redirect_with_err('/run/' + run_id, res, req,
                   markDisabledRunMsg);
           }

           var files_contents = log_files['files.txt'].contents;

           if (files_contents.trim() !== 'All required files were found!') {
               return redirect_with_err('/run/' + run_id, res, req,
                   'Cannot mark final, there are missing required files. ' +
                   'See the Required Files Report on this run page.');
           }

           // Insert the final submission into the final_runs table
           pgquery_no_err("INSERT INTO final_runs (run_id, user_id, " +
               "assignment_id, timestamp) VALUES ($1, $2, $3, $4)",
               [run_id, rows[0].user_id, rows[0].assignment_id, rows[0].start_time], res, req,
           function(rows) {
              return redirect_with_success('/run/' + run_id, res, req,
                  'Marked run as final');
          });
       });
    });
});

app.post('/unmark_final/:assignment_id', function(req, res, next) {
    var assignment_id = req.params.assignment_id;

    log('unmark_final: assignment_id=' + assignment_id);

    pgquery_no_err('SELECT * FROM assignments WHERE assignment_id=($1)',
            [assignment_id], res, req, function(assignment_rows) {
       if (assignment_rows.length != 1) {
           return redirect_with_err('/overview', res, req, 'Invalid assignment');
       }

       if (!assignment_rows[0].visible) {
           return redirect_with_err('/overview', res, req,
               markDisabledRunMsg);
       }

       pgquery_no_err('DELETE FROM final_runs WHERE user_id=$1 AND assignment_id=$2',
           [req.session.user_id, assignment_id], res, req, function(rows) {
              return redirect_with_success('/overview', res, req,
                  'Unmarked final run');
       });
   });
});

function get_final_run_for(user_id, assignment_id, cb, res, req) {
    // Select the latest final run from this user from this assignment
    pgquery_no_err('SELECT * FROM final_runs WHERE user_id=($1) AND ' +
            'assignment_id=($2) ORDER BY final_run_id DESC LIMIT 1',
            [user_id, assignment_id], res, req, function(rows) {
      if (rows.length != 1) {
          return cb(null);
      }
      // Make sure that the run ID is the run ID that they actually want
      return cb(rows[0].run_id);
    });
}

function get_all_final_runs_helper(rows_iter, rows, res, req, assignments, cb) {
    if (rows_iter === rows.length) {
        return cb(rows);
    } else {
        var final_run_id = rows[rows_iter].max;
        pgquery_no_err('SELECT * FROM final_runs WHERE final_run_id=$1',
                [final_run_id], res, req, function(single_row) {
            if (single_row.length !== 1) {
                return redirect_with_err('/overview', res, req,
                    "Failed collecting final runs, rows_iter=" + rows_iter +
                    ", final_run_id=" + final_run_id);
            }

            var assignment_name = null;
            for (var i = 0; i < assignments.length && assignment_name === null; i++) {
                if (assignments[i].assignment_id === rows[rows_iter].assignment_id) {
                    assignment_name = assignments[i].name;
                }
            }

            rows[rows_iter].final_run_id = final_run_id;
            rows[rows_iter].timestamp = single_row[0].timestamp;
            rows[rows_iter].run_id = single_row[0].run_id;
            rows[rows_iter].assignment_name = assignment_name;
            return get_all_final_runs_helper(rows_iter + 1, rows, res, req,
                assignments, cb);
        });
    }
}

function get_all_final_runs(res, req, assignments, cb) {
    pgquery_no_err('SELECT max(final_run_id), assignment_id, user_id from ' +
            'final_runs group by assignment_id, user_id', [], res, req,
            function(rows) {
        return get_all_final_runs_helper(0, rows, res, req, assignments, cb);
    });
}

function get_all_final_runs_for_user(user_id, res, req, assignments, cb) {
    pgquery_no_err('SELECT max(final_run_id), assignment_id from ' +
            'final_runs WHERE user_id=$1 group by assignment_id', [user_id], res, req,
            function(rows) {
        return get_all_final_runs_helper(0, rows, res, req, assignments, cb);
    });
}

function compute_remaining_slip_days_for(user_obj, final_runs, assignments) {
    var remaining_slip_days = user_obj.allowed_slip_days;
    var collect_final_runs = [];

    for (var j = 0; j < assignments.length; j++) {
        var curr_assignment = assignments[j];

        var final_run_timestamp = null;
        for (var k = 0; k < final_runs.length; k++) {
            if (final_runs[k].user_id === user_obj.user_id &&
                    final_runs[k].assignment_id === curr_assignment.assignment_id) {
                final_run_timestamp = final_runs[k].timestamp;
                collect_final_runs.push(final_runs[k]);
                break;
            }
        }

        if (final_run_timestamp !== null) {
            var slip_days_used = score_module.calc_slip_days_for(
                    final_run_timestamp, curr_assignment);
            collect_final_runs[collect_final_runs.length - 1].slip_days_used =
                slip_days_used;
            remaining_slip_days = remaining_slip_days - slip_days_used;
        }
    }

    return {remaining_slip_days: remaining_slip_days,
            collected_final_runs: collect_final_runs};
}

// Render a page showing detailed information on a specific run.
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
        var ncores = score_module.parse_comma_separated_ints(rows[0].ncores);
        var passed_checkstyle = rows[0].passed_checkstyle;
        var compiled = rows[0].compiled;
        var passed_all_correctness = rows[0].passed_all_correctness;
        var run_tag = rows[0].tag;
        // e.g. 2016-02-13 18:30:20.028665
        var start_time = moment(rows[0].start_time);
        var correctness_only = rows[0].correctness_only;
        var enable_profiling = rows[0].enable_profiling;
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
                 * If bugs cause submissions to fail or we cleared out older
                 * folders to save disk space, their storage may not exist.
                 */
                if (!fs.existsSync(run_dir)) {
                  return render_page('missing_run.html', res, req, { run_id: run_id });
                } else {
                  var loaded = score_module.load_log_files(run_dir);
                  var cello_err = loaded.cello_err;
                  var log_files = loaded.log_files;
        
                  // Calculate score before reordering files
                  var score = score_module.calculate_score(assignment_id, log_files, ncores,
                          run_status, run_id);

                  /*
                   * Order files in reordered_log_files such that they are
                   * displayed in a more intuitive order for the user
                   */
                  var reordered_log_files = {};
                  var file_ordering = ['checkstyle.txt', 'files.txt', 'compile.txt', 'correct.txt', 'tree.txt'];
                  for (var log_filename_index in file_ordering) {
                      var log_filename = file_ordering[log_filename_index];
                      if (log_filename in log_files) {
                          reordered_log_files[log_filename] = log_files[log_filename];
                          delete log_files[log_filename];
                      }
                  }
                  for (var ncores_index in ncores) {
                      var curr_ncores = ncores[ncores_index];
                      var filename = 'performance.' + curr_ncores + '.txt';
                      if (filename in log_files) {
                          reordered_log_files[filename] = log_files[filename];
                          delete log_files[filename];
                      }
                  }
                  for (var leftover in log_files) {
                      reordered_log_files[leftover] = log_files[leftover];
                  }

                  if (cello_err === null && cello_msg.length > 0) {
                      cello_err = cello_msg;
                  }

                  get_final_run_for(user_id, assignment_id, function(final_run_id) {
                    var marked_final = (final_run_id === run_id);

                    var render_vars = {run_id: run_id, log_files: reordered_log_files,
                                       viola_err: viola_err_msg, cello_err: cello_err,
                                       passed_checkstyle: passed_checkstyle,
                                       compiled: compiled,
                                       passed_all_correctness: passed_all_correctness,
                                       elapsed_time: elapsed_time, finished: finished,
                                       has_performance_tests: !correctness_only,
                                       correctness_only: correctness_only,
                                       passed_performance: passed_performance,
                                       run_status: run_status,
                                       assignment_name: assignment_name,
                                       assignment_id: assignment_id,
                                       run_tag: run_tag,
                                       enable_profiling: enable_profiling,
                                       is_final: marked_final};
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
                  });
                }
            });
        });
    });
});

// Cancel a given run
app.post('/cancel/:run_id', function(req, res, next) {
    log('cancel: run_id=' + req.params.run_id + ' user=' + req.session.username);
    if (!req.params.run_id) {
        return redirect_with_err('/overview', res, req,
            'No run ID was provided for cancellation');
    }

    // Check permission to cancel this run
    pgquery_no_err('SELECT * FROM runs WHERE (user_id=($1)) AND (run_id=($2))',
        [req.session.user_id, req.params.run_id], res, req, function(rows) {
        if (rows.length != 1) {
            return redirect_with_err('/overview', res, req,
                'You do not appear to have permission to cancel that run');
        }
        var correctness_only = rows[0].correctness_only;
        var run_status = rows[0].status;

        // Quit early if the provided run has already completed.
        if (run_status === score_module.FINISHED_STATUS ||
            run_status === score_module.CANCELLED_STATUS || run_status === score_module.FAILED_STATUS) {
            return redirect_with_success('/overview', res, req,
                'That run has already completed');
        }

        var viola_params = 'done_token=' + rows[0].done_token;
        var viola_options = { host: VIOLA_HOST,
            port: VIOLA_PORT, path: '/cancel?' + encodeURI(viola_params) };
        log('cancel: signaling Viola to cancel run ' + req.params.run_id);

        // Ask the viola to cancel a run.
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
                                    // If we were unable to cancel on viola, try to cancel on the cluster.
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

// Should be the last route in this file, redirect to the overview page.
app.get('/', function(req, res, next) {
  return res.redirect('overview');
});

var checkClusterActive = false;
// Set a timeout for the next time to check the cluster for completed performance tests.
function set_check_cluster_timeout(t) {
    log('set_check_cluster_timeout: timeout=' + t);
    checkClusterActive = false;
    setTimeout(check_cluster, t);
}

// Abort checking the performance tests and retry again later.
function abort_and_reset_perf_tests(err, lbl) {
  log('abort_and_reset_perf_tests: ' + lbl + ' err=' + err);
  set_check_cluster_timeout(CHECK_CLUSTER_PERIOD_MS);
}

// When a performance test is detected as complete on the cluster,
// finish_perf_tests transfers its output back to the conductor.
function finish_perf_tests(run_status, run, perf_runs, current_perf_runs_index) {
    score_module.pgquery('SELECT * FROM users WHERE user_id=($1)', [run.user_id], function(err, rows) {
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

            var tests = score_module.parse_comma_separated_ints(run.ncores);
            var max_n_cores = score_module.max(tests);
            for (var i = 0; i < tests.length; i++) {
                var curr_cores = tests[i];
                var local = LOCAL_FOLDER + '/performance.' + curr_cores + '.txt';
                var remote = REMOTE_FOLDER + '/performance.' + curr_cores + '.txt';

                copies.push({ src: remote, dst: local });
            }

            batched_cluster_copy(copies, false, function(stat) {
                var any_missing_files = false;
                var any_infrastructure_failures = false;
                for (var i = 0; i < stat.length; i++) {
                    if (stat[i].success) {
                        log('finish_perf_tests: successfully copied back to ' + stat[i].dst);
                    } else {
                        var trimmed_err = stat[i].err.toString().trim();
                        if (string_ends_with(trimmed_err, 'No such file or directory') || string_ends_with(trimmed_err, 'No such file')) {
                            log('finish_perf_tests: failed copying ' +
                                stat[i].dst + ' because it didn\'t exist on the cluster: ' + trimmed_err);
                            any_missing_files = true;
                        } else {
                            log('finish_perf_tests: err copying to ' +
                                stat[i].dst + ', err="' + stat[i].err + '"');
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
                    var rubric_file = score_module.rubric_file_path(run.assignment_id);
                    var validated = score_module.load_and_validate_rubric(rubric_file);
                    if (validated.success) {
                        var rubric = validated.rubric;
                        var characteristic_test = rubric.performance.characteristic_test;
                        var performance_path = LOCAL_FOLDER + '/performance.' +
                            max_n_cores + '.txt';
                        if (score_module.get_file_size(performance_path) < score_module.MAX_DISPLAY_FILE_SIZE) {
                            var test_contents = fs.readFileSync(performance_path, 'utf8');
                            var test_lines = test_contents.split('\n');
                            for (var line_index in test_lines) {
                                if (string_starts_with(test_lines[line_index], score_module.PERF_TEST_LBL)) {
                                    var tokens = test_lines[line_index].split(' ');
                                    var testname = tokens[2];
                                    if (testname === characteristic_test) {
                                        var seq_time = parseInt(tokens[3]);
                                        var parallel_time = parseInt(tokens[4]);
                                        var speedup = 0.0;
                                        if (parallel_time > 0.0) {
                                            speedup = seq_time / parallel_time;
                                        }
                                        characteristic_speedup = speedup.toFixed(3);
                                        log('finish_perf_tests: run=' + run.run_id + ', setting characteristic speedup ' + characteristic_speedup);
                                        break;
                                    }
                                }
                            }
                        } else {
                            log('finish_perf_tests: ' + performance_path +
                                    ' is >= ' + score_module.MAX_DISPLAY_FILE_SIZE + ' bytes');
                        }
                    }
                }

                score_module.pgquery("UPDATE runs SET status='" + run_status + "'," +
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

                        run_cluster_cmd('delete run dir on cluster',
                            'rm -r autograder/' + run.run_id,
                            function(err, stdout, stderr) {
                                // Ignore errors and send e-mail notification
                                if (wants_notification) {
                                    var email = username + '@rice.edu';
                                    if (username === 'admin') {
                                        email = 'jmg3@rice.edu';
                                    }
                                    var subject = 'Habanero AutoGrader Run ' + run.run_id + ' Finished';
                                    var body = 'http://' + os_package.hostname() + '/run/' + run.run_id;
                                    send_email(email_for_user(username), subject, body, function(err) {
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
    });
}

// Check the status of an individual run on the cluster.
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
                if (stdout === score_module.FAILED_STATUS || stdout === 'TIMEOUT') {
                    log('check_cluster_helper: marking ' + run.run_id + ' ' + score_module.FAILED_STATUS);
                    run_status = score_module.FAILED_STATUS;
                    finished = true;
                } else if (string_starts_with(stdout, score_module.CANCELLED_STATUS)) {
                    log('check_cluster_helper: marking ' + run.run_id + ' ' + score_module.CANCELLED_STATUS);
                    run_status = score_module.CANCELLED_STATUS;
                    finished = true;
                } else if (stdout === 'COMPLETED') {
                    log('check_cluster_helper: marking ' + run.run_id + ' ' + score_module.FINISHED_STATUS);
                    run_status = score_module.FINISHED_STATUS;
                    finished = true;
                } else if (stdout === 'RUNNING') {
                    log('check_cluster_helper: marking ' + run.run_id + ' as ' +
                            score_module.TESTING_PERFORMANCE_STATUS);
                    run_status = score_module.TESTING_PERFORMANCE_STATUS;
                }

                if (run_status) {
                    if (finished) {
                        finish_perf_tests(run_status, run, perf_runs, i);
                    } else {
                        score_module.pgquery("UPDATE runs SET status='" +
                                score_module.TESTING_PERFORMANCE_STATUS +
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
                        score_module.FINISHED_STATUS);
                finish_perf_tests(score_module.FINISHED_STATUS, run, perf_runs, i);
            }
        }
    }
}

// Main entrypoint for polling a SLURM-based cluster for completed performance tests.
function check_cluster() {
    if (checkClusterActive) {
        log('check_cluster: woke up and a cluster checker was already active?!');
    } else {
        // Send reminder e-mails three hours beforehand
        score_module.pgquery("SELECT * FROM assignments WHERE " +
                "send_reminder_emails IS TRUE AND " +
                "reminder_email_sent IS FALSE AND " +
                "deadline < now() + INTERVAL '6 HOUR'", [], function(err, rows) {
            if (err) {
                log('Error looking up reminder emails: ' + err);
                return;
            }

            if (rows.length > 0) {
                /*
                 * Have one or more reminders to send. For simplicity we just
                 * send one at a time, we'll come back around to this in no time.
                 */
                log('check_cluster: Found ' + rows.length + ' reminders to send');
                send_email_to_each_active_user('Final Submission Reminder - COMP 322 ' + rows[0].name,
                        'This is the final reminder e-mail to mark your final ' +
                        'submission for ' + rows[0].name + ' in the autograder. ' +
                        'Failure to mark your submission will either result in a ' +
                        'zero (if no submission), or the use of slip days (if a ' +
                        'submission is marked final after the deadline of ' +
                        rows[0].deadline + '). See the section titled "Viewing ' +
                        'run information" at http://' + os_package.hostname() +
                        '/user_guide for how to select a final submission, and ' +
                        'see your user profile at http://' + os_package.hostname() +
                        '/profile for a list of your final submissions.', function(err) {
                    if (err) {
                        log('Error sending reminder emails: ' + err);
                        return;
                    }

                    score_module.pgquery('UPDATE assignments SET reminder_email_sent=TRUE ' +
                        'WHERE assignment_id=$1', [rows[0].assignment_id],
                        function(err, rows) {
                            if (err) {
                                log('Error marking emails sent: ' + err);
                                return;
                            }
                        });
                });

            }
        });

        checkClusterActive = true;
        score_module.pgquery("SELECT * FROM runs WHERE (job_id IS NOT " +
            "NULL) AND ((status='" + score_module.TESTING_PERFORMANCE_STATUS + "') OR " +
            "(status='" + score_module.IN_CLUSTER_QUEUE_STATUS + "') OR (job_id='" +
            LOCAL_JOB_ID + "'))", [], function(err, rows) {
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

// Setup for this web server, kicking off the cluster polling mechanism.
function launch() {
    var port = process.env.PORT || 8000;

    var oneDay = 86400000;
    app.use(express.static(__dirname + '/views', { maxAge: oneDay }));

    connect_to_cluster(function() {
        set_check_cluster_timeout(0);

        var vars = ['HOME',
                    'LIGHTWEIGHT_JAVA_PROFILER_HOME',
                    'JUNIT_JAR', 'HAMCREST_JAR',
                    'ASM_JAR', 'RR_AGENT_JAR', 'RR_RUNTIME_JAR'];
        batched_get_cluster_env_var(vars, function(err, vals) {
          if (err) {
            return failed_starting_perf_tests(res,
              'Error getting cluster env variables, err=' + err, run_id);
          }

          CLUSTER_HOME = vals.HOME;
          CLUSTER_LIGHTWEIGHT_JAVA_PROFILER_HOME = vals.LIGHTWEIGHT_JAVA_PROFILER_HOME;
          CLUSTER_JUNIT_JAR = vals.JUNIT_JAR;
          CLUSTER_HAMCREST_JAR = vals.HAMCREST_JAR;
          CLUSTER_ASM_JAR = vals.ASM_JAR;
          CLUSTER_RR_AGENT_JAR = vals.RR_AGENT_JAR;
          CLUSTER_RR_RUNTIME_JAR = vals.RR_RUNTIME_JAR;

          var server = app.listen(port, function() {
              log('Server listening at http://' + server.address().address + ':' +
                  server.address().port); 
          });

        });
    });
}

/*
 * At one point, we conservatively marked all running jobs as failed on startup.
 * However, Viola has been refactored to continually retry conductor
 * notifications and the cluster job status can be checked at any time, so it
 * appears it is safe to pick up running jobs on reboot. We still allow more
 * aggressive killing of jobs on boot through a CLI flag, but it is disabled by
 * default.
 */
if (process.argv.length > 2 && process.argv[2] === 'kill-running-jobs') {
    /*
     * Mark any in-progress tests as failed on reboot.
     */
    score_module.pgquery("UPDATE runs SET status='" + score_module.FAILED_STATUS + "'," +
        "finish_time=CURRENT_TIMESTAMP WHERE status='" +
        score_module.TESTING_CORRECTNESS_STATUS + "' OR status='" +
        score_module.TESTING_PERFORMANCE_STATUS + "' OR status='" + score_module.IN_CLUSTER_QUEUE_STATUS +
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
