import java.util.LinkedList;

/**
 * Signal the conductor that a Viola run has completed.
 */
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
                curr = toNotify.pollLast();

                ViolaUtil.log("received notify job for run %d, %d notify jobs in queue\n", curr.getRunId(),
                        toNotify.size());
            }

            boolean success = false;
            try {
                // Cleanup after a Viola run, including sending notification to the conductor
                curr.cleanup(curr.getErrMsg());
                success = true;
                ViolaUtil.log("successfully notified conductor of run %d completion\n", curr.getRunId());
            } catch (Throwable t) {
                ViolaUtil.log("conductor notification for run %d appears to have failed, message = %s, type = %s\n",
                        curr.getRunId(), t.getMessage(), t.getClass().toString());
                t.printStackTrace(System.err);

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
