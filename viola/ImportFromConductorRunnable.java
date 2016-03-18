import java.util.LinkedList;

import java.io.File;
import java.io.IOException;

public class ImportFromConductorRunnable implements Runnable {

    private final LinkedList<LocalTestRunner> toImport;
    private final LinkedList<LocalTestRunner> toNotify;
    private final FairViolaTaskExecutor executor;

    private final static int nretries = 10;
    private final static int backoff = 2;
    private final static int initialPause = 1000;

    public ImportFromConductorRunnable(LinkedList<LocalTestRunner> toImport, LinkedList<LocalTestRunner> toNotify,
            FairViolaTaskExecutor executor) {
        this.toImport = toImport;
        this.executor = executor;
        this.toNotify = toNotify;
    }

    @Override
    public void run() {
        while (true) {
            LocalTestRunner curr = null;
            synchronized(toImport) {
                while (toImport.isEmpty()) {
                    try {
                        toImport.wait();
                    } catch (InterruptedException ie) { }
                }
                curr = toImport.poll();
            }

            final String lbl = String.format("run=%d", curr.getRunId());

            ViolaUtil.log("received import job for run %d\n", curr.getRunId());

            File assignmentDir = null;
            File submissionDir = null;
            try {
                assignmentDir = CommonUtils.getTempDirectoryName();
                submissionDir = CommonUtils.getTempDirectoryName();
            } catch (IOException io) {
                curr.setErrMsg("Failed creating directories for Viola import");
            }

            if (assignmentDir != null && submissionDir != null) {
                curr.setCreatedAssignmentDir(assignmentDir);
                curr.setCreatedSubmissionDir(submissionDir);

                final String[] assignmentScpCmd = new String[] {
                    "scp", "-r",
                    curr.getEnv().conductorUser + "@" + curr.getEnv().conductorHost + ":" + curr.getAssignmentPath(),
                    assignmentDir.getAbsolutePath() };
                final String[] submissionScpCmd = new String[] {
                    "scp", "-r",
                    curr.getEnv().conductorUser + "@" + curr.getEnv().conductorHost + ":" + curr.getSubmissionPath(),
                    submissionDir.getAbsolutePath() };

                final CommonUtils.ProcessResults[] scpResults = new CommonUtils.ProcessResults[1];

                // SCP the assignment files from the conductor
                final Throwable assignmentThrowable = CommonUtils.retryUntilSuccess(() -> {
                        try {
                            scpResults[0] = CommonUtils.runInProcess(lbl, assignmentScpCmd, new File("/tmp/"), 30000,
                                null);
                        } catch (InterruptedException|IOException io) {
                            throw new RuntimeException(io);
                        }
                    }, nretries, initialPause, backoff);
                if (assignmentThrowable != null) {
                    curr.setErrMsg("Unable to transfer assignment files: " + assignmentThrowable.getMessage());
                } else if (scpResults[0].code != 0) {
                    curr.setErrMsg(scpResults[0].stderr);
                } else {
                    // SCP the submission files from the conductor
                    final Throwable submissionThrowable = CommonUtils.retryUntilSuccess(() -> {
                            try {
                                CommonUtils.runInProcess(lbl, submissionScpCmd, new File("/tmp/"), 60000, null);
                            } catch (InterruptedException|IOException io) {
                                throw new RuntimeException(io);
                            }
                        }, nretries, initialPause, backoff);
                    if (submissionThrowable != null) {
                        curr.setErrMsg("Unable to transfer submission files: " + submissionThrowable.getMessage());
                    } else if (scpResults[0].code != 0) {
                        curr.setErrMsg(scpResults[0].stderr);
                    }
                }
            }

            if (curr.getErrMsg() != null) {
                synchronized(toNotify) {
                    toNotify.add(curr);
                    toNotify.notify();
                }
            } else {
                executor.execute(curr);
            }
        }
    }
}
