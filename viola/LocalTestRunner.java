import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.FilenameFilter;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.MalformedURLException;
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

import org.apache.commons.io.FileUtils;

/*
 * Logic for actually running single-threaded tests.
 */
public class LocalTestRunner {

    private final String done_token;
    private final String user;
    private final String assignment_name;
    private final int run_id;
    private final int assignment_id;
    private final String[] jvm_args;
    private final int timeout;
    private final String submissionPath;
    private final String assignmentPath;

    private File createdAssignmentDir = null;
    private File createdSubmissionDir = null;

    private final ViolaEnv env;
    private volatile boolean beingCancelled = false;

    private final List<String> createdDirectories = new LinkedList<String>();
    private final List<Process> createdProcesses = new LinkedList<Process>();

    private final List<String> createdFilesToSave = new LinkedList<String>();

    private File logDir = null;
    private String errMsg = null;

    private final LinkedList<LocalTestRunner> toImport;

    public LocalTestRunner(String done_token, String user,
            String assignment_name, int run_id, int assignment_id,
            String jvm_args, int timeout, ViolaEnv env, LinkedList<LocalTestRunner> toImport, String assignmentPath,
            String submissionPath) {
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
        this.assignmentPath = assignmentPath;
        this.submissionPath = submissionPath;

        this.toImport = toImport;
    }
   
    public List<String> getFilesToSave() { return createdFilesToSave; }
    public String getUser() {  return user; }
    public int getRunId() {  return run_id; }
    public String getDoneToken() { return done_token; }
    public String getAssignmentName() { return assignment_name; }
    public File getLogDir() { return logDir; }
    public String getErrMsg() { return errMsg; }
    public void setErrMsg(String msg) {
        ViolaUtil.log("Setting error message for run %d to %s\n", run_id, msg);
        errMsg = msg;
    }
    public ViolaEnv getEnv() { return env; }
    public String getSubmissionPath() { return submissionPath; }
    public String getAssignmentPath() { return assignmentPath; }

    public void setBeingCancelled() {
        beingCancelled = true;
    }

    public void setCreatedAssignmentDir(File f) {
        this.createdAssignmentDir = f;
        createdDirectories.add(f.getAbsolutePath());
    }

    public void setCreatedSubmissionDir(File f) {
        this.createdSubmissionDir = f;
        createdDirectories.add(f.getAbsolutePath());
    }

    /*
     * Partially taken from http://stackoverflow.com/questions/4205980/java-sending-http-parameters-via-post-method-easily
     * TODO Problem here is we could fail silently to succeed.
     */
    private void notifyConductor(String errMsg) throws MalformedURLException, IOException {
        if (errMsg == null) errMsg = "";

        String urlParameters = "done_token=" + done_token + "&err_msg=" + errMsg;
        byte[] postData = urlParameters.getBytes(StandardCharsets.UTF_8);
        int postDataLength = postData.length;
        String request = "http://" + env.conductorHost + ":" +
          env.conductorPort + "/local_run_finished";
        ViolaUtil.log("Notifying conductor at " + request + " of run " + run_id + " completion\n");

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

        ViolaUtil.log("Conductor notification response for err_msg=%s " +
                "done_token=%s: %s\n", errMsg, done_token, response.toString());
    }

    private void deleteDir(File dir) {
        try {
            FileUtils.deleteDirectory(dir);
        } catch (IOException io) {
            // ignore
        }
    }

