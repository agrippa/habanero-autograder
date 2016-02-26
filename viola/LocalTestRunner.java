import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.FilenameFilter;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.util.LinkedList;
import java.util.List;
import java.util.Arrays;
import java.nio.file.Files;
import java.nio.file.Paths;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.Headers;

import java.util.concurrent.ThreadPoolExecutor;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.HashMap;
import java.util.Date;
import java.text.SimpleDateFormat;
import java.nio.charset.StandardCharsets;
import java.net.URL;
import java.net.HttpURLConnection;
import java.io.DataOutputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;

import org.tmatesoft.svn.core.wc.SVNClientManager;
import org.tmatesoft.svn.core.wc.SVNUpdateClient;
import org.tmatesoft.svn.core.SVNURL;
import org.tmatesoft.svn.core.wc.SVNRevision;
import org.tmatesoft.svn.core.SVNException;
import org.tmatesoft.svn.core.SVNDepth;
import org.tmatesoft.svn.core.wc.SVNWCUtil;
import org.tmatesoft.svn.core.auth.ISVNAuthenticationManager;
import org.tmatesoft.svn.core.wc.ISVNOptions;

/*
 * Logic for actually running single-threaded tests.
 */
public class LocalTestRunner implements Runnable {
    private static final long TIMEOUT_CHECK_INTERVAL = 5 * 1000;

    private final String done_token;
    private final String user;
    private final String assignment_name;
    private final int run_id;
    private final int assignment_id;
    private final String[] jvm_args;
    private final int timeout;
    private final ViolaEnv env;

    public LocalTestRunner(String done_token, String user,
            String assignment_name, int run_id, int assignment_id,
            String jvm_args, int timeout, ViolaEnv env) {
        this.done_token = done_token;
        this.user = user;
        this.assignment_name = assignment_name;
        this.run_id = run_id;
        this.assignment_id = assignment_id;
        jvm_args = jvm_args.trim();
        if (jvm_args.length() == 0) {
            this.jvm_args = new String[0];
        } else {
            this.jvm_args = jvm_args.split("\\s+");
        }
        this.timeout = timeout;
        this.env = env;
    }
    
    public String getUser() {
      return user;
    }

    public int getRunId() {
      return run_id;
    }

    /*
     * Partially taken from http://stackoverflow.com/questions/4205980/java-sending-http-parameters-via-post-method-easily
     * TODO Problem here is we could fail silently to succeed.
     */
    private void notifyConductor(String err_msg) {
        try {
            String urlParameters = "done_token=" + done_token + "&err_msg=" + err_msg;
            byte[] postData = urlParameters.getBytes(StandardCharsets.UTF_8);
            int postDataLength = postData.length;
            String request = "http://" + env.conductorHost + ":" +
              env.conductorPort + "/local_run_finished";
            ViolaUtil.log("Notifying conductor at " + request + " of run completion");

            URL url = new URL(request);
            HttpURLConnection conn = (HttpURLConnection)url.openConnection();
            conn.setDoOutput(true);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("POST");
            conn.setUseCaches(false);

            DataOutputStream wr = new DataOutputStream(conn.getOutputStream());
            wr.writeBytes(urlParameters);
            wr.flush();
            wr.close();

            int responseCode = conn.getResponseCode();
            assert(responseCode == 200);

            BufferedReader in = new BufferedReader(
                    new InputStreamReader(conn.getInputStream()));
            String inputLine;
            StringBuilder response = new StringBuilder();

            while ((inputLine = in.readLine()) != null) {
                response.append(inputLine);
            }
            in.close();

            ViolaUtil.log("Conductor notification response for done_token=%s: %s\n",
                    done_token, response.toString());

        } catch (Exception ex) {
            ex.printStackTrace();
        }
    }

    private void delete_dir(File dir) {
        for (String filename : dir.list()) {
            File curr = new File(dir.getAbsolutePath(), filename);
            curr.delete();
        }
        dir.delete();
    }

