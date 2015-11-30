package edu.rice.comp322;

import junit.framework.*;

import edu.rice.hj.api.SuspendableException;
import static edu.rice.hj.Module0.numWorkerThreads;

public class PerfTestUtils {
    public static void runPerfTest(String lbl, CheckedFunction runnable,
            Runnable postRunnable) throws SuspendableException {
        final int runs = 5;
        long sum = 0;
        for (int r = 0; r < runs; r++) {
            final long start = System.currentTimeMillis();
            runnable.apply();
            final long elapsed = System.currentTimeMillis() - start;

            if (postRunnable != null) {
                postRunnable.run();
            }

            sum += elapsed;
        }

        System.err.println("\nHABANERO-AUTOGRADER-PERF-TEST " +
            numWorkerThreads() + "T " + lbl + " " + (sum / runs));
    }

    // Must be called from the test entrypoint
    public static String getTestLabel() {
        StackTraceElement[] stack = Thread.currentThread().getStackTrace();
        StackTraceElement caller = stack[2];
        return caller.getClassName() + "." + caller.getMethodName();
    }

    @FunctionalInterface
    public interface CheckedFunction { void apply() throws SuspendableException; }
}
