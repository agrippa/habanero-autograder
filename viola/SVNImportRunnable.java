import java.util.LinkedList;

import org.tmatesoft.svn.core.wc.SVNClientManager;
import org.tmatesoft.svn.core.SVNURL;
import org.tmatesoft.svn.core.SVNDepth;
import org.tmatesoft.svn.core.SVNException;

public class SVNImportRunnable implements Runnable {
    private final LinkedList<LocalTestRunner> toImport;

    private final static int nretries = 10;
    private final static int backoff = 2;
    private final static int initialPause = 1000;

    public SVNImportRunnable(LinkedList<LocalTestRunner> toImport) {
        this.toImport = toImport;
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

            ViolaUtil.log("received import job for run %d from %s to %s\n", curr.getRunId(),
                    curr.getLogDir().getAbsolutePath(), curr.getSVNLoc());

            if (curr.getLogDir().exists()) {
                // Commit the added files to the repo
                final String commitMessage = curr.getUser() + " " + curr.getAssignmentName() + " " +
                    curr.getRunId() + " local-runs";
                boolean success = false;
                int ntries = 0;
                int pause = initialPause;
                while (!success && ntries < nretries) {
                    try {
                        ViolaUtil.log("attempt #%d for import job of run %d\n", ntries + 1, curr.getRunId());
                        curr.getSVNClientManager().getCommitClient().doImport(curr.getLogDir(),
                                SVNURL.parseURIDecoded(curr.getSVNLoc()), commitMessage, null, true, false, SVNDepth.INFINITY);
                        success = true;
                    } catch (SVNException svn) {
                        /*
                         * For now (while the Habanero repo is still misconfigured)
                         * we ignore commit failures.
                         */
                        svn.printStackTrace();
                    }

                    ntries++;

                    if (!success && ntries < nretries) {
                        ViolaUtil.log("sleeping for %d ms after failed import job, run %d\n", pause, curr.getRunId());
                        try {
                            Thread.sleep(pause);
                        } catch (InterruptedException ie) { }
                    }

                    pause *= backoff;
                }
                ViolaUtil.log("import job for run %d was successful after %d attempt(s)\n", curr.getRunId(), ntries);

                if (ntries < nretries) {
                    curr.cleanup(curr.getErrMsg());
                } else {
                    curr.cleanup("Unable to save test log files");
                }
            } else {
                /*
                 * Some internal error caused the log directory to not even be created, we assume that an appropriate
                 * error message was set by the test runner and pass it back to the conductor here.
                 */
                curr.cleanup(curr.getErrMsg());
            }

            ViolaUtil.log("Finished local tests for user=%s assignment=%s run=%d\n", curr.getUser(),
                    curr.getAssignmentName(), curr.getRunId());
        }
    }
}
