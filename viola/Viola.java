import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.FilenameFilter;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.util.LinkedList;
import java.util.List;

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

public class Viola {
    // Executor for actually running the local tests
    private static final ThreadPoolExecutor exec = new ThreadPoolExecutor(2, 4,
        60, TimeUnit.SECONDS, new LinkedBlockingQueue<Runnable>());

    private static String svnRepo = null;
    private static final String svnUser =
        System.getenv("SVN_USER") == null ? "jmg3" : System.getenv("SVN_USER");
    private static final String svnPassword =
        System.getenv("SVN_PASSWORD") == null ? "" :
        System.getenv("SVN_PASSWORD");
    private final static SVNClientManager ourClientManager =
        SVNClientManager.newInstance(SVNWCUtil.createDefaultOptions(true),
                svnUser, svnPassword);

    private static String junit = null;
    private static String hamcrest = null;
    private static String hj = null;
    private static String asm = null;

    private static String conductorHost = null;
    private static int conductorPort = 0;

    public static void log(String format, Object... args) {
        StackTraceElement[] stack = Thread.currentThread().getStackTrace();
        StackTraceElement callee = stack[2];
        String calleeClassname = callee.getClassName();
        String timestamp = new SimpleDateFormat("yyyy.MM.dd.HH.mm.ss").format(new Date());
        System.out.printf(timestamp + " " + calleeClassname + ": " + format, args);
    }

    private static String getEnvVarOrFail(String varname) {
      String val = System.getenv(varname);
      if (val == null) {
        throw new RuntimeException(varname + " must be set");
      }
      return val;
    }

    public static void main(String[] args) throws IOException {
        if (args.length != 3) {
            System.err.println("usage: java Viola viola-port conductor-host conductor-port");
            System.exit(1);
        }
        int port = Integer.parseInt(args[0]);
        conductorHost = args[1];
        conductorPort = Integer.parseInt(args[2]);

        svnRepo = System.getenv("SVN_REPO");
        if (svnRepo == null) {
            svnRepo = "https://svn.rice.edu/r/parsoft/projects/AutoGrader/student-runs";
        }

        junit = getEnvVarOrFail("JUNIT_JAR");
        hamcrest = getEnvVarOrFail("HAMCREST_JAR");
        hj = getEnvVarOrFail("HJ_JAR");
        asm = getEnvVarOrFail("ASM_JAR");

        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/run", new RunHandler());
        // Executor for handling incoming connections
        server.setExecutor(new ThreadPoolExecutor(2, 4, 60, TimeUnit.SECONDS, new LinkedBlockingQueue<Runnable>()));
        server.start();
    }

    static class RunHandler implements HttpHandler {
        public void handle(HttpExchange t) throws IOException {
            log("Received request - %s\n", t.getRequestURI().getQuery());

            Map <String, String> parms = Viola.queryToMap(t.getRequestURI().getQuery());
            String err_msg = null;
            if (!parms.containsKey("done_token")) {
                err_msg = "Missing done token";
            } else if (!parms.containsKey("user")) {
                err_msg = "Missing username";
            } else if (!parms.containsKey("assignment")) {
                err_msg = "Missing assignment name";
            } else if (!parms.containsKey("run")) {
                err_msg = "Missing run ID";
            } else if (!parms.containsKey("assignment_id")) {
                err_msg = "Missing assignment ID";
            }

            if (err_msg != null) {
                log("Error - %s\n", err_msg);
                writeResponse(t, "{ \"status\": \"Failure\", \"msg\": \"" +
                        err_msg + "\" }");
            } else {
                final String done_token = parms.get("done_token");
                final String user = parms.get("user");
                final String assignment_name = parms.get("assignment");
                final int run_id = Integer.parseInt(parms.get("run"));
                final int assignment_id = Integer.parseInt(parms.get("assignment_id"));
                log("starting tests for user=%s assignment=%s run=%d assignment_id=%d\n", user,
                        assignment_name, run_id, assignment_id);

                final LocalTestRunner runnable = new LocalTestRunner(done_token,
                        user, assignment_name, run_id, assignment_id);
                exec.execute(runnable);
                writeResponse(t, "{ \"status\": \"Success\" }");
            }
        }
    }

    public static void writeResponse(HttpExchange httpExchange, String response) throws IOException {
        httpExchange.sendResponseHeaders(200, response.length());
        OutputStream os = httpExchange.getResponseBody();
        os.write(response.getBytes());
        os.close();
    }

