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
var scp = require('scp2')
var child_process = require('child_process');
var nodemailer = require('nodemailer');
var url = require('url');

var permissionDenied = 'Permission denied. But you should shoot me an e-mail at jmaxg3@gmail.com. If you like playing around with systems, we have interesting research for you in the Habanero group.';

var upload = multer({ dest: 'uploads/' });

var KEEP_CLUSTER_DIRS = true;
var VERBOSE = false;

var LOCAL_JOB_ID = 'LOCAL';

function check_env(varname) {
  if (!(varname in process.env)) {
    console.log('The ' + varname + ' environment variable must be set');
    process.exit(1);
  }
  return process.env[varname];
}

var AUTOGRADER_HOME = check_env('AUTOGRADER_HOME');

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
  console.log('send_email: to=' + to + ' subject="' + subject + '"');

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
if (POSTGRES_PASSWORD.length == 0) {
  POSTGRES_USER_TOKEN = POSTGRES_USERNAME;
} else {
  POSTGRES_USER_TOKEN = POSTGRES_USERNAME + ":" + POSTGRES_PASSWORD;
}

console.log('Connecting to local PGSQL instance with user ' + POSTGRES_USERNAME);

var SVN_USERNAME = process.env.SVN_USER || 'jmg3';
var SVN_PASSWORD = process.env.SVN_PASSWORD || '';
var SVN_REPO = process.env.SVN_REPO ||
    'https://svn.rice.edu/r/parsoft/projects/AutoGrader/student-runs';

console.log('Connecting to SVN repo ' + SVN_REPO + ' as user ' + SVN_USERNAME);

var svn_client = new svn({
        username: SVN_USERNAME,
        password: SVN_PASSWORD
    });

var VIOLA_HOST = process.env.VIOLA_HOST || 'localhost';
var VIOLA_PORT = parseInt(process.env.VIOLA_PORT || '8080');

console.log('Connecting to Viola at ' + VIOLA_HOST + ':' + VIOLA_PORT);

var CLUSTER_HOSTNAME = process.env.CLUSTER_HOSTNAME || 'stic.rice.edu';
var CLUSTER_USER = process.env.CLUSTER_USER || 'jmg3';
var CLUSTER_PASSWORD = process.env.CLUSTER_PASSWORD || '';
/*
 * We support cluster types of 'slurm' and 'local'. However, 'local' clusters are
 * purely for testing locally and should never be used in production, as they
 * block on every performance test.
 */
var CLUSTER_TYPE = process.env.CLUSTER_TYPE || 'slurm';
if (CLUSTER_TYPE !== 'slurm' && CLUSTER_TYPE !== 'local') {
  throw 'Unsupported cluster type ' + CLUSTER_TYPE;
}
var CHECK_CLUSTER_PERIOD = 30000;

console.log('Connecting to remote cluster at ' + CLUSTER_HOSTNAME +
  ' of type ' + CLUSTER_TYPE + ' as ' + CLUSTER_USER);

// TODO load this from JSON file
var conString = "postgres://" + POSTGRES_USER_TOKEN + "@localhost/autograder";

function pgclient(cb) {
  console.log('pgclient: acquiring PGSQL client...');
  pg.connect(conString, function(err, client, done) {
          console.log("pgclient: finished acquiring PGSQL client, err=" + err);
          if (err) {
            done();
            return console.error('error fetching client from pool', err);
          }
          cb(client, done);
        });
}

function register_query_helpers(query, res, done, username) {
    query.on('row', function(row, result) { result.addRow(row); });
    query.on('error', function(err, result) {
            done();
            res.send(JSON.stringify({ status: 'Failure',
                    msg: 'Internal error (' + err + ')', user: username }));
    });
}

function connect_to_cluster(cb) {
  console.log('connect_to_cluster: Connecting to cluster of cluster type ' +
      CLUSTER_TYPE + ', cluster hostname ' + CLUSTER_HOSTNAME +
      ', cluster user ' + CLUSTER_USER);
  if (CLUSTER_TYPE === 'slurm') {
    var conn = new ssh.Client();
    conn.on('ready', function() {
      cb(conn, null);
    }).on('error', function(err) {
      cb(null, err);
    }).connect({
        host: CLUSTER_HOSTNAME,
        port: 22,
        username: CLUSTER_USER,
        password: CLUSTER_PASSWORD,
        readyTimeout: 60000
    });
  } else {
    // local
    cb('localhost', null);
  }
}

function disconnect_from_cluster(conn) {
  if (CLUSTER_TYPE === 'slurm') {
    conn.end();
  }
}

// Assume this is called after 'ready' event is triggered.
function run_cluster_cmd(conn, lbl, cluster_cmd, cb) {
    console.log('run_cluster_cmd[' + lbl + ']: ' + cluster_cmd);

    if (CLUSTER_TYPE === 'slurm') {
        conn.exec(cluster_cmd, function(err, stream) {
            if (err) {
                disconnect_from_cluster(conn);
                console.log('[' + lbl + '] err=' + err);
                return cb(lbl, conn, null, null);
            }
            var acc_stdout = '';
            var acc_stderr = '';
            stream.on('close', function(code, signal) {
                if (code != 0) {
                    disconnect_from_cluster(conn);
                    console.log('[' + lbl + '] code=' + code + ' signal=' + signal);
                    return cb(lbl, conn, acc_stdout, acc_stderr);
                } else {
                    if (VERBOSE) {
                        console.log('[' + lbl + '] code=' + code + ' signal=' + signal);
                        console.log('[' + lbl + '] stdout=' + acc_stdout);
                        console.log('[' + lbl + '] stderr=' + acc_stderr);
                    }
                    return cb(null, conn, acc_stdout, acc_stderr);
                }
            }).on('data', function(data) {
                acc_stdout = acc_stdout + data;
            }).stderr.on('data', function(data) {
                acc_stderr = acc_stderr + data;
            });
        });
    } else {
      var args = ['-c', cluster_cmd];
      var run = child_process.spawn('/bin/bash', args);

      var acc_stdout = '';
      var acc_stderr = '';
      run.stdout.on('data', function(data) { acc_stdout = acc_stdout + data; });
      run.stderr.on('data', function(data) { acc_stderr = acc_stderr + data; });
      run.on('close', function(code) {
        if (code != 0) {
          console.log('[' + lbl + '] code=' + code + ', cluster_cmd=' + cluster_cmd);
          return cb(lbl, conn, acc_stdout, acc_stderr);
        } else {
          if (VERBOSE) {
            console.log('[' + lbl + '] code=' + code);
            console.log('[' + lbl + '] stdout=' + acc_stdout);
            console.log('[' + lbl + '] stderr=' + acc_stderr);
          }
          return cb(null, conn, acc_stdout, acc_stderr);
        }
      });
    }
}

