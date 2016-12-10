var request = require('request');

// A JS script for performing a post to a conductor instance that launches a job
// on behalf of a user.

if (process.argv.length != 7) {
    console.log('usage: node submit_run_as.js <as-username> <for-username> <assignment-name> <svn_url> <corectness_only>');
    process.exit(1);
}

var username = process.argv[2];
var for_username = process.argv[3];
var assignment_name = process.argv[4];
var svn_url = process.argv[5];
var correctness_only = process.argv[6];

request({
    url: 'http://ananke.cs.rice.edu/submit_run_as?svn_url=' + svn_url +
         '&username=' + username + '&assignment_name=' + assignment_name +
         '&for_username=' + for_username + '&correctness_only=' +
         correctness_only,
    method: "POST",
}, function(err, response, body) {
    if (err) {
        console.log('err = ' + err);
    }
    console.log(body);
});
