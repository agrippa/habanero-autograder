var score = require('./score');

if (process.argv.length != 3) {
    console.log('usage: get_slip_days_for_run.js run-id');
    process.exit(1);
} else {
    var run_id = parseInt(process.argv[2]);

    score.pgquery("SELECT * FROM runs WHERE run_id=($1)", [run_id], function(err, rows) {
        if (err) {
            console.log('Error getting slip days');
            process.exit(1);
        }

        var run_timestamp = rows[0].start_time;
        var assignment_id = rows[0].assignment_id;

        score.pgquery("SELECT * FROM assignments WHERE assignment_id=($1)", [assignment_id], function(err, rows) {
            if (err) {
                console.log('Error getting slip days');
                process.exit(1);
            }

            var assignment_deadline = rows[0].deadline;
            var slip_days_used = score.calc_slip_days_for(run_timestamp,
                assignment_deadline);
            console.log(slip_days_used + " slip day(s) used.");
            process.exit(0);
        });
    });
}
