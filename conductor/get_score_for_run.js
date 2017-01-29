var score = require('./score');

if (process.argv.length != 3) {
    console.log('usage: get_score_for_run.js run-id');
    process.exit(1);
} else {
    var run_id = parseInt(process.argv[2]);
    score.get_score(run_id, function(result) {
        if (result) {
            console.log('');
            console.log('Total : ' + result.total + ' / ' + result.total_possible);
            console.log('');
            for (var i = 0; i < result.breakdown.length; i++) {
                console.log(result.breakdown[i].name + ' : ' + result.breakdown[i].points + ' / ' + result.breakdown[i].total);
                if (result.breakdown[i].comments.length == 0) {
                    console.log('    No comments');
                } else {
                    for (var j = 0; j < result.breakdown[i].comments.length; j++) {
                        console.log('    ' + result.breakdown[i].comments[j]);
                    }
                }
            }

            process.exit(0);
        } else {
            console.log('Error getting score');
            process.exit(1);
        }
    });
}
