var http = require("http");
var express = require('express');
var session = require('express-session');
var bodyParser = require('body-parser');
var bcrypt = require('bcrypt-nodejs');
var pg = require('pg');

var ejs = require('ejs');

// TODO load this from JSON file
var conString = "postgres://postgres:foobar@localhost/autograder";

function pgclient(cb) {
  pg.connect(conString, function(err, client, done) {
          if (err) {
            return console.error('error fetching client from pool', err);
          }
          cb(client, done);
        });
}

var app = express();
app.use(bodyParser.urlencoded());
app.use(session({secret: 'blarp', cookie:{maxAge: 7 * 24 * 3600 * 1000}}));
app.engine('html', ejs.renderFile);
app.set('view engine', 'html');
app.set('views', __dirname + "/views");

/*
 * login routes should always be the only routes above the wildcard '*' route
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
        query.on('row', function(row, result) { result.addRow(row); });
        query.on('error', function(err, result) {
              done();
              res.send(JSON.stringify({ status: 'Failure',
                      msg: 'Internal error (' + err + ')', user: username }));
            });
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

app.get('*', function(req, res, next) {
  if (req.session.username) {
    next();
  } else {
    res.redirect('/login');
  }
});

app.get('/logout', function(req, res, next) {
  console.log('logout: username=' + req.session.username);
  req.session.username = null;
  res.render('login.html');
});

app.get('/overview', function(req, res, next) {
  res.render('overview.html');
});

var port = process.env.PORT || 8000

var oneDay = 86400000;
app.use(express.static(__dirname + '/views', { maxAge: oneDay }));

var server = app.listen(port, function() {
  console.log('Server listening at http://%s:%s', 
    server.address().address,
    server.address().port);
})
