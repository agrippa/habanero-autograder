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

var permissionDenied = 'Permission denied. But you should shoot me an e-mail at jmaxg3@gmail.com. If you like playing around with systems, we have interesting research for you in the Habanero group.';

var upload = multer({ dest: 'uploads/' });

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

// TODO load this from JSON file
var conString = "postgres://" + POSTGRES_USER_TOKEN + "@localhost/autograder";

function pgclient(cb) {
  pg.connect(conString, function(err, client, done) {
          if (err) {
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

// Create a new assignment with a given name, not visible to students
app.post('/assignment', function(req, res, next) {
  console.log('assignment: is_admin=' + req.session.is_admin);
  if (!req.session.is_admin) {
    res.send(JSON.stringify({ status: 'Failure', msg: permissionDenied }));
  } else {
    var assignment_name = req.body.assignment_name;

    pgclient(function(client, done) {
          var query = client.query(
              "INSERT INTO assignments (name, visible) VALUES ($1,false)",
              [assignment_name]);
          register_query_helpers(query, res, done, req.session.username);
          query.on('end', function(result) {
              done();
              res.send(JSON.stringify({ status: 'Success', redirect: '/admin' }));
          });
    });
  }
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
                return res.send(JSON.stringify({ status: 'Failure',
                        msg: 'Invalid assignment ID, does not exist' }));
            } else {
                var query = client.query(
                    "UPDATE assignments SET visible=($1) WHERE assignment_id=($2);",
                    [set_visible, assignment_id]);
                register_query_helpers(query, res, done, req.session.username);
                query.on('end', function(result) {
                    return res.send(JSON.stringify({ status: 'Success',
                            redirect: '/admin' }));
                });
            }
        });
    });

  }
});

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
            return res.render('overview.html', { err_msg: err });
          }
          var query = client.query("SELECT * FROM assignments WHERE name=($1)",
            [assignment_name]);
          register_query_helpers(query, res, done, req.session.username);
          query.on('end', function(result) {
            if (result.rowCount == 0) {
              return res.render('overview.html',
                { err_msg: 'Assignment ' + assignment_name + ' does not seem to exist' });
            } else if (result.rowCount > 1) {
              return res.render('overview.html',
                { err_msg: 'There appear to be duplicate assignments ' + assignment_name });
            } else {
              var assignment_id = result.rows[0].assignment_id;
              crypto.randomBytes(48, function(ex, buf) {
                  var done_token = buf.toString('hex');

                  var query = client.query("INSERT INTO runs (user_id, " +
                      "assignment_id, done_token, status) VALUES " +
                      "($1,$2,$3,'RUNNING') RETURNING run_id",
                      [user_id, assignment_id, done_token]);
                  register_query_helpers(query, res, done, req.session.username);
                  query.on('end', function(result) {
                    done();
                    var run_id = result.rows[0].run_id;
                    var run_dir = __dirname + '/submissions/' + req.session.username + '/' + run_id;
                    var dst_dir = SVN_REPO + '/' + req.session.username + '/' +
                        assignment_name + '/' + run_id;

                    var mkdir_msg = '"mkdir ' + req.session.username + ' ' + assignment_name + ' ' + run_id + '"';
                    svn_client.cmd(['mkdir', '--message', mkdir_msg, dst_dir], function(err, data) {
                      // Special-case an error message from the Habanero repo that we can safely ignore
                      if (err && err.message.trim().search("200 OK") === -1) {
                        return res.render('overview.html', { err_msg:
                          'An error occurred backing up your submission' });
                      } else {
                        svn_client.cmd(['checkout', dst_dir, run_dir], function(err, data) {
                          if (err && err.message.trim().search("200 OK") === -1) {
                            return res.render('overview.html', { err_msg:
                              'An error occurred backing up your submission' });
                          } else {
                            // Move submitted file into newly created local SVN working copy
                            fs.renameSync(req.file.path, run_dir + '/' + req.file.originalname);
                            svn_client.cmd(['add', run_dir + '/' + req.file.originalname], function(err, data) {
                              if (err && err.message.trim().search("200 OK") === -1) {
                                return res.render('overview.html', { err_msg:
                                  'An error occurred backing up your submission' });
                              } else {
                                var commit_msg = '"add ' + req.session.username + ' ' + assignment_name + ' ' + run_id + '"';
                                svn_client.cmd(['commit', '--message', commit_msg, run_dir], function(err, data) {
                                  if (err && err.message.trim().search("200 OK") === -1) {
                                    return res.render('overview.html', { err_msg:
                                      'An error occurred backing up your submission' });
                                  } else {
                                    var viola_params = 'done_token=' + done_token +
                                        '&user=' + req.session.username +
                                        '&assignment=' + assignment_name + '&run=' +
                                        run_id;
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

app.post('/run_finished', function(req, res, next) {
    var done_token = req.body.done_token;
    console.log('run_finished: done_token=' + done_token);

    pgclient(function(client, done) {
        // Can only be one match here because of SQL schema constraints
        var query = client.query("SELECT * FROM runs WHERE done_token=($1)", [done_token]);
        register_query_helpers(query, res, done, 'unknown');
        query.on('end', function(result) {
          if (result.rows.length != 1) {
            return res.send(JSON.stringify({status: 'Failure', msg: 'Unexpected # of rows, ' + result.rows.length}));
          } else {
            var run_id = result.rows[0].run_id;
            var user_id = result.rows[0].user_id;

            var query = client.query("SELECT * FROM users WHERE user_id=($1)", [user_id]);
            register_query_helpers(query, res, done, 'unknown');
            query.on('end', function(result) {
              if (result.rows.length != 1) {
                return res.send(JSON.stringify({status: 'Failure', msg: 'Invalid user ID'}));
              } else {
                var username = result.rows[0].user_name;
                var run_dir = __dirname + '/submissions/' + username + '/' + run_id;

                var query = client.query(
                    "UPDATE runs SET status='FINISHED' WHERE run_id=($1)", [run_id]);
                register_query_helpers(query, res, done, req.session.username);
                query.on('end', function(result) {
                    done();

                    svn_client.cmd(['up', '--accept', 'theirs-full', run_dir], function(err, data) {
                      if (err) {
                        return res.send(JSON.stringify({status: 'Failure',
                          msg: 'Failed updating repo, ' + err}));
                      } else {
                        return res.send(JSON.stringify({ status: 'Success' }));
                      }
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

app.get('/run/:run_id', function(req, res, next) {
    var run_id = req.params.run_id;
    pgclient(function(client, done) {
        var query = client.query("SELECT user_id FROM runs WHERE run_id=($1)",
            [run_id]);
        register_query_helpers(query, res, done, req.session.username);
        query.on('end', function(result) {
            if (result.rows.length == 0) {
                return res.render('overview.html', { err_msg: 'Unknown run' });
            } else {
                var user_id = result.rows[0].user_id;
                if (user_id != req.session.user_id) {
                    return res.send(401);
                } else {
                    return res.render('run.html', { run_id: run_id });
                }
            }
        });
    });
});

var port = process.env.PORT || 8000

var oneDay = 86400000;
app.use(express.static(__dirname + '/views', { maxAge: oneDay }));

var server = app.listen(port, function() {
  console.log('Server listening at http://%s:%s', 
    server.address().address,
    server.address().port);
})
