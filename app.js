var http = require("http");
var express = require('express');
var session = require('express-session');
var bodyParser = require('body-parser');

var app = express();
app.use(bodyParser.urlencoded());
app.use(session({secret: 'blarp', cookie:{maxAge: 7 * 24 * 3600 * 1000}}));
app.engine('html', require('ejs').renderFile);

app.get('/login', function(req, res, next) {
  res.render('login.html');
})

app.post('/login', function(req, res, next) {
  var username = req.body.username;
  var password = req.body.password;

  req.session.username = username;

  res.send(JSON.stringify({ status: 'Meh', user: username }))
})

app.get('*', function(req, res, next) {
  if (req.session.username) {
    next();
  } else {
    res.redirect('/login');
  }
})

var port = process.env.PORT || 8000

var server = app.listen(port, function() {
  console.log('Server listening at http://%s:%s', 
    server.address().address,
    server.address().port);
})