    public static Map<String, String> queryToMap(String query){
        Map<String, String> result = new HashMap<String, String>();
        if (query != null) {
            for (String param : query.split("&")) {
                String pair[] = param.split("=");
                if (pair.length>1) {
                    result.put(pair[0], pair[1]);
                } else {
                    result.put(pair[0], "");
                }
            }
        }
        return result;
    }

    /*
     * Logic for actually running single-threaded tests.
     */
    static class LocalTestRunner implements Runnable {
        private final String done_token;
        private final String user;
        private final String assignment_name;
        private final int run_id;
        private final int assignment_id;

        public LocalTestRunner(String done_token, String user,
                String assignment_name, int run_id, int assignment_id) {
            this.done_token = done_token;
            this.user = user;
            this.assignment_name = assignment_name;
            this.run_id = run_id;
            this.assignment_id = assignment_id;
        }

        /*
         * Partially taken from http://stackoverflow.com/questions/4205980/java-sending-http-parameters-via-post-method-easily
         * TODO Problem here is we could fail silently to succeed.
         */
        private void notifyConductor() {
            try {
                String urlParameters = "done_token=" + done_token;
                byte[] postData = urlParameters.getBytes(StandardCharsets.UTF_8);
                int postDataLength = postData.length;
                // TODO make configurable
                String request = "http://" + conductorHost + ":" +
                  conductorPort + "/local_run_finished";
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

                log("Conductor notification response for done_token=%s: %s\n",
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

        private ProcessResults runInProcess(String[] cmd, File working_dir)
            throws IOException, InterruptedException {
          Process p = Runtime.getRuntime().exec(cmd, new String[0], working_dir);
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

          int exitCode = p.waitFor();

          return new ProcessResults(stdout.toString(), stderr.toString(), exitCode);
        }

        @Override
        public void run() {
            log("Running local tests for user=%s assignment=%s run=%d\n",
                    user, assignment_name, run_id);

            try {
                final File code_dir = getTempDirectory();
                final File instructor_dir = getTempDirectory();
                final File extract_code_dir = getTempDirectory();
                final File extract_instructor_dir = getTempDirectory();

                /*
                 * Check out the student code from SVN. This should check out a
                 * single directory with a single ZIP file inside.
                 */
                SVNUpdateClient updateClient = ourClientManager.getUpdateClient();
                updateClient.setIgnoreExternals(false);

                log("Checking student code out to %s\n", code_dir.getAbsolutePath());
                updateClient.doCheckout(SVNURL.parseURIDecoded(svnRepo + "/" +
                            user + "/" + assignment_name + "/" + run_id),
                        code_dir, SVNRevision.HEAD, SVNRevision.HEAD, SVNDepth.INFINITY, false);

                log("Checking instructor code out to %s\n", instructor_dir.getAbsolutePath());
                updateClient.doCheckout(SVNURL.parseURIDecoded(svnRepo +
                      "/assignments/" + assignment_id), instructor_dir,
                    SVNRevision.HEAD, SVNRevision.HEAD, SVNDepth.INFINITY,
                    false);

                extract_code_dir.mkdir();
                extract_instructor_dir.mkdir();

                log("Target code directory = " + extract_code_dir.getAbsolutePath() + "\n");
                log("Target instructor directory = " + extract_instructor_dir.getAbsolutePath() + "\n");

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
                    return new File(current, name).isDirectory();
                  }
                };
                String[] code_directories = extract_code_dir.list(dirsOnly);
                String[] instructor_directories = extract_instructor_dir.list(dirsOnly);

                if (code_directories.length != 1) {
                  throw new TestRunnerException("Unexpected number of code directories (" +
                      code_directories.length + ")");
                }
                if (instructor_directories.length != 1) {
                  throw new TestRunnerException("Unexpected number of instructor directories (" +
                      instructor_directories.length + ")");
                }

                final File unzipped_code_dir = new File(extract_code_dir, code_directories[0]);
                final File unzipped_instructor_dir = new File(extract_instructor_dir,
                    instructor_directories[0]);

                /*
                 * Run checkstyle
                 */
                final File checkstyle_config = File.createTempFile("temp",
                    ".xml");
                log("Checkstyle config file = " + checkstyle_config.getAbsolutePath() + "\n");
                PrintWriter writer = new PrintWriter(
                    checkstyle_config.getAbsolutePath(), "UTF-8");
                writer.println("<?xml version=\"1.0\"?>");
                writer.println("<!DOCTYPE module PUBLIC \"-//Puppy Crawl//DTD " +
                    "Check Configuration 1.2//EN\" \"http://www.puppycrawl.com/" +
                    "dtds/configuration_1_2.dtd\">");
                writer.println("<module name=\"Checker\">");
                writer.println("    <module name=\"JavadocPackage\"/>");
                writer.println("    <module name=\"TreeWalker\">");
                writer.println("         <module name=\"AvoidStarImport\"/>");
                writer.println("         <module name=\"ConstantName\"/>");
                writer.println("         <module name=\"EmptyBlock\"/>");
                writer.println("         <module name=\"LeftCurly\"/>");
                writer.println("         <module name=\"RightCurly\"/>");
                writer.println("    </module>");
                writer.println("</module>");
                writer.close();

                File mainCodeFolder = new File(new File(unzipped_code_dir, "src"), "main");
                List<String> studentJavaFiles = findAllJavaFiles(mainCodeFolder, false);

                String[] checkstyle_cmd = new String[3 + studentJavaFiles.size()];
                checkstyle_cmd[0] = "checkstyle";
                checkstyle_cmd[1] = "-c";
                checkstyle_cmd[2] = checkstyle_config.getAbsolutePath();
                int checkstyle_index = 3;
                for (String filename : studentJavaFiles) {
                    checkstyle_cmd[checkstyle_index++] = filename;
                }

                ProcessResults checkstyle_results = runInProcess(checkstyle_cmd,
                    unzipped_code_dir);
                writer = new PrintWriter(
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
                 * Merge the student-provided code with the instructor-provided
                 * code into a single folder hierarchy.
                 */
                merge_dirs(unzipped_code_dir, unzipped_instructor_dir);
                final File pom = new File(instructor_dir, "instructor_pom.xml");
                pom.renameTo(new File(unzipped_code_dir, "pom.xml"));

                /*
                 * Compile the full application and testing suite
                 */
                String[] cmd = new String[]{"mvn", "clean", "compile", "test-compile"};
                ProcessResults mvn_results = runInProcess(cmd, unzipped_code_dir);
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
                      ".:target/classes:target/test-classes:" + junit + ":" +
                      hamcrest + ":" + hj + ":" + asm;
                  final String[] junit_cmd = new String[]{"java",
                      "-Dhj.numWorkers=1", "-javaagent:" + hj, "-cp",
                      classpath, "org.junit.runner.JUnitCore", classname};
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

                log("Filled correctness log file\n");

                // Add the generated files to the repo
                ourClientManager.getWCClient().doAdd(
                        new File(code_dir.getAbsolutePath(), "correct.txt"), false,
                        false, false, SVNDepth.INFINITY, false, false);
                ourClientManager.getWCClient().doAdd(
                        new File(code_dir.getAbsolutePath(), "checkstyle.txt"), false,
                        false, false, SVNDepth.INFINITY, false, false);
                ourClientManager.getWCClient().doAdd(
                        new File(code_dir.getAbsolutePath(), "findbugs.txt"), false,
                        false, false, SVNDepth.INFINITY, false, false);

                log("Added log file to repo\n");

                // Commit the added files to the repo
                File[] wc = new File[1];
                wc[0] = new File(code_dir.getAbsolutePath());
                final String commitMessage =
                    user + " " + assignment_name + " " + run_id + " local-runs";
                try {
                    ourClientManager.getCommitClient().doCommit(wc, false,
                            commitMessage, false, true);
                } catch (SVNException svn) {
                    /*
                     * For now (while the Habanero repo is still misconfigured)
                     * we ignore commit failures.
                     */
                    svn.printStackTrace();
                }

                log("Committed log file to repo\n");

                /*
                 * Clean up the test directory. This assumes that no directories
                 * are created in the process of testing.
                 */
                delete_dir(code_dir);
                delete_dir(instructor_dir);
                delete_dir(extract_code_dir);
                delete_dir(extract_instructor_dir);

                log("Done with local testing\n");
            } catch (IOException io) {
                io.printStackTrace();
            } catch (InterruptedException ie) {
                ie.printStackTrace();
            } catch (SVNException svn) {
                svn.printStackTrace();
            } catch (TestRunnerException tr) {
                tr.printStackTrace();
            }

            notifyConductor();
            log("Finished local tests for user=%s assignment=%s run=%d\n", user,
                    assignment_name, run_id);
        }
    }

    static class TestRunnerException extends Exception {
        public TestRunnerException(String msg) { super(msg); }
    }
}
