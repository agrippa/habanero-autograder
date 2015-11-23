import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;

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
    private static final ThreadPoolExecutor exec = new ThreadPoolExecutor(2, 4, 60, TimeUnit.SECONDS, new LinkedBlockingQueue<Runnable>());

    private static String svnRepo = null;
    private static final String svnUser =
        System.getenv("SVN_USER") == null ? "jmg3" : System.getenv("SVN_USER");
    private static final String svnPassword =
        System.getenv("SVN_PASSWORD") == null ? "" :
        System.getenv("SVN_PASSWORD");
    private final static SVNClientManager ourClientManager =
        SVNClientManager.newInstance(SVNWCUtil.createDefaultOptions(true),
                svnUser, svnPassword);

    private static String conductorHost = null;
    private static int conductorPort = 0;

    public static void log(String format, Object... args) {
        StackTraceElement[] stack = Thread.currentThread().getStackTrace();
        StackTraceElement callee = stack[2];
        String calleeClassname = callee.getClassName();
        String timestamp = new SimpleDateFormat("yyyy.MM.dd.HH.mm.ss").format(new Date());
        System.out.printf(timestamp + " " + calleeClassname + ": " + format, args);
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
                String request = "http://" + conductorHost + ":" + conductorPort + "/local_run_finished";
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
                if (!target.exists()) {
                  target.mkdir();
                }
                merge_dirs(target, curr);
              } else {
                curr.renameTo(target);
              }
            }
        }

        @Override
        public void run() {
            log("Running local tests for user=%s assignment=%s run=%d\n",
                    user, assignment_name, run_id);

            try {
                final File code_dir = File.createTempFile("temp", Long.toString(System.nanoTime()));
                if(!(code_dir.delete())) {
                    throw new IOException("Could not delete temp file: " +
                            code_dir.getAbsolutePath());
                }
                final File instructor_dir = File.createTempFile("temp", Long.toString(System.nanoTime()));
                if(!(instructor_dir.delete())) {
                    throw new IOException("Could not delete temp file: " +
                            instructor_dir.getAbsolutePath());
                }

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

                log("Merging directories\n");
                merge_dirs(code_dir, instructor_dir);

                // Test code. Fill in some dummy text files for now
                PrintWriter writer = new PrintWriter(
                        code_dir.getAbsolutePath() + "/correct.txt", "UTF-8");
                writer.println("Local logs 1");
                writer.println("Local logs 2");
                writer.close();

                log("Filled dummy log file\n");

                // Add the generated files to the repo
                ourClientManager.getWCClient().doAdd(
                        new File(code_dir.getAbsolutePath(), "correct.txt"), false,
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

                log("Done with local testing\n");
            } catch (IOException io) {
                io.printStackTrace();
            } catch (SVNException svn) {
                svn.printStackTrace();
            }

            notifyConductor();
            log("Finished local tests for user=%s assignment=%s run=%d\n", user,
                    assignment_name, run_id);
        }
    }
}
