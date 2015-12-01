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

var permissionDenied = 'Permission denied. But you should shoot me an e-mail at jmaxg3@gmail.com. If you like playing around with systems, we have interesting research for you in the Habanero group.';

var upload = multer({ dest: 'uploads/' });

var KEEP_CLUSTER_DIRS = true;
var VERBOSE = false;

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
  pg.connect(conString, function(err, client, done) {
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
        readyTimeout: 120000
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

function batched_cluster_scp_helper(pair_index, file_pairs, is_upload, cb) {
  if (pair_index >= file_pairs.length) {
    return cb(null);
  }

  cluster_scp(file_pairs[pair_index].src, file_pairs[pair_index].dst, is_upload,
      function(err) {
        if (err) {
          return cb(err);
        } else {
          return batched_cluster_scp_helper(pair_index + 1, file_pairs, is_upload, cb);
        }
      });
}

function batched_cluster_scp(file_pairs, is_upload, cb) {
  return batched_cluster_scp_helper(0, file_pairs, is_upload, cb);
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

  console.log('login: username=' + username + ' password=' + password);

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
    res.locals.username = null;
    res.locals.is_admin = false;

    res.redirect('/login');
  }
});

app.get('/overview', function(req, res, next) {
  res.render('overview.html');
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
                              { name: 'zip', maxCount: 1},
                              { name: 'instructor_pom', maxCount: 1}
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

    pgclient(function(client, done) {
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

                        svn_client.cmd(['add',
                          assignment_dir + '/instructor.zip',
                          assignment_dir + '/instructor_pom.xml'], function(err, data) {
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
    return res.send(JSON.stringify({ status: 'Failure', msg: permissionDenied }));
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

app.post('/upload_zip/:assignment_id', upload.single('zip'), function(req, res, next) {
  console.log('upload_zip: is_admin=' + req.session.is_admin);
  return handle_reupload(req, res, 'Please provide a ZIP', 'instructor.zip');
});

app.post('/upload_instructor_pom/:assignment_id', upload.single('pom'), function(req, res, next) {
  console.log('upload_instructor_pom: is_admin=' + req.session.is_admin);
  return handle_reupload(req, res, 'Please provide an instructor pom.xml', 'instructor_pom.xml');
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
              crypto.randomBytes(48, function(ex, buf) {
                  var done_token = buf.toString('hex');

                  var query = client.query("INSERT INTO runs (user_id, " +
                      "assignment_id, done_token, status) VALUES " +
                      "($1,$2,$3,'TESTING CORRECTNESS') RETURNING run_id",
                      [user_id, assignment_id, done_token]);
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
                                        run_id + '&assignment_id=' + assignment_id;
                                    var viola_options = { host: VIOLA_HOST,
                                        port: VIOLA_PORT, path: '/run?' + viola_params };
                                    http.get(viola_options, function(viola_res) {
                                        var bodyChunks = [];
                                        viola_res.on('data', function(chunk) {
                                            bodyChunks.push(chunk);
                                        }).on('end', function() {
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
    asm_jar, rr_agent_jar, rr_runtime_jar) {
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

  var tests = get_scalability_tests(ncores);
  var classpath = ['.', 'target/classes', 'target/test-classes', junit_jar,
                   hamcrest_jar, hj_jar, asm_jar];
  for (var i = 0; i < tests.length; i++) {
    var curr_cores = tests[i];
    var output_file = '$CELLO_WORK_DIR/performance.' + curr_cores + '.txt';

    slurmFileContents += 'touch ' + output_file + '\n';
    slurmFileContents += loop_over_all_perf_tests('java -Dhj.numWorkers=' +
      curr_cores + ' -javaagent:' + hj_jar + ' -cp ' + classpath.join(':') + ' ' +
      'org.junit.runner.JUnitCore $CLASSNAME >> ' + output_file + ' 2>&1');
  }
  slurmFileContents += '\n';

  var profiler_output = '$CELLO_WORK_DIR/profiler.txt';
  slurmFileContents += 'touch ' + profiler_output + '\n';
  slurmFileContents += loop_over_all_perf_tests(
    'java -Dhj.numWorkers=' + ncores +
    ' -agentpath:' + java_profiler_dir + '/build-64/liblagent.so ' +
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
    slurmFileContents += loop_over_all_perf_tests('java -cp ' +
      classpath.join(':') + ' -Dhj.numWorkers=' + ncores + ' -javaagent:' +
      hj_jar + ' -javaagent:' + rr_agent_jar + ' -Xbootclasspath/p:' +
      rr_runtime_jar + ' rr.RRMain -toolpath= -maxTid=80 -tool=FT_CHECKER ' +
      '-noWarn=+edu.rice.hj.runtime.* -classpath=' + classpath.join(':') +
      ' -maxWarn=20 -quiet org.junit.runner.JUnitCore $CLASSNAME >> ' +
      rr_output + ' 2>&1');
  }

  return slurmFileContents;
}

function failed_starting_perf_tests(res, failure_msg) {
  console.log('Failure initiating performance tests: ' + failure_msg);
  return res.send(JSON.stringify({status: 'Failure', msg: failure_msg}));
}

app.post('/local_run_finished', function(req, res, next) {
    var done_token = req.body.done_token;
    console.log('local_run_finished: done_token=' + done_token);

    pgclient(function(client, done) {
        // Can only be one match here because of SQL schema constraints
        var query = client.query("SELECT * FROM runs WHERE done_token=($1)", [done_token]);
        register_query_helpers(query, res, done, 'unknown');
        query.on('end', function(result) {
          if (result.rows.length != 1) {
            done();
            return failed_starting_perf_tests(res, 'Unexpected # of rows');
          } else {
            var run_id = result.rows[0].run_id;
            var user_id = result.rows[0].user_id;
            var assignment_id = result.rows[0].assignment_id;

            var query = client.query("SELECT * FROM users WHERE user_id=($1)", [user_id]);
            register_query_helpers(query, res, done, 'unknown');
            query.on('end', function(result) {
              if (result.rows.length != 1) {
                done();
                return failed_starting_perf_tests(res, 'Invalid user ID');
              } else {
                var username = result.rows[0].user_name;
                var run_dir = __dirname + '/submissions/' + username + '/' + run_id;

                var query = client.query(
                    "UPDATE runs SET status='TESTING PERFORMANCE' WHERE run_id=($1)", [run_id]);
                register_query_helpers(query, res, done, username);
                query.on('end', function(result) {
                    var query = client.query(
                      "SELECT * FROM assignments WHERE assignment_id=($1)",
                      [assignment_id]);
                    register_query_helpers(query, res, done, 'unknown');
                    query.on('end', function(result) {
                      var assignment_name = result.rows[0].name;
                      done();

                      svn_client.cmd(['up', '--accept', 'theirs-full', run_dir], function(err, data) {
                        if (err) {
                          return failed_starting_perf_tests(res, 'Failed updating repo');
                        } else {
                          console.log('local_run_finished: Connecting to ' +
                              CLUSTER_USER + '@' + CLUSTER_HOSTNAME);
                          // Launch on the cluster
                          connect_to_cluster(function(conn, err) {
                              if (err) {
                                return failed_starting_perf_tests(res,
                                  'Error connecting to cluster, err=' + err);
                              }

                              var vars = ['HOME',
                                          'LIGHTWEIGHT_JAVA_PROFILER_HOME',
                                          'JUNIT_JAR', 'HAMCREST_JAR', 'HJ_JAR',
                                          'ASM_JAR', 'RR_AGENT_JAR', 'RR_RUNTIME_JAR'];
                              batched_get_cluster_env_var(vars, conn, function(err, vals) {
                                if (err) {
                                  return failed_starting_perf_tests(res,
                                    'Error getting cluster env variables, err=' + err);
                                }

                                var home_dir = vals['HOME'];
                                var java_profiler_dir = vals['LIGHTWEIGHT_JAVA_PROFILER_HOME'];
                                var junit = vals['JUNIT_JAR'];
                                var hamcrest = vals['HAMCREST_JAR'];
                                var hj = vals['HJ_JAR'];
                                var asm = vals['ASM_JAR'];
                                var rr_agent_jar = vals['RR_AGENT_JAR'];
                                var rr_runtime_jar = vals['RR_RUNTIME_JAR'];

                                get_cluster_cores(conn, function(err, ncores) {
                                  if (err) {
                                    return failed_starting_perf_tests(res,
                                      'Failed getting ncores from cluster');
                                  }

                                  get_cluster_os(conn, function(err, os) {
                                    if (err) {
                                      return failed_starting_perf_tests(res,
                                        'Failed getting cluster OS');
                                    }

                                    fs.appendFileSync(run_dir + '/cello.slurm',
                                      get_slurm_file_contents(run_id, home_dir,
                                        username, assignment_id, assignment_name,
                                        java_profiler_dir, os, ncores, junit,
                                        hamcrest, hj, asm, rr_agent_jar, rr_runtime_jar));

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

                                    create_cluster_dir('autograder/' + run_id, conn,
                                        function(err, conn, stdout, stderr) {
                                          if (err) {
                                            return failed_starting_perf_tests(res,
                                              'Failed creating autograder dir');
                                          }
                                          cluster_scp(run_dir + '/cello.slurm',
                                            'autograder/' + run_id + '/cello.slurm', true, function(err) {
                                              if (err) {
                                                console.log('scp err=' + err);
                                                return failed_starting_perf_tests(res,
                                                  'Failed scp-ing cello.slurm');
                                              }

                                              run_cluster_cmd(conn, 'submission checkout', submission_checkout,
                                                function(err, conn, stdout, stderr) {
                                                  if (err) {
                                                    return failed_starting_perf_tests(res,
                                                         'Failed checking out student code');
                                                  }

                                                  run_cluster_cmd(conn, 'assignment checkout', assignment_checkout,
                                                    function(err, conn, stdout, stderr) {
                                                      if (err) {
                                                        return failed_starting_perf_tests(res,
                                                              'Failed checking out assignment code');
                                                      }

                                                      if (CLUSTER_TYPE === 'slurm') {
                                                          run_cluster_cmd(conn, 'sbatch',
                                                              'sbatch ~/autograder/' + run_id + '/cello.slurm',
                                                              function(err, conn, stdout, stderr) {
                                                                  if (err) {
                                                                    return failed_starting_perf_tests(res,
                                                                      'Failed submitting job');
                                                                  }
                                                                  disconnect_from_cluster(conn);
                                                                  // stdout == Submitted batch job 474297
                                                                  if (stdout.search('Submitted batch job ') !== 0) {
                                                                      return failed_starting_perf_tests(res,
                                                                              'Failed submitting batch job');
                                                                  }
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
                                                                  'Failed running on local cluster');
                                                              }

                                                              pgclient(function(client, done) {
                                                                  var query = client.query('UPDATE runs SET job_id=($1) WHERE run_id=($2)', ['LOCAL', run_id]);
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
                        }
                      });
                    });
                });
              }
            });
          }
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

var dont_display = ['cluster-stderr.txt', 'cluster-stdout.txt', 'profiler.txt'];

function arr_contains(target, arr) {
  for (var i = 0; i < arr.length; i++) {
    if (target === arr[i]) {
      return true;
    }
  }
  return false;
}

app.get('/run/:run_id', function(req, res, next) {
    var run_id = req.params.run_id;
    pgclient(function(client, done) {
        var query = client.query("SELECT user_id FROM runs WHERE run_id=($1)",
            [run_id]);
        register_query_helpers(query, res, done, req.session.username);
        query.on('end', function(result) {
            done();
            if (result.rows.length == 0) {
                return res.render('overview.html', { err_msg: 'Unknown run' });
            } else {
                var user_id = result.rows[0].user_id;
                if (user_id != req.session.user_id) {
                    return res.send(401);
                } else {
                    var run_dir = __dirname + '/submissions/' +
                        req.session.username + '/' + run_id;
                    var log_files = {};
                    fs.readdirSync(run_dir).forEach(function(file) {
                      if (file.indexOf('.txt', file.length - '.txt'.length) !== -1 && !arr_contains(file, dont_display)) {
                          log_files[file] = fs.readFileSync(run_dir + '/' + file);
                      }
                    });

                    return res.render('run.html', { run_id: run_id, log_files: log_files });
                }
            }
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

          get_cluster_cores(conn, function(err, ncores) {
            if (err) {
              return abort_and_reset_perf_tests(err, done, conn, 'ncores');
            }

            get_cluster_os(conn, function(err, os) {
              if (err) {
                return abort_and_reset_perf_tests(err, done, conn, 'OS');
              }

              var copies = [{ src: REMOTE_STDOUT, dst: LOCAL_STDOUT },
                            { src: REMOTE_STDERR, dst: LOCAL_STDERR },
                            { src: REMOTE_PROFILER, dst: LOCAL_PROFILER },
                            { src: REMOTE_TRACES, dst: LOCAL_TRACES }];
              var svn_add_cmd = ['add', LOCAL_STDOUT, LOCAL_STDERR, LOCAL_SLURM,
                                 LOCAL_PROFILER, LOCAL_TRACES];
              if (os !== 'Darwin') {
                copies.push({ src: REMOTE_DATARACE, dst: LOCAL_DATARACE });
                svn_add_cmd.push(LOCAL_DATARACE);
              }

              var tests = get_scalability_tests(ncores);
              for (var i = 0; i < tests.length; i++) {
                var curr_cores = tests[i];
                var local = LOCAL_FOLDER + '/performance.' + curr_cores + '.txt';
                var remote = REMOTE_FOLDER + '/performance.' + curr_cores + '.txt';

                copies.push({ src: remote, dst: local });
                svn_add_cmd.push(local);
              }

              batched_cluster_scp(copies, false, function(err) {
                if (err) {
                  return abort_and_reset_perf_tests(err, done, conn, 'scp');
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
                if (stdout === 'FAILED') {
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
            if (run.job_id !== 'LOCAL') {
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