function cluster_scp(src_file, dst_file, is_upload, cb) {
  if (is_upload) {
    if (dst_file.trim().search('/') === 0) {
      throw 'All remote directories should be relative, but got ' + dst_file;
    }
  } else {
    if (src_file.trim().search('/') === 0) {
      throw 'All remote directories should be relative, but got ' + src_file;
    }
  }

  if (CLUSTER_TYPE === 'slurm') {
      var dst = null;
      var src = null;
      if (is_upload) {
        dst = CLUSTER_USER + ':' + CLUSTER_PASSWORD + '@' + CLUSTER_HOSTNAME + ':' + dst_file;
        src = src_file;
      } else {
        dst = dst_file;
        src = CLUSTER_USER + ':' + CLUSTER_PASSWORD + '@' + CLUSTER_HOSTNAME + ':' + src_file;
      }
      scp.scp(src, dst, cb);
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

function create_cluster_dir(dirname, conn, cb) {
  if (dirname.trim().search('/') === 0) {
    throw 'Remote directory names should be relative to $HOME, got ' + dirname;
  }

  var MKDIR_CMD = null;
  if (CLUSTER_TYPE === 'slurm') {
    MKDIR_CMD = 'mkdir -p ' + dirname;
  } else {
    MKDIR_CMD = 'mkdir -p ' + process.env.HOME + '/' + dirname;
  }

  run_cluster_cmd(conn, 'creating dir', MKDIR_CMD, cb);
}

function delete_cluster_dir(dirname, conn, cb) {
  if (dirname.trim().search('/') === 0) {
    throw 'Remote directory names should be relative to $HOME, got ' + dirname;
  }

  var RMDIR_CMD = null;
  if (CLUSTER_TYPE === 'slurm') {
    RMDIR_CMD = 'rm -r ' + dirname;
  } else {
    RMDIR_CMD = 'rm -r ' + process.env.HOME + '/' + dirname;
  }

  if (KEEP_CLUSTER_DIRS) {
    cb(null, conn, '', '');
  } else {
    run_cluster_cmd(conn, 'removing dir', RMDIR_CMD, cb);
  }
}

function get_cluster_env_var(varname, conn, cb) {
  var ECHO_CMD = 'echo $' + varname;
  run_cluster_cmd(conn, 'getting variable ' + varname, ECHO_CMD,
      function(err, conn, stdout, stderr) {
        if (err) {
          cb(err, null);
        } else {
          cb(null, stdout.trim());
        }
      });
}

function batched_get_cluster_env_var_helper(index, varnames, conn, acc, cb) {
  if (index >= varnames.length) {
    return cb(null, acc);
  }

  get_cluster_env_var(varnames[index], conn, function(err, val) {
    if (err) {
      cb(err, null);
    } else {
      val = val.trim();
      if (val.length === 0) {
        cb('Missing cluster environment variable ' + varnames[index]);
      } else {
        acc[varnames[index]] = val;
        batched_get_cluster_env_var_helper(index + 1, varnames, conn, acc, cb);
      }
    }
  });
}

function batched_get_cluster_env_var(varnames, conn, cb) {
  return batched_get_cluster_env_var_helper(0, varnames, conn, {}, cb);
}

function get_cluster_os(conn, cb) {
  var UNAME_CMD = 'uname';
  run_cluster_cmd(conn, 'get cluster OS', UNAME_CMD,
      function(err, conn, stdout, stderr) {
        if (err) {
          console.log('get_cluster_os: err=' + err + ', stderr=' + stderr);
          cb(err, null);
        } else {
          stdout = stdout.trim();
          console.log('get_cluster_os: got ' + stdout);
          cb(null, stdout);
        }
      });
}

function get_cluster_cores(conn, cb) {
  get_cluster_os(conn, function(err, os) {
    if (err) {
      return cb(err, null);
    }

    if (os === 'Darwin') {
      run_cluster_cmd(conn, 'Getting Darwin cores', 'sysctl -n hw.ncpu',
        function(err, conn, stdout, stderr) {
          if (err) {
            return cb(err, null);
          } else {
            var ncores = parseInt(stdout);
            console.log('get_cluster_cores: found ' + ncores + ' cores');
            return cb(null, ncores);
          }
        });
    } else if (os === 'Linux') {
      run_cluster_cmd(conn, 'Getting Linux cores',
        'cat /proc/cpuinfo | grep processor | wc -l',
        function(err, conn, stdout, stderr) {
          if (err) {
            return cb(err, null);
          } else {
            var ncores = parseInt(stdout);
            console.log('get_cluster_cores: found ' + ncores + ' cores');
            return cb(null, ncores);
          }
        });
    } else {
      return cb('Unsupported OS "' + os + '"', null);
    }
  });
}

function string_starts_with(st, prefix) {
  return st.slice(0, prefix.length) === prefix;
}

function string_ends_with(st, suffix) {
  return st.indexOf(suffix, st.length - suffix.length) !== -1;
};

var app = express();
app.use(bodyParser.urlencoded());
app.use(session({secret: 'blarp', cookie:{maxAge: 7 * 24 * 3600 * 1000}}));
app.engine('html', ejs.renderFile);
app.set('view engine', 'html');
app.set('views', __dirname + "/views");

/*
 * login/logout routes should always be the only routes above the wildcard '*' route
 */
app.get('/login', function(req, res, next) {
  res.render('login.html');
});

app.post('/login', function(req, res, next) {
  var username = req.body.username;
  var password = req.body.password;

  console.log('login: username=' + username);

  // Check that user exists
  pgclient(function(client, done) {
        var query = client.query("SELECT * FROM users WHERE user_name=($1)", [username]);
        register_query_helpers(query, res, done, username);
        query.on('end', function(result) {
              done();
              if (result.rowCount == 0) {
                res.send(JSON.stringify({ status: 'Failure',
                        msg: 'User "' + username + '" does not exist',
                        user: username }));
              } else if (result.rowCount == 1) {
                // Check that password matches
                if (bcrypt.compareSync(password, result.rows[0].password_hash)) {
                  req.session.username = username;
                  req.session.user_id = result.rows[0].user_id;
                  req.session.is_admin = result.rows[0].is_admin;

                  res.send(JSON.stringify({ status: 'Success',
                          redirect: '/overview', user: username }));
                } else {
                  res.send(JSON.stringify({ status: 'Failure',
                          msg: 'Incorrect password for user "' + username + '"',
                          user: username }));
                }
              } else {
                res.send(JSON.stringify({ status: 'Failure',
                        msg: 'Internal error (' + result.rowCount + ')'}));
              }
            });
      });
});

app.get('/logout', function(req, res, next) {
  console.log('logout: username=' + req.session.username);

  req.session.username = null;
  req.session.user_id = null;
  req.session.is_admin = false;

  res.render('login.html');
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

        res.redirect('/login');
    }
  }
});

app.get('/overview', function(req, res, next) {
  res.render('overview.html');
});

app.get('/leaderboard', function(req, res, next) {
  res.render('leaderboard.html');
});

app.get('/comments', function(req, res, next) {
  res.render('comments.html');
});

app.post('/comments', function(req, res, next) {
  var comment = req.body.comments;
  send_email('jmg3@rice.edu', 'AUTOGRADER COMMENT', comment, function(err) {
    if (err) {
      console.log('comments: err=' + err);
      return res.render('comments.html', {err_msg: 'Error submitting comment' });
    }
    return res.render('overview.html', {success_msg: 'Thank you for your comment!'});
  });
});

