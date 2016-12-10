import java.io.*;
import java.nio.*;
import java.util.List;
import java.util.Arrays;

public class CommonUtils {
    private static final long TIMEOUT_CHECK_INTERVAL = 5 * 1000;

    /**
     * Encapsulate the results of a process's execution.
     */
    public static class ProcessResults {
      public final String stdout;
      public final String stderr;
      public final int code;

      public ProcessResults(String stdout, String stderr, int code) {
        this.stdout = stdout;
        this.stderr = stderr;
        this.code = code;
      }
    }

    /**
     * Utility method for executing a given command from a given working directory and returning the results.
     */
    public static ProcessResults runInProcess(String lbl, String[] cmd, File working_dir, final long processTimeoutMs,
            List<Process> trackProcesses) throws IOException, InterruptedException {
      ViolaUtil.log("runInProcess: %s working_dir=%s cmd=%s\n", lbl, working_dir.getAbsolutePath(),
              String.join(" ", cmd));
      
      ProcessBuilder pb = new ProcessBuilder(Arrays.asList(cmd));
      pb.directory(working_dir);
      Process p = pb.start();
      if (trackProcesses != null) trackProcesses.add(p);

      final long startTime = System.currentTimeMillis();
      while (System.currentTimeMillis() - startTime < processTimeoutMs &&
              !processIsFinished(p)) {

          Thread.sleep(TIMEOUT_CHECK_INTERVAL);
      }

      if (!processIsFinished(p)) {
        p.destroy();

        return new ProcessResults("", "ERROR: The correctness tests took longer than " +
            "the allowed " + processTimeoutMs + " ms to complete.", 0);
      } else {
        BufferedReader stdInput = new BufferedReader(
            new InputStreamReader(p.getInputStream()));
        BufferedReader stdError = new BufferedReader(
            new InputStreamReader(p.getErrorStream()));

        String s = null;
        final StringBuilder stdout = new StringBuilder();
        while ((s = stdInput.readLine()) != null) {
          stdout.append(s + "\n");
        }

        final StringBuilder stderr = new StringBuilder();
        while ((s = stdError.readLine()) != null) {
          stderr.append(s + "\n");
        }

        int exitCode = p.exitValue();

        return new ProcessResults(stdout.toString(), stderr.toString(), exitCode);
      }
    }

    /**
     * Utility method for checking whether a given process has exited.
     */
    private static boolean processIsFinished(Process p) {
      boolean finished = true;
      try {
        p.exitValue();
      } catch (IllegalThreadStateException e) {
        finished = false;
      }
      return finished;
    }

    /**
     * Get a temporary directory name (but don't create that directory).
     */
    public static File getTempDirectoryName() throws IOException {
        final File code_dir = File.createTempFile("temp", Long.toString(System.nanoTime()));

        if(!(code_dir.delete())) {
            throw new IOException("Could not delete temp file: " +
                    code_dir.getAbsolutePath());
        }
        return code_dir;
    }

    /**
     * Given the results of a process, save them to a destination file.
     */
    public static void saveResultsToFile(ProcessResults results, String dest, boolean saveAll) throws IOException {
        PrintWriter writer = new PrintWriter(dest, "UTF-8");
        if (results.code != 0 || saveAll) {
            writer.println("======= STDOUT =======");
            writer.println(results.stdout);
            writer.println("\n======= STDERR =======");
            writer.println(results.stderr);
        } else {
            writer.println(results.stdout);
        }
        writer.close();
    }

    /**
     * Retry the logic inside the provided runnable until success, or until we run out of attempts.
     */
    public static Throwable retryUntilSuccess(Runnable r, final int nretries, final int initialPause, final int backoff,
            final String lbl) {
        boolean success = false;
        int ntries = 0;
        int pause = initialPause;
        Throwable lastThrowable = null;

        while (!success && ntries < nretries) {
            try {
                r.run();
                success = true;
            } catch (Throwable t) {
                lastThrowable = t;
            }

            ntries++;

            if (!success && ntries < nretries) {
                ViolaUtil.log("received exception while \"%s\", on try %d/%d. Sleeping for %d ms\n", lbl, ntries,
                        nretries);
                try {
                    Thread.sleep(pause);
                } catch (InterruptedException ie) { }
            }

            pause *= backoff;
        }

        if (success) {
            return null;
        } else {
            return lastThrowable;
        }
    }
}
