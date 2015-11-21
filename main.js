var http = require("http");
var express = require('express');

var app = express();
var port = process.env.PORT || 8000
var server = app.listen(port, function() {
  console.log('Server listening at http://%s:%s', 
    server.address().address,
    server.address().port);
})
