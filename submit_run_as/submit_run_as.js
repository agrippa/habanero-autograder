var request = require('request');

if (process.argv.length != 6) {
    console.log('usage: node submit_run_as.js <as-username> <for-username> <assignment-name> <svn_url>');
    process.exit(1);
}

var username = process.argv[2];
var for_username = process.argv[3];
var assignment_name = process.argv[4];
var svn_url = process.argv[5];

request({
    url: 'http://ananke.cs.rice.edu/submit_run_as?svn_url=' + svn_url +
         '&username=' + username + '&assignment_name=' + assignment_name +
        '&for_username=' + for_username,
    method: "POST",
}, function(err, response, body) {
    if (err) {
        console.log('err = ' + err);
    }
    console.log(body);
});
