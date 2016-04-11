import java.util.LinkedList;

import java.io.File;
import java.io.IOException;

public class ExportToConductorRunnable implements Runnable {
    private final LinkedList<LocalTestRunner> toImport;
    private final LinkedList<LocalTestRunner> toNotify;

    private final static int nretries = 10;
    private final static int backoff = 2;
    private final static int initialPause = 1000;

    public ExportToConductorRunnable(LinkedList<LocalTestRunner> toImport, LinkedList<LocalTestRunner> toNotify) {
        this.toImport = toImport;
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

            ViolaUtil.log("received export job for run %d from %s to conductor\n", curr.getRunId(),
                    curr.getLogDir().getAbsolutePath());
            /*
             * If some internal error caused the log directory to not even be created, we assume that an appropriate
             * error message was set by the test runner.
             */

            for (String path : curr.getFilesToSave()) {
                final CommonUtils.ProcessResults[] scpResults = new CommonUtils.ProcessResults[1];
                final String[] scpCmd = new String[] {"scp", path, curr.getEnv().conductorUser + "@" +
                    curr.getEnv().conductorHost + ":" + curr.getSubmissionPath() + "/" };

                final Throwable err = CommonUtils.retryUntilSuccess(() -> {
                    try {
                        scpResults[0] = CommonUtils.runInProcess("", scpCmd, new File("/tmp"), 30000, null);
                    } catch (IOException|InterruptedException io) {
                        throw new RuntimeException(io);
                    }
                }, 10, 1000, 2, "copying viola results to conductor");
                
                if (err != null) {
                    curr.setErrMsg("Unable to save log files: " + err.getMessage());
                } else if (scpResults[0].code != 0) {
                    curr.setErrMsg("Unable to save log files: " + scpResults[0].stderr);
                }
            }

            ViolaUtil.log("export job for run %d completed\n", curr.getRunId());

            synchronized (toNotify) {
                toNotify.push(curr);
                toNotify.notify();
            }

            ViolaUtil.log("Finished local tests for user=%s assignment=%s run=%d\n", curr.getUser(),
                    curr.getAssignmentName(), curr.getRunId());
        }
    }
}