    private void mergeDirs(File dst, File src) {
        for (String filename : src.list()) {
          File curr = new File(src.getAbsolutePath(), filename);
          File target = new File(dst.getAbsolutePath(), filename);
          if (curr.isDirectory()) {
            if (!curr.getName().equals(".svn")) {
              if (!target.exists()) {
                target.mkdir();
              }
              mergeDirs(target, curr);
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

    public void run(final int tid) {
        ViolaUtil.log("Running local tests for user=%s assignment=%s run=%d " +
                "jvm_args length=%d\n", user, assignment_name, run_id,
                jvm_args.length);

        File extractCodeDir = null;
        File extractInstructorDir = null;
        try {
            extractCodeDir = CommonUtils.getTempDirectoryName();
            createdDirectories.add(extractCodeDir.getAbsolutePath());
            extractInstructorDir = CommonUtils.getTempDirectoryName();
            createdDirectories.add(extractInstructorDir.getAbsolutePath());
            logDir = CommonUtils.getTempDirectoryName();
            createdDirectories.add(logDir.getAbsolutePath());

            final String lbl = String.format("run_id=%d", run_id);

            extractCodeDir.mkdir();
            extractInstructorDir.mkdir();
            logDir.mkdir();

            final String checkstyleOutputFile = logDir.getAbsolutePath() + "/checkstyle.txt";
            final String findbugsOutputFile = logDir.getAbsolutePath() + "/findbugs.txt";
            final String compileOutputFile = logDir.getAbsolutePath() + "/compile.txt";
            final String correctnessOutputFile = logDir.getAbsolutePath() + "/correct.txt";

            ViolaUtil.log("Target code directory = " + extractCodeDir.getAbsolutePath() + "\n");
            ViolaUtil.log("Target instructor directory = " + extractInstructorDir.getAbsolutePath() + "\n");

            String[] unzip_code = new String[]{"unzip", createdSubmissionDir.getAbsolutePath() + "/student.zip", "-d",
              extractCodeDir.getAbsolutePath()};
            String[] unzip_instructor = new String[]{"unzip", createdAssignmentDir.getAbsolutePath() + "/instructor.zip",
              "-d", extractInstructorDir.getAbsolutePath()};

            final CommonUtils.ProcessResults unzip_code_results = CommonUtils.runInProcess(lbl, unzip_code,
                    createdSubmissionDir, this.timeout, createdProcesses);
            if (unzip_code_results.code != 0) {
                throw new TestRunnerException("Error unzipping code");
            }

            final CommonUtils.ProcessResults unzip_instructor_results = CommonUtils.runInProcess(lbl, unzip_instructor,
                    createdAssignmentDir, this.timeout, createdProcesses);
            if (unzip_instructor_results.code != 0) {
                throw new TestRunnerException("Error unzipping instructor");
            }

            // Find all subdirectories, should only be 1
            FilenameFilter dirsOnly = new FilenameFilter() {
              @Override
              public boolean accept(File current, String name) {
                return !name.equals("__MACOSX") && new File(current, name).isDirectory();
              }
            };
            String[] code_directories = extractCodeDir.list(dirsOnly);
            String[] instructor_directories = extractInstructorDir.list(dirsOnly);

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

            final File unzipped_code_dir = new File(extractCodeDir, code_directories[0]);
            final File unzipped_instructor_dir = new File(extractInstructorDir,
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
            final File checkstyle_config = new File(createdAssignmentDir.getAbsolutePath() + "/checkstyle.xml");
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

            CommonUtils.ProcessResults checkstyleResults = CommonUtils.runInProcess(lbl, checkstyle_cmd,
                unzipped_code_dir, this.timeout, createdProcesses);
            CommonUtils.saveResultsToFile(checkstyleResults, checkstyleOutputFile, false);
            createdFilesToSave.add(checkstyleOutputFile);

            /*
             * Merge the student-provided test code with the instructor-provided
             * test code into a single folder hierarchy.
             */
            mergeDirs(mainTestFolder, unzipped_instructor_test_dir);
            final File pom = new File(createdAssignmentDir, "instructor_pom.xml");
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
            CommonUtils.ProcessResults mvnResults = CommonUtils.runInProcess(lbl, cmd, unzipped_code_dir, this.timeout, createdProcesses);
            CommonUtils.saveResultsToFile(mvnResults, compileOutputFile, true);
            createdFilesToSave.add(compileOutputFile);
            if (mvnResults.code != 0) {
              throw new TestRunnerException("Error compiling correctness " +
                  "tests from dir=" + unzipped_code_dir.getAbsolutePath() +
                  " with cmd=mvn clean compile test-compile");
            }

            /*
             * Run FindBugs
             */
            File targetFolder = new File(unzipped_code_dir, "target");
            if (!targetFolder.exists()) {
                throw new TestRunnerException("Maven failed to generate a target folder.");
            }
            String[] findbugsCmd = new String[]{"findbugs", "-textui",
                "-low", targetFolder.getAbsolutePath()};
            CommonUtils.ProcessResults findbugsResults = CommonUtils.runInProcess(lbl, findbugsCmd, unzipped_code_dir,
                    this.timeout, createdProcesses);
            CommonUtils.saveResultsToFile(findbugsResults, findbugsOutputFile, false);
            createdFilesToSave.add(findbugsOutputFile);

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

              final String osName = System.getProperty("os.name");
              final boolean isMacOs = osName.equals("Mac OS X");

              final String classname = test.replace('/', '.');

              final String classpath =
                  ".:target/classes:target/test-classes:" + env.junit + ":" +
                  env.hamcrest + ":" + hjJar + ":" + env.asm;
              final String policyPath = env.autograderHome + "/shared/security.policy";
              int junit_cmd_index = 0;
              final String[] junit_cmd;
              if (isMacOs) {
                  junit_cmd = new String[9 + jvm_args.length];
              } else {
                  // Linux?
                  junit_cmd = new String[12 + jvm_args.length];
                  junit_cmd[junit_cmd_index++] = "taskset";
                  junit_cmd[junit_cmd_index++] = "--cpu-list";
                  junit_cmd[junit_cmd_index++] = Integer.toString(tid);
              }

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
              assert junit_cmd_index == junit_cmd.length;
              CommonUtils.ProcessResults junit_results = CommonUtils.runInProcess(lbl, junit_cmd, unzipped_code_dir,
                      this.timeout, createdProcesses);
              /*
               * A non-zero exit code here can simply indicate a test
               * failure, so we ignore all error checking and continue.
               */

              stdout.append("Running " + classname + "\n");
              stdout.append(junit_results.stdout);
              stderr.append(junit_results.stderr);
            }

            final PrintWriter writer = new PrintWriter(correctnessOutputFile, "UTF-8");
            writer.println("======= STDOUT =======");
            writer.println(stdout.toString());
            writer.println("\n======= STDERR =======");
            writer.println(stderr.toString());
            writer.close();
            createdFilesToSave.add(correctnessOutputFile);

            ViolaUtil.log("Filled correctness log file\n");
        } catch (TestRunnerException tr) {
            errMsg = tr.getMessage();
            tr.printStackTrace();
        } catch (Throwable t) {
            errMsg = "An internal error occurred running the correctness tests.";
            t.printStackTrace();
        } finally {
            if (beingCancelled) {
                errMsg = "Cancelled by user";
            }

            synchronized(toImport) {
                toImport.push(this);
                toImport.notifyAll();
            }
        }
    }

    public void cleanup(String errMsg) throws MalformedURLException, IOException {
        for (String path : createdDirectories) {
            deleteDir(new File(path));
        }

        for (Process p : createdProcesses) {
            p.destroy();
        }

        ViolaUtil.log("Done with cleanup\n");

        notifyConductor(errMsg);
    }
}

