import java.util.LinkedList;

import org.tmatesoft.svn.core.wc.SVNClientManager;
import org.tmatesoft.svn.core.SVNURL;
import org.tmatesoft.svn.core.SVNDepth;
import org.tmatesoft.svn.core.SVNException;

public class NotifyConductorRunnable implements Runnable {
    private final LinkedList<LocalTestRunner> toNotify;

    private final static int pause = 3000;

    public NotifyConductorRunnable(LinkedList<LocalTestRunner> toNotify) {
        this.toNotify = toNotify;
    }

    @Override
    public void run() {
        while (true) {
            LocalTestRunner curr = null;
            synchronized(toNotify) {
                while (toNotify.isEmpty()) {
                    try {
                        toNotify.wait();
                    } catch (InterruptedException ie) { }
                }
                curr = toNotify.poll();
            }

            ViolaUtil.log("received notify job for run %d\n", curr.getRunId());

            boolean success = false;
            try {
                curr.cleanup(curr.getErrMsg());
                success = true;
                ViolaUtil.log("successfully notified conductor of run %d completion\n", curr.getRunId());
            } catch (Throwable t) {
                ViolaUtil.log("conductor notification for run %d appears to have failed\n", curr.getRunId());
                synchronized (toNotify) {
                    toNotify.push(curr);
                }
                try {
                    Thread.sleep(pause);
                } catch (Throwable throwable) {
                    throwable.printStackTrace();
                }
            }
        }
    }
}