    private void merge_dirs(File dst, File src) {
        for (String filename : src.list()) {
          File curr = new File(src.getAbsolutePath(), filename);
          File target = new File(dst.getAbsolutePath(), filename);
          if (curr.isDirectory()) {
            if (!curr.getName().equals(".svn")) {
              if (!target.exists()) {
                target.mkdir();
              }
              merge_dirs(target, curr);
            }
          } else {
            if (!curr.getName().endsWith("PerformanceTest.java")) {
              /*
               * Don't copy over any JUnit tests except the correctness
               * ones. If something doesn't look like a test file that JUnit
               * will run, copy it over anyway.
               */
              curr.renameTo(target);
            }
          }
        }
    }

    private File getTempDirectory() throws IOException {
        final File code_dir = File.createTempFile("temp", Long.toString(System.nanoTime()));
        if(!(code_dir.delete())) {
            throw new IOException("Could not delete temp file: " +
                    code_dir.getAbsolutePath());
        }
        return code_dir;
    }

    class ProcessResults {
      public final String stdout;
      public final String stderr;
      public final int code;

      public ProcessResults(String stdout, String stderr, int code) {
        this.stdout = stdout;
        this.stderr = stderr;
        this.code = code;
      }
    }

    private void findAllJavaFilesHelper(File currDir, List<String> acc,
        boolean correctnessTestsOnly) {
      File[] files = currDir.listFiles();
      for (File f : files) {
        if (f.isFile()) {
          if (f.getName().endsWith(".java")) {
            if (correctnessTestsOnly) {
              if (f.getName().endsWith("CorrectnessTest.java")) {
                acc.add(f.getAbsolutePath());
              }
            } else {
              acc.add(f.getAbsolutePath());
            }
          }
        } else {
          // Directory
          findAllJavaFilesHelper(f, acc, correctnessTestsOnly);
        }
      }
    }

    private List<String> findAllJavaFiles(File dir, boolean correctnessTestsOnly) {
      List<String> acc = new LinkedList<String>();
      findAllJavaFilesHelper(dir, acc, correctnessTestsOnly);
      return acc;
    }

    private boolean processIsFinished(Process p) {
      boolean finished = true;
      try {
        p.exitValue();
      } catch (IllegalThreadStateException e) {
        finished = false;
      }
      return finished;
    }

