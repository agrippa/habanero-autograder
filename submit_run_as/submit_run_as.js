var request = require('request');

if (process.argv.length != 5) {
    console.log('usage: node submit_run_as.js <username> <assignment-name> <svn_url>');
    process.exit(1);
}

var username = process.argv[2];
var assignment_name = process.argv[3];
var svn_url = process.argv[4];

request({
    url: 'http://ananke.cs.rice.edu/submit_run_as?svn_url=' + svn_url +
         '&username=' + username + '&assignment_name=' + assignment_name,
    method: "POST",
}, function(err, response, body) {
    if (err) {
        console.log('err = ' + err);
    }
    console.log(body);
});