app.get('/admin', function(req, res, next) {
  if (req.session.is_admin) {
    res.render('admin.html');
  } else {
    res.redirect('/overview');
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
  console.log('assignment: is_admin=' + req.session.is_admin);
  if (!req.session.is_admin) {
    return res.send(JSON.stringify({ status: 'Failure', msg: permissionDenied }));
  } else {
    var assignment_name = req.body.assignment_name;
    if (assignment_name.length == 0) {
      return res.render('admin.html',
        {err_msg: 'Please provide a non-empty assignment name'});
    }

    if (!req.files.zip) {
      return res.render('admin.html',
        {err_msg: 'Please provide test files for the assignment'});
    }
    if (!req.files.instructor_pom) {
      return res.render('admin.html',
        {err_msg: 'Please provide an instructor pom for the assignment'});
    }
    if (!req.files.rubric) {
      return res.render('admin.html',
        {err_msg: 'Please provide a rubric for the assignment'});
    }
    if (!req.files.checkstyle_config) {
      return res.render('admin.html',
        {err_msg: 'Please provide a checkstyle configuration for the assignment'});
    }

    pgclient(function(client, done) {

          var rubric_validated = load_and_validate_rubric(req.files.rubric[0].path);
          if (!rubric_validated.success) {
              done();
              return res.render('admin.html', {err_msg: 'Error in rubric: ' + rubric_validated.msg});
          }

          var pom_validated = validate_instructor_pom(req.files.instructor_pom[0].path);
          if (!pom_validated.success) {
              done();
              return res.render('admin.html', {err_msg: 'Error in POM: ' + pom_validated.msg});
          }

          var query = client.query(
              "INSERT INTO assignments (name, visible) VALUES ($1,false) RETURNING assignment_id",
              [assignment_name]);
          register_query_helpers(query, res, done, req.session.username);
          query.on('end', function(result) {
              done();
              var assignment_id = result.rows[0].assignment_id;

              var assignment_dir = __dirname + '/instructor-tests/' + assignment_id;

              var dst_dir = SVN_REPO + '/assignments/' + assignment_id;
              var mkdir_msg = 'create assignment ' + assignment_id;
              svn_client.cmd(['mkdir', '--parents', '--message', mkdir_msg, dst_dir],
                function(err, data) {
                  if (is_actual_svn_err(err)) {
                    return res.render('admin.html',
                      {err_msg: 'Error creating assignment directory'});
                  } else {
                    svn_client.cmd(['checkout', dst_dir, assignment_dir], function(err, data) {
                      if (is_actual_svn_err(err)) {
                        return res.render('admin.html',
                          {err_msg: 'Error checking out assignment directory'});
                      } else {
                        fs.renameSync(req.files.zip[0].path,
                          assignment_dir + '/instructor.zip');
                        fs.renameSync(req.files.instructor_pom[0].path,
                          assignment_dir + '/instructor_pom.xml');
                        fs.renameSync(req.files.rubric[0].path,
                          assignment_dir + '/rubric.json');
                        fs.renameSync(req.files.checkstyle_config[0].path,
                          assignment_dir + '/checkstyle.xml');

                        svn_client.cmd(['add',
                          assignment_dir + '/instructor.zip',
                          assignment_dir + '/instructor_pom.xml',
                          assignment_dir + '/rubric.json',
                          assignment_dir + '/checkstyle.xml'], function(err, data) {
                            if (is_actual_svn_err(err)) {
                              return res.render('admin.html',
                                {err_msg: 'Error adding files to assignment repo'});
                            } else {
                              var commit_msg = 'initial commit for assignment ' + assignment_id;
                              svn_client.cmd(['commit', '--message', commit_msg, assignment_dir],
                                function(err, data) {
                                  if (is_actual_svn_err(err)) {
                                    return res.render('admin.html',
                                      {err_msg: 'Error committing files to assignment repo'});
                                  } else {
                                    return res.redirect('/admin');
                                  }
                                });
                            }
                        });
                      }
                    });
                  }
                });
          });
    });
  }
});

function handle_reupload(req, res, missing_msg, target_filename) {
  if (!req.session.is_admin) {
    return res.render('admin.html', {err_msg: permissionDenied});
  } else {
    var assignment_id = req.params.assignment_id;

    if (!req.file) {
      return res.render('admin.html', {err_msg: missing_msg});
    }

    pgclient(function(client, done) {
      var query = client.query(
        "SELECT * FROM assignments WHERE assignment_id=($1)", [assignment_id]);
      register_query_helpers(query, res, done, req.session.username);
      query.on('end', function(result) {
        done();
        if (result.rows.length != 1) {
          return res.render('admin.html',
            {err_msg: 'That assignment doesn\'t seem to exist'});
        } else {
          var assignment_dir = __dirname + '/instructor-tests/' + assignment_id;
          /*
           * This update shouldn't be necessary, but in case we make manual
           * changes to the repo this ensures we're on the latest revision on
           * the NodeJS server (and handles the buggy Habanero repo).
           */
          svn_client.cmd(['update', '--accept', 'theirs-full', assignment_dir], function(err, data) {
            if (is_actual_svn_err(err)) {
              return res.render('admin.html', {err_msg: 'Error updating file in the repo'});
            }

            fs.renameSync(req.file.path, assignment_dir + '/' + target_filename);
            var commit_msg = 'reupload ' + target_filename + ' for assignment' + assignment_id;
            svn_client.cmd(['commit', '--message', commit_msg, assignment_dir],
              function(err, data) {
                if (is_actual_svn_err(err)) {
                  return res.render('admin.html', {err_msg: 'Error updating file in the repo'});
                } else {
                  return res.redirect('/admin');
                }
              });
          });
        }
      });
    });
  }
}

app.post('/update_jvm_args/:assignment_id', function(req, res, next) {
  console.log('update_jvm_args: is_admin=' + req.session.is_admin + ', jvm_args=' + req.body.jvm_args);
  if (!req.session.is_admin) {
    return res.render('admin.html', {err_msg: permissionDenied});
  } else {
    if (!req.body.jvm_args) {
      return res.render('admin.html', {err_msg: 'Malformed request, missing JVM args field?'});
    }
    var assignment_id = req.params.assignment_id;

    pgclient(function(client, done) {
      var query = client.query(
        "SELECT * FROM assignments WHERE assignment_id=($1)", [assignment_id]);
      register_query_helpers(query, res, done, req.session.username);
      query.on('end', function(result) {
        if (result.rows.length != 1) {
          done();
          return res.render('admin.html',
            {err_msg: 'That assignment doesn\'t seem to exist'});
        } else {
          var query = client.query("UPDATE assignments SET jvm_args=($1) WHERE assignment_id=($2);",
              [req.body.jvm_args, assignment_id]);
          register_query_helpers(query, res, done, req.session.username);
          query.on('end', function(result) {
            done();
            return res.redirect('/admin');
          });
        }
      });
    });
  }
});

app.post('/update_correctness_timeout/:assignment_id', function(req, res, next) {
  console.log('update_correctness_timeout: is_admin=' + req.session.is_admin + ', new timeout=' + req.body.correctness_timeout);
  if (!req.session.is_admin) {
    return res.render('admin.html', {err_msg: permissionDenied});
  } else {
    if (!req.body.correctness_timeout) {
      return res.render('admin.html', {err_msg: 'Malformed request, missing correctness timeout field?'});
    }
    var assignment_id = req.params.assignment_id;

    pgclient(function(client, done) {
      var query = client.query(
        "SELECT * FROM assignments WHERE assignment_id=($1)", [assignment_id]);
      register_query_helpers(query, res, done, req.session.username);
      query.on('end', function(result) {
        if (result.rows.length != 1) {
          done();
          return res.render('admin.html',
            {err_msg: 'That assignment doesn\'t seem to exist'});
        } else {
          var query = client.query("UPDATE assignments SET correctness_timeout_ms=($1) WHERE assignment_id=($2);",
              [req.body.correctness_timeout, assignment_id]);
          register_query_helpers(query, res, done, req.session.username);
          query.on('end', function(result) {
            done();
            return res.redirect('/admin');
          });
        }
      });
    });
  }
});

app.post('/upload_zip/:assignment_id', upload.single('zip'),
    function(req, res, next) {
      console.log('upload_zip: is_admin=' + req.session.is_admin);
      return handle_reupload(req, res, 'Please provide a ZIP', 'instructor.zip');
    });

app.post('/upload_instructor_pom/:assignment_id', upload.single('pom'),
    function(req, res, next) {
      console.log('upload_instructor_pom: is_admin=' + req.session.is_admin);

      if (!req.file) {
          return res.render('admin.html', {err_msg: 'No POM provided'});
      }

      var validated = validate_instructor_pom(req.file.path);
      if (!validated.success) {
          return res.render('admin.html', {err_msg: 'Error in POM: ' + validated.msg});
      }

      return handle_reupload(req, res, 'Please provide an instructor pom.xml',
        'instructor_pom.xml');
    });

app.post('/upload_rubric/:assignment_id', upload.single('rubric'),
    function(req, res, next) {
      console.log('upload_rubric: is_admin=' + req.session.is_admin);

      if (!req.file) {
          return res.render('admin.html', {err_msg: 'No rubric provided'});
      }

      var validated = load_and_validate_rubric(req.file.path);
      if (!validated.success) {
          return res.render('admin.html', {err_msg: 'Error in rubric: ' + validated.msg});
      }

      return handle_reupload(req, res, 'Please provide a rubric', 'rubric.json');
    });

app.post('/upload_checkstyle/:assignment_id', upload.single('checkstyle_config'),
    function(req, res, next) {
      console.log('upload_checkstyle: is_admin=' + req.session.is_admin);

      return handle_reupload(req, res, 'Please provide a checkstyle file', 'checkstyle.xml');
    });

/*
 * Get all assignments, with an optional flag to also view not visible
 * assignments (which is only legal for admin users, and ignored for all others).
 */
app.get('/assignments', function(req, res, next) {
  var get_not_visible = false;
  if (req.session.is_admin && req.query.get_not_visible && req.query.get_not_visible === 'true') {
    get_not_visible = true;
  }
  console.log('assignments: username=' + req.session.username +
      ' get_not_visible=' + get_not_visible);

  pgclient(function(client, done) {
    var query = null;
    if (get_not_visible) {
        query = client.query("SELECT * FROM assignments ORDER BY assignment_id ASC");
    } else {
        query = client.query("SELECT * FROM assignments WHERE visible=true;");
    }
    register_query_helpers(query, res, done, req.session.username);
    query.on('end', function(result) {
        done();
        console.log('assignments: returning ' + result.rowCount + ' assignment(s)');
        res.send(JSON.stringify({ status: 'Success',
                'assignments': result.rows }));
    });
  });
});

app.post('/set_assignment_correctness_only', function(req, res, next) {
  console.log('set_assignment_correctness_only: is_admin=' + req.session.is_admin);
  if (!req.session.is_admin) {
    res.send(JSON.stringify({ status: 'Failure', msg: permissionDenied }));
  } else {
    var assignment_id = req.body.assignment_id;
    var set_correctness_only = req.body.set_correctness_only;

    pgclient(function(client, done) {
        var query = client.query(
            "SELECT * FROM assignments WHERE assignment_id=($1);",
            [assignment_id]);
        register_query_helpers(query, res, done, req.session.username);
        query.on('end', function(result) {
            if (result.rowCount == 0) {
                done();
                return res.send(JSON.stringify({ status: 'Failure',
                        msg: 'Invalid assignment ID, does not exist' }));
            } else {
                var query = client.query(
                    "UPDATE assignments SET correctness_only=($1) WHERE assignment_id=($2);",
                    [set_correctness_only, assignment_id]);
                register_query_helpers(query, res, done, req.session.username);
                query.on('end', function(result) {
                    done();
                    return res.send(JSON.stringify({ status: 'Success',
                            redirect: '/admin' }));
                });
            }
        });
    });
  }
});

app.post('/set_assignment_visible', function(req, res, next) {
  console.log('set_assignment_visible: is_admin=' + req.session.is_admin);
  if (!req.session.is_admin) {
    res.send(JSON.stringify({ status: 'Failure', msg: permissionDenied }));
  } else {
    var assignment_id = req.body.assignment_id;
    var set_visible = req.body.set_visible;

    pgclient(function(client, done) {
        var query = client.query(
            "SELECT * FROM assignments WHERE assignment_id=($1);",
            [assignment_id]);
        register_query_helpers(query, res, done, req.session.username);
        query.on('end', function(result) {
            if (result.rowCount == 0) {
                done();
                return res.send(JSON.stringify({ status: 'Failure',
                        msg: 'Invalid assignment ID, does not exist' }));
            } else {
                var query = client.query(
                    "UPDATE assignments SET visible=($1) WHERE assignment_id=($2);",
                    [set_visible, assignment_id]);
                register_query_helpers(query, res, done, req.session.username);
                query.on('end', function(result) {
                    done();
                    return res.send(JSON.stringify({ status: 'Success',
                            redirect: '/admin' }));
                });
            }
        });
    });

  }
});

function get_user_name_for_id(user_id, client, done, res, cb) {
  var query = client.query("SELECT * FROM users WHERE user_id=($1)", [user_id]);
}

function get_user_id_for_name(username, client, done, res, cb) {
  var query = client.query("SELECT * FROM users WHERE user_name=($1)",
      [username]);
  register_query_helpers(query, res, done, username);
  query.on('end', function(result) {
    if (result.rowCount == 0) {
      return cb(0, 'User ' + username + ' does not seem to exist');
    } else if (result.rowCount > 1) {
      return cb(0, 'There appear to be duplicate users ' + username);
    } else {
      // Got the user ID, time to get the assignment ID
      var user_id = result.rows[0].user_id;

      return cb(user_id, null);
    }
  });
}

app.post('/submit_run', upload.single('zip'), function(req, res, next) {
    var assignment_name = req.body.assignment;
    var correctness_only = false;
    if ('correctness_only' in req.body && req.body.correctness_only === 'on') {
        correctness_only = true;
    }
    console.log('submit_run: username=' + req.session.username +
      ' assignment="' + assignment_name + '"');

    if (assignment_name.length == 0) {
      return res.render('overview.html', { err_msg: 'Please select an assignment' });
    }

    if (!req.file) {
      return res.render('overview.html', { err_msg: 'Please provide a ZIP file of your assignment' });
    }

    pgclient(function(client, done) {
      get_user_id_for_name(req.session.username, client, done, res,
        function(user_id, err) {
          if (err) {
            done();
            return res.render('overview.html', { err_msg: err });
          }
          var query = client.query("SELECT * FROM assignments WHERE name=($1)",
            [assignment_name]);
          register_query_helpers(query, res, done, req.session.username);
          query.on('end', function(result) {
            if (result.rowCount == 0) {
              done();
              return res.render('overview.html',
                { err_msg: 'Assignment ' + assignment_name + ' does not seem to exist' });
            } else if (result.rowCount > 1) {
              done();
              return res.render('overview.html',
                { err_msg: 'There appear to be duplicate assignments ' + assignment_name });
            } else {
              var assignment_id = result.rows[0].assignment_id;
              var jvm_args = result.rows[0].jvm_args;
              var correctness_timeout = result.rows[0].correctness_timeout_ms;
              console.log('submit_run: found assignment_id=' + assignment_id + ' jvm_args="' + jvm_args + '" correctness_timeout=' + correctness_timeout);

              // Allow assignment settings to override user-provided setting
              var assignment_correctness_only = result.rows[0].correctness_only;
              if (assignment_correctness_only) correctness_only = true;

              crypto.randomBytes(48, function(ex, buf) {
                  console.log('submit_run: got random bytes');
                  var done_token = buf.toString('hex');

                  var query = client.query("INSERT INTO runs (user_id, " +
                      "assignment_id, done_token, status, correctness_only) VALUES " +
                      "($1,$2,$3,'TESTING CORRECTNESS',$4) RETURNING run_id",
                      [user_id, assignment_id, done_token, correctness_only]);
                  register_query_helpers(query, res, done, req.session.username);
                  query.on('end', function(result) {
                    done();
                    var run_id = result.rows[0].run_id;
                    var run_dir = __dirname + '/submissions/' + req.session.username + '/' + run_id;
                    var dst_dir = SVN_REPO + '/' + req.session.username + '/' +
                        assignment_name + '/' + run_id;

                    var mkdir_msg = '"mkdir ' + req.session.username + ' ' + assignment_name + ' ' + run_id + '"';
                    svn_client.cmd(['mkdir', '--parents', '--message', mkdir_msg, dst_dir], function(err, data) {
                      // Special-case an error message from the Habanero repo that we can safely ignore
                      if (is_actual_svn_err(err)) {
                        return res.render('overview.html', { err_msg:
                          'An error occurred backing up your submission' });
                      } else {
                        svn_client.cmd(['checkout', dst_dir, run_dir], function(err, data) {
                          if (is_actual_svn_err(err)) {
                            return res.render('overview.html', { err_msg:
                              'An error occurred backing up your submission' });
                          } else {
                            // Move submitted file into newly created local SVN working copy
                            fs.renameSync(req.file.path, run_dir + '/student.zip');
                            svn_client.cmd(['add', run_dir + '/student.zip'], function(err, data) {
                              if (is_actual_svn_err(err)) {
                                return res.render('overview.html', { err_msg:
                                  'An error occurred backing up your submission' });
                              } else {
                                var commit_msg = '"add ' + req.session.username + ' ' + assignment_name + ' ' + run_id + '"';
                                svn_client.cmd(['commit', '--message', commit_msg, run_dir], function(err, data) {
                                  if (is_actual_svn_err(err)) {
                                    return res.render('overview.html', { err_msg:
                                      'An error occurred backing up your submission' });
                                  } else {
                                    var viola_params = 'done_token=' + done_token +
                                        '&user=' + req.session.username +
                                        '&assignment=' + assignment_name + '&run=' +
                                        run_id + '&assignment_id=' + assignment_id + '&jvm_args=' + jvm_args + '&timeout=' + correctness_timeout;
                                    var viola_options = { host: VIOLA_HOST,
                                        port: VIOLA_PORT, path: '/run?' + encodeURI(viola_params) };
                                    console.log('submit_run: sending viola ' +
                                      'request for run ' + run_id);
                                    http.get(viola_options, function(viola_res) {
                                        var bodyChunks = [];
                                        viola_res.on('data', function(chunk) {
                                            bodyChunks.push(chunk);
                                        });
                                        viola_res.on('end', function() {
                                            var body = Buffer.concat(bodyChunks);
                                            var result = JSON.parse(body);
                                            if (result.status === 'Success') {
                                                return res.redirect('/overview');
                                            } else {
                                                return res.render('overview.html',
                                                    { err_msg: 'Viola error: ' + result.msg });
                                            }
                                        });
                                    }).on('error', function(err) {
                                        console.log('VIOLA err="' + err + '"');
                                        return res.render('overview.html',
                                            { err_msg: 'An error occurred launching the local tests' });
                                    });
                                  }
                                });
                              }
                            });
                          }
                        });
                      }
                    });
                  });
              });
            }
          });
        });
    });
});

function get_cello_work_dir(home_dir, run_id) {
  return home_dir + "/autograder/" + run_id;
}

function get_scalability_tests(ncores) {
  var tests = [];
  var curr_cores = 1;
  while (curr_cores < ncores) {
    tests.push(curr_cores);
    curr_cores = 2 * curr_cores;
  }
  if (curr_cores / 2 != ncores) {
    tests.push(ncores);
  }
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
    asm_jar, rr_agent_jar, rr_runtime_jar, assignment_jvm_args) {
  var slurmFileContents =
    "#!/bin/bash\n" +
    "\n" +
    "#SBATCH --job-name=habanero-autograder-" + run_id + "\n" +
    "#SBATCH --cpus-per-task=" + ncores + "\n" +
    "#SBATCH --exclusive\n" +
    "#SBATCH --nodes=1\n" +
    "#SBATCH --time=00:10:00\n" +
    "#SBATCH --partition=interactive\n" +
    "#SBATCH --output=" + home_dir + "/autograder/" + run_id + "/stdout.txt\n" +
    "#SBATCH --error=" + home_dir + "/autograder/" + run_id + "/stderr.txt\n" +
    "\n" +
    "export CELLO_WORK_DIR=" + get_cello_work_dir(home_dir, run_id) + "\n";
  if (CLUSTER_TYPE === 'slurm') {
    slurmFileContents += "echo Job $SLURM_JOBID\n";
  } else {
    slurmFileContents += "echo Local job\n";
  }
  slurmFileContents += "echo CELLO_WORK_DIR=$CELLO_WORK_DIR\n";

  slurmFileContents += 'mkdir $CELLO_WORK_DIR/submission/student\n';
  slurmFileContents += 'unzip -qq $CELLO_WORK_DIR/submission/student.zip -d $CELLO_WORK_DIR/submission/student/\n';
  slurmFileContents += 'NSTUDENT_FILES=$(ls -l $CELLO_WORK_DIR/submission/student/ | grep -v total | wc -l)\n';
  slurmFileContents += 'NSTUDENT_FILES=${NSTUDENT_FILES//[[:blank:]]/}\n';
  slurmFileContents += 'if [[ $NSTUDENT_FILES != 1 ]]; then\n';
  slurmFileContents += '    echo "Unexpected number of student files: $NSTUDENT_FILES"\n';
  slurmFileContents += '    exit 1\n';
  slurmFileContents += 'fi\n';
  slurmFileContents += 'STUDENT_DIR=$(ls $CELLO_WORK_DIR/submission/student/)\n';

  slurmFileContents += 'mkdir $CELLO_WORK_DIR/assignment/instructor\n';
  slurmFileContents += 'unzip -qq $CELLO_WORK_DIR/assignment/instructor.zip -d $CELLO_WORK_DIR/assignment/instructor/\n';
  slurmFileContents += 'NINSTRUCTOR_FILES=$(ls -l $CELLO_WORK_DIR/assignment/instructor/ | grep -v total | wc -l);\n';
  slurmFileContents += 'NINSTRUCTOR_FILES=${NINSTRUCTOR_FILES//[[:blank:]]/}\n';
  slurmFileContents += 'if [[ $NINSTRUCTOR_FILES != 1 ]]; then\n';
  slurmFileContents += '    echo "Unexpected number of instructor files: $NINSTRUCTOR_FILES"\n';
  slurmFileContents += '    exit 1\n';
  slurmFileContents += 'fi\n';
  slurmFileContents += 'INSTRUCTOR_DIR=$(ls $CELLO_WORK_DIR/assignment/instructor/)\n';

  slurmFileContents += 'cp -r $CELLO_WORK_DIR/assignment/instructor/$INSTRUCTOR_DIR/* $CELLO_WORK_DIR/submission/student/$STUDENT_DIR/\n';
  slurmFileContents += 'cp $CELLO_WORK_DIR/assignment/instructor_pom.xml $CELLO_WORK_DIR/submission/student/$STUDENT_DIR/pom.xml\n';

  slurmFileContents += 'for F in $(find $CELLO_WORK_DIR/submission/student/$STUDENT_DIR/ -name "*CorrectnessTest.java"); do\n';
  slurmFileContents += '    rm $F\n';
  slurmFileContents += 'done\n';
  slurmFileContents += '\n';
  slurmFileContents += 'mvn -f $CELLO_WORK_DIR/submission/student/$STUDENT_DIR/pom.xml clean compile test-compile\n';
  slurmFileContents += 'cd $CELLO_WORK_DIR/submission/student/$STUDENT_DIR\n';

  var remotePolicyPath = '$CELLO_WORK_DIR/security.policy';
  var securityFlags = '-Djava.security.manager -Djava.security.policy==' + remotePolicyPath;
  var tests = get_scalability_tests(ncores);
  var classpath = ['.', 'target/classes', 'target/test-classes', junit_jar,
                   hamcrest_jar, hj_jar, asm_jar];
  for (var i = 0; i < tests.length; i++) {
    var curr_cores = tests[i];
    var output_file = '$CELLO_WORK_DIR/performance.' + curr_cores + '.txt';

    slurmFileContents += 'touch ' + output_file + '\n';
    slurmFileContents += loop_over_all_perf_tests('java ' + securityFlags + ' -Dhj.numWorkers=' +
      curr_cores + ' -javaagent:' + hj_jar + ' -cp ' + classpath.join(':') + ' ' +
      'org.junit.runner.JUnitCore $CLASSNAME >> ' + output_file + ' 2>&1');
  }
  slurmFileContents += '\n';

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
    'doPrint = 0; print $0; } /Total trace count/ { doPrint = 1; } { ' +
    'if (doPrint) print $0; }\' $CELLO_WORK_DIR/traces.txt > ' +
    '$CELLO_WORK_DIR/traces.filtered.txt\n';
  slurmFileContents += 'mv $CELLO_WORK_DIR/traces.filtered.txt ' +
    '$CELLO_WORK_DIR/traces.txt\n';
  slurmFileContents += '\n';
  /*
   * A bug in JDK 8 [1] leads to the FastTrack data race detector crashing on
   * Mac OS.
   *
   * [1] http://bugs.java.com/bugdatabase/view_bug.do?bug_id=8022291
   */
  if (os !== 'Darwin') {
    var rr_output = '$CELLO_WORK_DIR/datarace.txt';
    slurmFileContents += loop_over_all_perf_tests('java ' +
      assignment_jvm_args + ' ' + securityFlags + ' -cp ' +
      classpath.join(':') + ' -Dhj.numWorkers=' + ncores + ' -javaagent:' +
      hj_jar + ' -javaagent:' + rr_agent_jar + ' -Xbootclasspath/p:' +
      rr_runtime_jar + ' rr.RRMain -toolpath= -maxTid=80 -tool=FT_CHECKER ' +
      '-noWarn=+edu.rice.hj.runtime.* -classpath=' + classpath.join(':') +
      ' -maxWarn=20 -quiet org.junit.runner.JUnitCore $CLASSNAME >> ' +
      rr_output + ' 2>&1');
  }

  return slurmFileContents;
}

function failed_starting_perf_tests(res, failure_msg, done, client, run_id) {
  query = client.query(
      "UPDATE runs SET status='FAILED' WHERE run_id=($1)",
      [run_id]);
  query.on('row', function(row, result) { result.addRow(row); }); // unnecessary?
  query.on('error', function(err, result) {
    console.log('Error storing failure starting perf tests: ' + err);
    done();
  });
  query.on('end', function(result) {
    done();
    console.log('Failure initiating performance tests: ' + failure_msg);
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
    console.log('local_run_finished: done_token=' + done_token + ' err_msg="' +
        viola_err_msg + '"');

    pgclient(function(client, done) {
        // Can only be one match here because of SQL schema constraints
        var query = client.query("SELECT * FROM runs WHERE done_token=($1)", [done_token]);
        register_query_helpers(query, res, done, 'unknown');
        query.on('end', function(result) {
          if (result.rows.length != 1) {
            return failed_starting_perf_tests(res, 'Unexpected # of rows', done, client, -1);
          } else {
            var run_id = result.rows[0].run_id;
            var user_id = result.rows[0].user_id;
            var assignment_id = result.rows[0].assignment_id;
            var correctness_only = result.rows[0].correctness_only;
            console.log('local_run_finished: run_id=' + run_id + ' user_id=' +
                user_id + ' assignment_id=' + assignment_id +
                ' correctness_only=' + correctness_only);

            var query = client.query("SELECT * FROM users WHERE user_id=($1)", [user_id]);
            register_query_helpers(query, res, done, 'unknown');
            query.on('end', function(result) {
              if (result.rows.length != 1) {
                return failed_starting_perf_tests(res, 'Invalid user ID', done, client, run_id);
              } else {
                var username = result.rows[0].user_name;
                var run_dir = __dirname + '/submissions/' + username + '/' + run_id;

                svn_client.cmd(['up', '--accept', 'theirs-full', run_dir], function(err, data) {
                  if (err) {
                    return failed_starting_perf_tests(res, 'Failed updating repo', done, client, run_id);
                  }

                  // Update the status of these tests in the 'runs' table for display in the leaderboard
                  var compile_txt = run_dir + '/compile.txt';
                  var checkstyle_txt = run_dir + '/checkstyle.txt';
                  var correct_txt = run_dir + '/correct.txt';
                  var compile_passed = false;
                  var checkstyle_passed = false;
                  var correctness_tests_passed = false;
                   
                  if (fs.existsSync(checkstyle_txt)) {
                      var checkstyle_contents = fs.readFileSync(checkstyle_txt, 'utf8');
                      var checkstyle_new_lines = count_new_lines(checkstyle_contents);
                      checkstyle_passed = (checkstyle_new_lines == 0);
                      if (checkstyle_passed && fs.existsSync(compile_txt)) {
                        var compile_contents = fs.readFileSync(compile_txt, 'utf8');
                        compile_passed = (compile_contents.indexOf('BUILD SUCCESS') != -1);
                        if (compile_passed && fs.existsSync(correct_txt)) {
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
                          correctness_tests_passed = !any_failures;
                        }
                      }
                  }

                  client.query('UPDATE runs SET passed_checkstyle=($1),' +
                      'compiled=($2),passed_all_correctness=($3) WHERE run_id=($4)',
                      [checkstyle_passed, compile_passed, correctness_tests_passed, run_id]);
                  register_query_helpers(query, res, done, 'unknown');
                  query.on('end', function(result) {

                    if (correctness_only) {
                        query = client.query(
                            "UPDATE runs SET status='FINISHED',viola_msg=$1 WHERE run_id=($2)",
                            [viola_err_msg, run_id]);
                        register_query_helpers(query, res, done, 'unknown');
                        query.on('end', function(result) {
                            var subject = 'Habanero AutoGrader Run ' + run_id + ' Finished';
                            send_email(email_for_user(username), subject, '', function(err) {
                              if (err) {
                                return failed_starting_perf_tests(res,
                                  'Failed sending notification e-mail, err=' + err, done, client, run_id);
                              } else {
                                done();
                                return res.send(
                                  JSON.stringify({ status: 'Success' }));
                              }
                            });
                        });
                    } else {
                        connect_to_cluster(function(conn, err) {
                            if (err) {
                              return failed_starting_perf_tests(res,
                                'Error connecting to cluster, err=' + err, done, client, run_id);
                            }

                            get_cluster_cores(conn, function(err, ncores) {
                              if (err) {
                                return failed_starting_perf_tests(res,
                                  'Failed getting ncores from cluster', done, client, run_id);
                              }

                              var query = client.query(
                                  "UPDATE runs SET status='TESTING PERFORMANCE',viola_msg=$1,ncores=$2 WHERE run_id=($3)", [viola_err_msg, ncores, run_id]);
                              register_query_helpers(query, res, done, username);
                              query.on('end', function(result) {
                                  var query = client.query(
                                    "SELECT * FROM assignments WHERE assignment_id=($1)",
                                    [assignment_id]);
                                  register_query_helpers(query, res, done, 'unknown');
                                  query.on('end', function(result) {
                                    var assignment_name = result.rows[0].name; 
                                    var assignment_jvm_args = result.rows[0].jvm_args;

                                    console.log('local_run_finished: Connecting to ' +
                                        CLUSTER_USER + '@' + CLUSTER_HOSTNAME);
                                    // Launch on the cluster

                                    var vars = ['HOME',
                                                'LIGHTWEIGHT_JAVA_PROFILER_HOME',
                                                'JUNIT_JAR', 'HAMCREST_JAR',
                                                'ASM_JAR', 'RR_AGENT_JAR', 'RR_RUNTIME_JAR'];
                                    batched_get_cluster_env_var(vars, conn, function(err, vals) {
                                      if (err) {
                                        return failed_starting_perf_tests(res,
                                          'Error getting cluster env variables, err=' + err, done, client, run_id);
                                      }

                                      var home_dir = vals['HOME'];
                                      var java_profiler_dir = vals['LIGHTWEIGHT_JAVA_PROFILER_HOME'];
                                      var rr_agent_jar = vals['RR_AGENT_JAR'];
                                      var rr_runtime_jar = vals['RR_RUNTIME_JAR'];

                                      var cello_work_dir = get_cello_work_dir(home_dir, run_id);
                                      var submission_checkout = 'svn checkout ' +
                                        '--username ' + SVN_USERNAME +
                                        ' --password ' + SVN_PASSWORD + ' ' +
                                        SVN_REPO + '/' + username + '/' +
                                        assignment_name + '/' + run_id + ' ' +
                                        cello_work_dir + '/submission';
                                      var assignment_checkout = 'svn checkout ' +
                                        '--username ' + SVN_USERNAME +
                                        ' --password ' + SVN_PASSWORD + ' ' +
                                        SVN_REPO + '/assignments/' +
                                        assignment_id + ' ' + cello_work_dir +
                                        '/assignment';
                                      var dependency_list_cmd = 'mvn -f ' +
                                          cello_work_dir +
                                          '/assignment/instructor_pom.xml ' +
                                          '-DoutputAbsoluteArtifactFilename=true ' +
                                          'dependency:list';
                                      var localPolicyPath = AUTOGRADER_HOME + '/shared/security.policy';

                                      var junit = vals['JUNIT_JAR'];
                                      var hamcrest = vals['HAMCREST_JAR'];
                                      var asm = vals['ASM_JAR'];

                                      get_cluster_os(conn, function(err, os) {
                                        if (err) {
                                          return failed_starting_perf_tests(res,
                                            'Failed getting cluster OS', done, client, run_id);
                                        }

                                        create_cluster_dir('autograder/' + run_id, conn,
                                            function(err, conn, stdout, stderr) {
                                              if (err) {
                                                return failed_starting_perf_tests(res,
                                                  'Failed creating autograder dir', done, client, run_id);
                                              }
                                              run_cluster_cmd(conn, 'submission checkout', submission_checkout,
                                                function(err, conn, stdout, stderr) {
                                                  if (err) {
                                                    return failed_starting_perf_tests(res,
                                                         'Failed checking out student code', done, client, run_id);
                                                  }
                                                  run_cluster_cmd(conn, 'assignment checkout', assignment_checkout,
                                                    function(err, conn, stdout, stderr) {
                                                      if (err) {
                                                        return failed_starting_perf_tests(res,
                                                              'Failed checking out assignment code', done, client, run_id);
                                                      }
                                                      run_cluster_cmd(conn, 'get dependencies', dependency_list_cmd,
                                                        function(err, conn, stdout, stderr) {
                                                          if (err) {
                                                            return failed_starting_perf_tests(res, 'Failed getting dependencies', done, client, run_id);
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
                                                            return failed_starting_perf_tests(res, 'Unable to find HJ JAR on cluster', done, client, run_id);
                                                          }


                                                          fs.appendFileSync(run_dir + '/cello.slurm',
                                                            get_slurm_file_contents(run_id, home_dir,
                                                              username, assignment_id, assignment_name,
                                                              java_profiler_dir, os, ncores, junit,
                                                              hamcrest, hj, asm, rr_agent_jar, rr_runtime_jar,
                                                              assignment_jvm_args));

                                                          var copies = [{src: run_dir + '/cello.slurm',
                                                                         dst: 'autograder/' + run_id + '/cello.slurm'},
                                                                        {src: localPolicyPath,
                                                                         dst: 'autograder/' + run_id + '/security.policy'}];
                                                          batched_cluster_scp(copies, true, function(stat) {
                                                              for (var i = 0; i < stat.length; i++) {
                                                                if (!stat[i].success) {
                                                                  console.log('scp err copying to ' + stat[i].dst + ', ' + stat[i].err);
                                                                  return failed_starting_perf_tests(res,
                                                                    'Failed scp-ing cello.slurm+security.policy', done, client, run_id);
                                                                }
                                                              }

                                                              if (CLUSTER_TYPE === 'slurm') {
                                                                  run_cluster_cmd(conn, 'sbatch',
                                                                      'sbatch ~/autograder/' + run_id + '/cello.slurm',
                                                                      function(err, conn, stdout, stderr) {
                                                                          if (err) {
                                                                            return failed_starting_perf_tests(res,
                                                                              'Failed submitting job', done, client, run_id);
                                                                          }
                                                                          disconnect_from_cluster(conn);
                                                                          // stdout == Submitted batch job 474297
                                                                          if (stdout.search('Submitted batch job ') !== 0) {
                                                                              return failed_starting_perf_tests(res,
                                                                                      'Failed submitting batch job', done, client, run_id);
                                                                          }

                                                                          // Close connection to outermost DB connection
                                                                          done();

                                                                          var tokens = stdout.trim().split(' ');
                                                                          var job_id = tokens[tokens.length - 1];
                                                                          pgclient(function(client, done) {
                                                                              var query = client.query('UPDATE runs SET job_id=($1) WHERE run_id=($2)', [job_id, run_id]);
                                                                              register_query_helpers(query, res, done, username);
                                                                              query.on('end', function(result) {
                                                                                  done();
                                                                                  return res.send(
                                                                                      JSON.stringify({ status: 'Success' }));
                                                                              });
                                                                          });
                                                                      });
                                                              } else {
                                                                // local cluster
                                                                var cello_script = process.env.HOME + '/autograder/' + run_id + '/cello.slurm';
                                                                console.log('local_run_finished: starting local run from ' + cello_script);
                                                                var run_cmd = '/bin/bash ' + cello_script;

                                                                run_cluster_cmd(conn, 'local perf run', run_cmd,
                                                                    function(err, conn, stdout, stderr) {

                                                                      fs.appendFileSync(process.env.HOME + '/autograder/' + run_id + '/stdout.txt', stdout);
                                                                      fs.appendFileSync(process.env.HOME + '/autograder/' + run_id + '/stderr.txt', stderr);

                                                                      if (err) {
                                                                        return failed_starting_perf_tests(res,
                                                                          'Failed running on local cluster', done, client, run_id);
                                                                      }

                                                                      // Close connection to outermost DB connection
                                                                      done();

                                                                      pgclient(function(client, done) {
                                                                          var query = client.query('UPDATE runs SET job_id=($1) WHERE run_id=($2)', [LOCAL_JOB_ID, run_id]);
                                                                          register_query_helpers(query, res, done, username);
                                                                          query.on('end', function(result) {
                                                                              done();

                                                                              return res.send(
                                                                                  JSON.stringify({ status: 'Success' }));
                                                                          });
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
                            });
                        });
                    }
                  });
                });
              }
            });
          }
        });
    });
});

app.get('/anonymous_runs', function(req, res, next) {
  var assignment_name = req.query.assignment_name;

  pgclient(function(client, done) {
    var query = client.query("SELECT assignment_id FROM assignments WHERE name=($1)", [assignment_name]);
    register_query_helpers(query, res, done, req.session.username);
    query.on('end', function(result) {
      if (result.rows.length != 1) {
        done();
        return res.send(JSON.stringify({ status: 'Failure', msg: "That assignment name doesn't seem to exist" }));
      }
      var assignment_id = result.rows[0].assignment_id;

      var query = client.query(
          "SELECT run_id,status,passed_checkstyle,compiled,passed_all_correctness " +
          "FROM runs WHERE assignment_id=($1) ORDER BY run_id DESC",
          [assignment_id]);
      register_query_helpers(query, res, done, req.session.username);
      query.on('end', function(result) {
        done();

        return res.send(JSON.stringify({ status: 'Success', runs: result.rows }));
      });

    });
  });
});

app.get('/runs', function(req, res, next) {
  pgclient(function(client, done) {
    get_user_id_for_name(req.session.username, client, done, res,
      function(user_id, err) {
        if (err) {
          done();
          return res.send(JSON.stringify({ status: 'Failure', msg: err }));
        } else {
          var query = client.query(
              "SELECT * FROM runs WHERE user_id=($1) ORDER BY run_id DESC",
              [user_id]);
          register_query_helpers(query, res, done, req.session.username);
          query.on('end', function(result) {
            var runs = result.rows;

            var query = client.query("SELECT * FROM assignments");
            register_query_helpers(query, res, done, req.session.username);
            query.on('end', function(result) {
                done();
                var assignment_mapping = {};
                for (var i = 0; i < result.rows.length; i++) {
                    assignment_mapping[result.rows[i].assignment_id] = result.rows[i].name;
                }
                var translated_runs = [];
                for (var i = 0; i < runs.length; i++) {
                    var name = assignment_mapping[runs[i].assignment_id];
                    translated_runs.push({run_id: runs[i].run_id,
                                          assignment_name: name,
                                          status: runs[i].status });
                }
                return res.send(JSON.stringify({ status: 'Success', runs: translated_runs }));
            });
          });
        }
      });
  });
});

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
  if (split.length != 3 || isNaN(split[0]) || isNaN(split[1]) || isNaN(split[2])) {
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

  for (var c = 0; c < rubric.correctness.length; c++) {
    if (!rubric.correctness[c].hasOwnProperty('testname')) {
      return failed_validation('Correctness test is missing name');
    }
    if (!rubric.correctness[c].hasOwnProperty('points_worth') ||
        rubric.correctness[c].points_worth < 0.0) {
      return failed_validation('Correctness test is missing valid points_worth');
    }
  }

  for (var p = 0; p < rubric.performance.length; p++) {
    if (!rubric.performance[p].hasOwnProperty('testname')) {
      return failed_validation('Performance test is missing name');
    }
    if (!rubric.performance[p].hasOwnProperty('points_worth')) {
      return failed_validation('Performance test is missing points_worth');
    }
    var points_worth = rubric.performance[p].points_worth;
    if (!rubric.performance[p].hasOwnProperty('grading')) {
      return failed_validation('Performance test is missing speedup grading');
    }

    for (var g = 0; g < rubric.performance[p].grading.length; g++) {
      if (!rubric.performance[p].grading[g].hasOwnProperty('bottom_inclusive')) {
        return failed_validation('Performance test grading is missing bottom_inclusive');
      }
      if (!rubric.performance[p].grading[g].hasOwnProperty('top_exclusive')) {
        return failed_validation('Performance test grading is missing top_exclusive');
      }
      if (!rubric.performance[p].grading[g].hasOwnProperty('points_off')) {
        return failed_validation('Performance test grading is missing points_off');
      }
      if (rubric.performance[p].grading[g].points_off > points_worth) {
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
  for (var p = 0; p < rubric.performance.length; p++) {
    if (rubric.performance[p].testname === name) {
      return rubric.performance[p];
    }
  }
  return null;
}

function calculate_score(assignment_id, log_files, ncores) {
  var rubric_file = __dirname + '/instructor-tests/' + assignment_id + '/rubric.json';

  var validated = load_and_validate_rubric(rubric_file);
  if (!validated.success) {
    return null;
  }
  var rubric = validated.rubric;

  var total_possible = 0.0;
  var total_correctness_possible = 0.0;
  for (var c = 0; c < rubric.correctness.length; c++) {
    var t = rubric.correctness[c];
    total_possible += t.points_worth;
    total_correctness_possible += t.points_worth;
  }
  var total_performance_possible = 0.0;
  for (var p = 0; p < rubric.performance.length; p++) {
    var t = rubric.performance[p];
    total_possible += t.points_worth;
    total_performance_possible += t.points_worth;
  }
  total_possible += rubric.style.max_points_off;

  // Compute correctness score based on test failures
  var correctness = total_correctness_possible;
  if ('correct.txt' in log_files) {
    var content = log_files['correct.txt'].toString('utf8');
    var lines = content.split('\n');

    /*
     * First check if anything was printed to STDERR. This may indicate anything
     * (from harmless prints by the student, to OutOfMemoryException) so we
     * conservatively give zero points if STDERR is non-empty.
     */
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

    if (any_nonempty_lines) {
      correctness = 0.0;
    } else {
      var failure_counts = [];
      var failures_message_found = false;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
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
        correctness = 0.0;
      } else {
        var line_index = 0;
        for (var i = 0; i < failure_counts.length; i++) {
          var current_failure_count = failure_counts[i];
          for (var failure = 1; failure <= current_failure_count; failure++) {
            while (line_index < lines.length && !string_starts_with(lines[line_index], failure + ') ')) {
              line_index++;
            }

            if (line_index < lines.length && string_starts_with(lines[line_index], failure + ') ')) {
              var junit_testname = lines[line_index].split(' ')[1];
              var test_tokens = junit_testname.split('(');
              var testname = test_tokens[0];
              var classname = test_tokens[1].substring(0, test_tokens[1].length - 1);
              var fullname = classname + '.' + testname;

              var test = find_correctness_test_with_name(fullname, rubric);
              if (test) {
                console.log('calculate_score: taking off ' + test.points_worth +
                    ' points for test ' + test.testname);
                correctness -= test.points_worth;
              }
            }
          }
        }
      }
    }
  } else {
    correctness = 0.0;
  }

  // Compute performance score based on performance of each test
  var performance = total_performance_possible;
  if ('performance.1.txt' in log_files && 'performance.' + ncores + '.txt' in log_files) {
    var single_thread_content = log_files['performance.1.txt'].toString('utf8');
    var multi_thread_content = log_files['performance.' + ncores + '.txt'].toString('utf8');

    var single_thread_lines = single_thread_content.split('\n');
    var multi_thread_lines = multi_thread_content.split('\n');

    var single_thread_perf = {};
    for (var i = 0; i < single_thread_lines.length; i++) {
      var line = single_thread_lines[i];
      if (string_starts_with(line, 'HABANERO-AUTOGRADER-PERF-TEST')) {
        var tokens = line.split(' ');
        var testname = tokens[2];
        var t = parseInt(tokens[3]);
        single_thread_perf[testname] = t;
      }
    }

    for (var i = 0; i < multi_thread_lines.length; i++) {
      var line = multi_thread_lines[i];
      if (string_starts_with(line, 'HABANERO-AUTOGRADER-PERF-TEST')) {
        var tokens = line.split(' ');
        var testname = tokens[2];
        var t = parseInt(tokens[3]);

        if (testname in single_thread_perf) {
          var test = find_performance_test_with_name(testname, rubric);
          if (test) {
            var single_thread_time = single_thread_perf[testname];
            var multi_thread_time = t;
            var speedup = single_thread_time / multi_thread_time;
            var grading = test.grading;
            var matched = false;
            for (var g = 0; g < grading.length && !matched; g++) {
              var top_exclusive = grading[g].top_exclusive;
              if (grading[g].bottom_inclusive <= speedup &&
                  (top_exclusive < 0.0 || top_exclusive > speedup)) {
                matched = true;
                performance -= grading[g].points_off;
              }
            }
          }
        }
      }
    }
  } else {
    performance = 0.0;
  }

  // Compute style score based on number of style violations
  var style = rubric.style.max_points_off;
  if ('checkstyle.txt' in log_files) {
    var content = log_files['checkstyle.txt'].toString('utf8');
    var lines = content.split('\n');

    var iter = 0;
    while (iter < lines.length && !string_starts_with(lines[iter], 'Starting audit')) {
        iter++;
    }
    iter++;
    var errorCount = 0;
    while (iter < lines.length && !string_starts_with(lines[iter], 'Audit done')) {
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
                      ]}
}

app.get('/run/:run_id', function(req, res, next) {
    var run_id = req.params.run_id;
    console.log('run: run_id=' + run_id);

    pgclient(function(client, done) {
        var query = client.query("SELECT * FROM runs WHERE run_id=($1)",
            [run_id]);
        register_query_helpers(query, res, done, req.session.username);
        query.on('end', function(result) {
            if (result.rows.length == 0) {
                done();
                return res.render('overview.html', { err_msg: 'Unknown run' });
            }
            var user_id = result.rows[0].user_id;
            var assignment_id = result.rows[0].assignment_id;
            var viola_err_msg = result.rows[0].viola_msg;
            var ncores = result.rows[0].ncores; 
            var passed_checkstyle = result.rows[0].passed_checkstyle;
            var compiled = result.rows[0].compiled;
            var passed_all_correctness = result.rows[0].passed_all_correctness;

            if (!req.session.is_admin && user_id != req.session.user_id) {
                done();
                return res.send(401);
            }
            var query = client.query("SELECT * FROM users WHERE user_id=($1)", [user_id]);
            register_query_helpers(query, res, done, req.session.username);
            query.on('end', function(result) {
                done();

                var username = result.rows[0].user_name;
                var run_dir = __dirname + '/submissions/' +
                    username + '/' + run_id;
                /*
                 * If bugs cause submissions to fail, their storage may not exist.
                 * This shouldn't happen in a bugless AutoGrader.
                 */
                if (!fs.existsSync(run_dir)) {
                  var render_vars = { run_id: run_id };
                  return res.render('missing_run.html', render_vars);
                } else {
                  var log_files = {};
                  fs.readdirSync(run_dir).forEach(function(file) {
                    if (file.indexOf('.txt', file.length - '.txt'.length) !== -1 &&
                          !arr_contains(file, dont_display)) {
                        log_files[file] = fs.readFileSync(run_dir + '/' + file);
                    }
                  });

                  var score = calculate_score(assignment_id, log_files, ncores);
                  var render_vars = { run_id: run_id, log_files: log_files, viola_err: viola_err_msg,
                                      passed_checkstyle: passed_checkstyle,
                                      compiled: compiled,
                                      passed_all_correctness: passed_all_correctness };
                  if (score) {
                    render_vars['score'] = score;
                  } else {
                    render_vars['err_msg'] = 'Error calculating score';
                  }

                  return res.render('run.html', render_vars);
                }
            });
        });
    });
});

app.get('/', function(req, res, next) {
  return res.redirect('overview');
});

function abort_and_reset_perf_tests(err, done, conn, lbl) {
  console.log(lbl + ' err=' + err);
  done();
  disconnect_from_cluster(conn);
  setTimeout(check_cluster, CHECK_CLUSTER_PERIOD);
}

function finish_perf_tests(query, run, conn, done, client, perf_runs, i) {
    query.on('row', function(row, result) { result.addRow(row); });
    query.on('error', function(err, result) {
            console.log('Error updating running perf tests: ' + err);
            done();
            disconnect_from_cluster(conn);
            setTimeout(check_cluster, CHECK_CLUSTER_PERIOD);
    });
    query.on('end', function(result) {
      var query = client.query(
        'SELECT * FROM users WHERE user_id=($1)', [run.user_id]);
      query.on('row', function(row, result) { result.addRow(row); });
      query.on('error', function(err, result) {
              console.log('Error finding user name: ' + err);
              done();
              disconnect_from_cluster(conn);
              setTimeout(check_cluster, CHECK_CLUSTER_PERIOD);
      });
      query.on('end', function(result) {
        if (result.rows.length != 1) {
          console.log('Missing user, user_id=' + run.user_id);
          done();
          disconnect_from_cluster(conn);
          setTimeout(check_cluster, CHECK_CLUSTER_PERIOD);
        } else {
          var username = result.rows[0].user_name;
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

            get_cluster_os(conn, function(err, os) {
              if (err) {
                return abort_and_reset_perf_tests(err, done, conn, 'OS');
              }

              var copies = [{ src: REMOTE_STDOUT, dst: LOCAL_STDOUT },
                            { src: REMOTE_STDERR, dst: LOCAL_STDERR },
                            { src: REMOTE_PROFILER, dst: LOCAL_PROFILER },
                            { src: REMOTE_TRACES, dst: LOCAL_TRACES }];
              if (os !== 'Darwin') {
                copies.push({ src: REMOTE_DATARACE, dst: LOCAL_DATARACE });
              }

              var tests = get_scalability_tests(run.ncores);
              for (var i = 0; i < tests.length; i++) {
                var curr_cores = tests[i];
                var local = LOCAL_FOLDER + '/performance.' + curr_cores + '.txt';
                var remote = REMOTE_FOLDER + '/performance.' + curr_cores + '.txt';

                copies.push({ src: remote, dst: local });
              }

              batched_cluster_scp(copies, false, function(stat) {
                var svn_add_cmd = ['add'];
                for (var i = 0; i < stat.length; i++) {
                  if (stat[i].success) {
                    svn_add_cmd.push(stat[i].dst);
                  } else {
                    console.log('scp err copying to ' + stat[i].dst + ', err=' +
                      stat[i].err);
                  }
                }

                if (svn_add_cmd.length === 1) {
                  // No successful copies
                  return abort_and_reset_perf_tests(err, done, conn, 'svn-add');
                }

                delete_cluster_dir('autograder/' + run.run_id, conn,
                  function(err, conn, stdout, stderr) {
                    if (err) {
                      return abort_and_reset_perf_tests(err, done, conn, 'delete');
                    }
                    svn_client.cmd(svn_add_cmd, function(err, data) {
                      if (err) {
                        return abort_and_reset_perf_tests(err, done, conn,
                          'adding local files');
                      }
                      svn_client.cmd(['commit', '--message', 'add local files',
                        LOCAL_FOLDER],
                        function(err, data) {
                          if (err) {
                            return abort_and_reset_perf_tests(err, done, conn,
                              'committing local files');
                          }

                          var email = username + '@rice.edu';
                          if (username === 'admin') {
                            email = 'jmg3@rice.edu';
                          }
                          var subject = 'Habanero AutoGrader Run ' + run.run_id + ' Finished';
                          send_email(email_for_user(username), subject, '', function(err) {
                            if (err) {
                              return abort_and_reset_perf_tests(err, done, conn,
                                'sending notification email');
                            }
                            check_cluster_helper(perf_runs, i + 1, conn, client, done);
                          });
                        });
                    });
                  });
                });
            });
        }
      });

    });
}

function check_cluster_helper(perf_runs, i, conn, client, done) {
    if (i >= perf_runs.length) {
        done();
        disconnect_from_cluster(conn);
        setTimeout(check_cluster, CHECK_CLUSTER_PERIOD);
    } else {
        var run = perf_runs[i];
        console.log('check_cluster_helper: ' + JSON.stringify(run));

        if (CLUSTER_TYPE === 'slurm') {
            var SACCT = "sacct --noheader -j " + run.job_id + " -u jmg3 " +
                "--format=JobName,State | grep hab | awk '{ print $2 }'";
            run_cluster_cmd(conn, 'checking job status', SACCT, function(err, conn, stdout, stderr) {
                if (err) {
                  done();
                  disconnect_from_cluster(conn);
                  setTimeout(check_cluster, CHECK_CLUSTER_PERIOD);
                  return;
                }
                stdout = stdout.trim();

                var query = null;
                if (stdout === 'FAILED' || stdout === 'TIMEOUT' || stdout == 'CANCELLED+') {
                    console.log('check_cluster_helper: marking ' + run.run_id + ' FAILED');
                    query = client.query(
                        "UPDATE runs SET status='FAILED' WHERE run_id=($1)",
                        [run.run_id]);
                } else if (stdout === 'COMPLETED') {
                    console.log('check_cluster_helper: marking ' + run.run_id + ' FINISHED');
                    query = client.query(
                        "UPDATE runs SET status='FINISHED' WHERE run_id=($1)",
                        [run.run_id]);
                }

                if (query) {
                  finish_perf_tests(query, run, conn, done, client, perf_runs, i);
                } else {
                  check_cluster_helper(perf_runs, i + 1, conn, client, done);
                }
            });
        } else {
            if (run.job_id !== LOCAL_JOB_ID) {
                console.log('Unexpected job_id "' + run.job_id + '" for local cluster');
                check_cluster_helper(perf_runs, i + 1, conn, client, done);
            } else {
                console.log('check_cluster_helper: marking ' + run.run_id + ' FINISHED');
                var query = client.query(
                    "UPDATE runs SET status='FINISHED' WHERE run_id=($1)",
                    [run.run_id]);
                finish_perf_tests(query, run, conn, done, client, perf_runs, i);
            }
        }
    }
}

// Cluster functionality
function check_cluster() {
    pgclient(function(client, done) {
        var query = client.query("SELECT * FROM runs WHERE status='TESTING PERFORMANCE'");
        query.on('row', function(row, result) { result.addRow(row); });
        query.on('error', function(err, result) {
                done();
                console.log('Error looking up running perf tests: ' + err);
                setTimeout(check_cluster, CHECK_CLUSTER_PERIOD);
        });
        query.on('end', function(result) {

            var perf_runs = result.rows;
            connect_to_cluster(function(conn, err) {
                if (err) {
                  console.log('Error connecting to cluster with ' +
                    CLUSTER_USER + '@' + CLUSTER_HOSTNAME + ', err=' + err);
                  done();
                  setTimeout(check_cluster, CHECK_CLUSTER_PERIOD);
                } else {
                  check_cluster_helper(perf_runs, 0, conn, client, done);
                }
            });
        });
    });
}

pgclient(function(client, done) {
  /*
   * Mark any in-progress tests as failed on reboot.
   */
  var query = client.query("UPDATE runs SET status='FAILED' WHERE " +
    "status='TESTING CORRECTNESS' OR status='TESTING PERFORMANCE'");
  query.on('row', function(row, result) { result.addRow(row); });
  query.on('error', function(err, result) {
    done();
    console.log('Error on initial cleanup, err=' + err);
    process.exit(1);
  });
  query.on('end', function(result) {
    done();

    setTimeout(check_cluster, 0);

    var port = process.env.PORT || 8000;

    var oneDay = 86400000;
    app.use(express.static(__dirname + '/views', { maxAge: oneDay }));

    var server = app.listen(port, function() {
      console.log('Server listening at http://%s:%s', 
        server.address().address,
        server.address().port);
    });
  });
});