    private ProcessResults runInProcess(String[] cmd, File working_dir)
        throws IOException, InterruptedException {
      ViolaUtil.log("runInProcess: run_id=%d working_dir=%s cmd=%s\n",
          run_id, working_dir.getAbsolutePath(), String.join(" ", cmd));
      
      ProcessBuilder pb = new ProcessBuilder(Arrays.asList(cmd));
      pb.directory(working_dir);
      Process p = pb.start();

      final long startTime = System.currentTimeMillis();
      while (System.currentTimeMillis() - startTime < this.timeout &&
          !processIsFinished(p)) {
        Thread.sleep(TIMEOUT_CHECK_INTERVAL);
      }

      if (!processIsFinished(p)) {
        p.destroy();

        return new ProcessResults("", "ERROR: The correctness tests took longer than " +
            "the allowed " + this.timeout + " ms to complete.", 0);
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

    private void svnAddIfExists(File f) {
        if (f.exists()) {
            try {
                env.ourClientManager.getWCClient().doAdd(f, false, false, false,
                        SVNDepth.INFINITY, false, false);
            } catch (SVNException svn) {
                svn.printStackTrace();
            }
        }
    }

    @Override
    public void run() {
        ViolaUtil.log("Running local tests for user=%s assignment=%s run=%d " +
                "jvm_args length=%d\n", user, assignment_name, run_id,
                jvm_args.length);

        String err_msg = "";
        File code_dir = null;
        File instructor_dir = null;
        File extract_code_dir = null;
        File extract_instructor_dir = null;
        try {
            code_dir = getTempDirectory();
            instructor_dir = getTempDirectory();
            extract_code_dir = getTempDirectory();
            extract_instructor_dir = getTempDirectory();

            /*
             * Check out the student code from SVN. This should check out a
             * single directory with a single ZIP file inside.
             */
            SVNUpdateClient updateClient = env.ourClientManager.getUpdateClient();
            updateClient.setIgnoreExternals(false);

            final String svnLoc = env.svnRepo + "/" + user + "/" +
                assignment_name + "/" + run_id;
            ViolaUtil.log("Checking student code out to %s from %s\n", code_dir.getAbsolutePath(), svnLoc);
            updateClient.doCheckout(SVNURL.parseURIDecoded(svnLoc), code_dir,
                    SVNRevision.HEAD, SVNRevision.HEAD, SVNDepth.INFINITY, false);

            ViolaUtil.log("Checking instructor code out to %s\n", instructor_dir.getAbsolutePath());
            updateClient.doCheckout(SVNURL.parseURIDecoded(env.svnRepo +
                  "/assignments/" + assignment_id), instructor_dir,
                SVNRevision.HEAD, SVNRevision.HEAD, SVNDepth.INFINITY,
                false);

            extract_code_dir.mkdir();
            extract_instructor_dir.mkdir();

            ViolaUtil.log("Target code directory = " + extract_code_dir.getAbsolutePath() + "\n");
            ViolaUtil.log("Target instructor directory = " + extract_instructor_dir.getAbsolutePath() + "\n");

            String[] unzip_code = new String[]{"unzip", code_dir.getAbsolutePath() + "/student.zip", "-d",
              extract_code_dir.getAbsolutePath()};
            String[] unzip_instructor = new String[]{"unzip", instructor_dir.getAbsolutePath() + "/instructor.zip",
              "-d", extract_instructor_dir.getAbsolutePath()};

            final Process unzip_code_process = Runtime.getRuntime().exec(unzip_code);
            final int unzip_code_exit = unzip_code_process.waitFor();
            if (unzip_code_exit != 0) {
                throw new TestRunnerException("Error unzipping code");
            }
            final Process unzip_instructor_process = Runtime.getRuntime().exec(unzip_instructor);
            final int unzip_instructor_exit = unzip_instructor_process.waitFor();
            if (unzip_instructor_exit != 0) {
                throw new TestRunnerException("Error unzipping instructor");
            }

            // Find all subdirectories, should only be 1
            FilenameFilter dirsOnly = new FilenameFilter() {
              @Override
              public boolean accept(File current, String name) {
                return !name.equals("__MACOSX") && new File(current, name).isDirectory();
              }
            };
            String[] code_directories = extract_code_dir.list(dirsOnly);
            String[] instructor_directories = extract_instructor_dir.list(dirsOnly);

            if (code_directories.length != 1) {
              StringBuilder sb = new StringBuilder("Unexpected number of code " +
                  "directories (" + code_directories.length + ") [");
              for (String d : code_directories) {
                  sb.append(" " + d);
              }
              sb.append("]");
  
              throw new TestRunnerException(sb.toString());
            }
            if (instructor_directories.length != 1) {
              throw new TestRunnerException("Unexpected number of instructor directories (" +
                  instructor_directories.length + ")");
            }

            final File unzipped_code_dir = new File(extract_code_dir, code_directories[0]);
            final File unzipped_instructor_dir = new File(extract_instructor_dir,
                instructor_directories[0]);
            final File unzipped_instructor_src_dir = new File(unzipped_instructor_dir, "src");
            if (!unzipped_instructor_src_dir.exists()) {
                throw new TestRunnerException("Instructor tests appear to be missing a src/ directory");
            }
            final File unzipped_instructor_test_dir = new File(unzipped_instructor_src_dir, "test");
            if (!unzipped_instructor_test_dir.exists()) {
                throw new TestRunnerException("Instructor tests appear to be missing a src/test/ directory");
            }

            /*
             * Run checkstyle
             */
            final File checkstyle_config = new File(instructor_dir.getAbsolutePath() + "/checkstyle.xml");
            ViolaUtil.log("Checkstyle config file = " + checkstyle_config.getAbsolutePath() + "\n");

            final File mainSrcFolder = new File(unzipped_code_dir, "src");
            if (!mainSrcFolder.exists()) {
                throw new TestRunnerException("Expected a src folder under top-level directory in zip.");
            }
            File mainCodeFolder = new File(mainSrcFolder, "main");
            if (!mainCodeFolder.exists()) {
                throw new TestRunnerException("Expected a main folder under the src/ directory in zip.");
            }
            File mainTestFolder = new File(mainSrcFolder, "test");
            if (!mainTestFolder.exists()) {
                throw new TestRunnerException("Expected a test folder under the src/ directory in zip.");
            }

            ViolaUtil.log("mainCodeFolder = " + mainCodeFolder.getAbsolutePath() + "\n");
            List<String> studentJavaFiles = findAllJavaFiles(mainCodeFolder, false);

            String[] checkstyle_cmd = new String[5 + studentJavaFiles.size()];
            checkstyle_cmd[0] = "java";
            checkstyle_cmd[1] = "-jar";
            checkstyle_cmd[2] = env.checkstyle;
            checkstyle_cmd[3] = "-c";
            checkstyle_cmd[4] = checkstyle_config.getAbsolutePath();
            int checkstyle_index = 5;
            for (String filename : studentJavaFiles) {
                checkstyle_cmd[checkstyle_index++] = filename;
            }

            ProcessResults checkstyle_results = runInProcess(checkstyle_cmd,
                unzipped_code_dir);
            PrintWriter writer = new PrintWriter(
                code_dir.getAbsolutePath() + "/checkstyle.txt", "UTF-8");
            writer.println(checkstyle_results.stdout);
            writer.close();

            /*
             * Run FindBugs
             */
            String[] findbugs_cmd = new String[]{"findbugs", "-textui",
              "-low", mainCodeFolder.getAbsolutePath()};
            ProcessResults findbugs_results = runInProcess(findbugs_cmd, unzipped_code_dir);
            writer = new PrintWriter(
                code_dir.getAbsolutePath() + "/findbugs.txt", "UTF-8");
            writer.println(findbugs_results.stdout);
            writer.close();

            /*
             * Merge the student-provided test code with the instructor-provided
             * test code into a single folder hierarchy.
             */
            merge_dirs(mainTestFolder, unzipped_instructor_test_dir);
            final File pom = new File(instructor_dir, "instructor_pom.xml");
            if (!pom.exists()) {
                throw new TestRunnerException("We appear to be missing the " +
                    "instructor-provided pom.xml. Please contact the " +
                    "teaching staff");
            }
            final File renamedPom = new File(unzipped_code_dir, "pom.xml");
            pom.renameTo(renamedPom);

            /*
             * We need to infer the correct version of HJlib to use from the
             * local Maven repo using the instructor provided POM. We do this in
             * an ugly way, by looking for the hjlib.version property.
             */
            final String pomXml = new String(Files.readAllBytes(Paths.get(
                renamedPom.getAbsolutePath())), StandardCharsets.UTF_8);
            final String hjlibVersionProperty = "<hjlib.version>";
            int index = pomXml.indexOf(hjlibVersionProperty);
            if (index == -1) {
                throw new TestRunnerException("Missing hjlib.version in instructor-provided POM");
            }
            final int versionIndex = index + hjlibVersionProperty.length();
            int endVersion = versionIndex;
            while (endVersion < pomXml.length() && pomXml.charAt(endVersion) != '<') endVersion++;
            final String versionStr = pomXml.substring(versionIndex, endVersion);
            final File hjJar = new File(env.mavenRepo +
                "/edu/rice/hjlib-cooperative/" + versionStr +
                "/hjlib-cooperative-" + versionStr + ".jar");

            /*
             * Compile the full application and testing suite
             */
            String[] cmd = new String[]{"mvn", "-Dcheckstyle.skip=true", "clean", "compile", "test-compile"};
            ProcessResults mvn_results = runInProcess(cmd, unzipped_code_dir);
            writer = new PrintWriter(code_dir.getAbsolutePath() + "/compile.txt", "UTF-8");
            writer.println("======= STDOUT =======");
            writer.println(mvn_results.stdout);
            writer.println("\n======= STDERR =======");
            writer.println(mvn_results.stderr);
            writer.close();
            if (mvn_results.code != 0) {
              throw new TestRunnerException("Error compiling correctness " +
                  "tests from dir=" + unzipped_code_dir.getAbsolutePath() +
                  " with cmd=mvn clean compile test-compile");
            }

            /*
             * Find all correctness tests and run them one-by-one, storing
             * the results in a string builder.
             */
            final StringBuilder stdout = new StringBuilder();
            final StringBuilder stderr = new StringBuilder();
            final List<String> correctnessTests = findAllJavaFiles(unzipped_code_dir, true);
            for (String test : correctnessTests) {
              assert test.startsWith(unzipped_code_dir.getAbsolutePath());
              test = test.substring(unzipped_code_dir.getAbsolutePath().length() + 1);

              final String src_test_java = "src/test/java";
              assert test.startsWith(src_test_java);
              test = test.substring(src_test_java.length() + 1);

              final String java_suffix = ".java";
              assert test.endsWith(java_suffix);
              test = test.substring(0, test.length() - java_suffix.length());

              final String classname = test.replace('/', '.');

              final String classpath =
                  ".:target/classes:target/test-classes:" + env.junit + ":" +
                  env.hamcrest + ":" + hjJar + ":" + env.asm;
              final String policyPath = env.autograderHome + "/shared/security.policy";
              final int junit_cmd_length = 9 + jvm_args.length;
              final String[] junit_cmd = new String[junit_cmd_length];
              int junit_cmd_index = 0;
              junit_cmd[junit_cmd_index++] = "java";
              junit_cmd[junit_cmd_index++] = "-Djava.security.manager";
              junit_cmd[junit_cmd_index++] = "-Djava.security.policy==" + policyPath;
              junit_cmd[junit_cmd_index++] = "-Dhj.numWorkers=1";
              junit_cmd[junit_cmd_index++] = "-javaagent:" + hjJar;
              junit_cmd[junit_cmd_index++] = "-cp";
              junit_cmd[junit_cmd_index++] = classpath;
              for (String arg : jvm_args) {
                junit_cmd[junit_cmd_index++] = arg;
              }
              junit_cmd[junit_cmd_index++] = "org.junit.runner.JUnitCore";
              junit_cmd[junit_cmd_index++] = classname;
              assert junit_cmd_index == junit_cmd_length;
              ProcessResults junit_results = runInProcess(junit_cmd, unzipped_code_dir);
              /*
               * A non-zero exit code here can simply indicate a test
               * failure, so we ignore all error checking and continue.
               */

              stdout.append("Running " + classname + "\n");
              stdout.append(junit_results.stdout);
              stderr.append(junit_results.stderr);
            }

            writer = new PrintWriter(
                    code_dir.getAbsolutePath() + "/correct.txt", "UTF-8");
            writer.println("======= STDOUT =======");
            writer.println(stdout.toString());
            writer.println("\n======= STDERR =======");
            writer.println(stderr.toString());
            writer.close();

            ViolaUtil.log("Filled correctness log file\n");
        } catch (IOException io) {
            io.printStackTrace();
        } catch (InterruptedException ie) {
            ie.printStackTrace();
        } catch (SVNException svn) {
            svn.printStackTrace();
        } catch (TestRunnerException tr) {
            err_msg = tr.getMessage();
            tr.printStackTrace();
        } finally {
            // Add the generated files to the repo
            if (code_dir != null) {
                svnAddIfExists(new File(code_dir.getAbsolutePath(), "compile.txt"));
                svnAddIfExists(new File(code_dir.getAbsolutePath(), "correct.txt"));
                svnAddIfExists(new File(code_dir.getAbsolutePath(), "checkstyle.txt"));
                svnAddIfExists(new File(code_dir.getAbsolutePath(), "findbugs.txt"));

                ViolaUtil.log("Added log files to repo\n");

                // Commit the added files to the repo
                File[] wc = new File[1];
                wc[0] = new File(code_dir.getAbsolutePath());
                final String commitMessage =
                    user + " " + assignment_name + " " + run_id + " local-runs";
                try {
                    env.ourClientManager.getCommitClient().doCommit(wc, false,
                            commitMessage, false, true);
                } catch (SVNException svn) {
                    /*
                     * For now (while the Habanero repo is still misconfigured)
                     * we ignore commit failures.
                     */
                    svn.printStackTrace();
                }
            }

            ViolaUtil.log("Committed log file to repo\n");

            /*
             * Clean up the test directory. This assumes that no directories
             * are created in the process of testing.
             */
            if (code_dir != null) delete_dir(code_dir);
            if (instructor_dir != null) delete_dir(instructor_dir);
            if (extract_code_dir != null) delete_dir(extract_code_dir);
            if (extract_instructor_dir != null) delete_dir(extract_instructor_dir);

            ViolaUtil.log("Done with local testing\n");
        }

        notifyConductor(err_msg);
        ViolaUtil.log("Finished local tests for user=%s assignment=%s run=%d\n", user,
                assignment_name, run_id);
    }
}

