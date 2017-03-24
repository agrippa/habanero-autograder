import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.FilenameFilter;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.util.LinkedList;
import java.util.List;
import java.util.concurrent.BlockingQueue;

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

/**
 * This is the main entrypoint for the viola component. This class sets up a web browser and offers endpoints for
 * submitting and cancelling Viola runs.
 */
public class Viola {
    // Executor for running the local tests
    private final static int poolSize = 8;
    private static final FairViolaTaskExecutor executor = new FairViolaTaskExecutor(poolSize);
    // Thread pool for accepting HTTP requests
    private static final ThreadPoolExecutor serverExecutor =
      new ThreadPoolExecutor(poolSize, poolSize, 60, TimeUnit.SECONDS,
          new LinkedBlockingQueue());

    private static ViolaEnv env = null;
    // Different queues between stages of the Viola pipeline
    private static final LinkedList<LocalTestRunner> toImport = new LinkedList<LocalTestRunner>();
    private static final LinkedList<LocalTestRunner> toExport = new LinkedList<LocalTestRunner>();
    private static final LinkedList<LocalTestRunner> toNotify = new LinkedList<LocalTestRunner>();

    private static String getEnvVarOrFail(String varname) {
      String val = System.getenv(varname);
      if (val == null) {
        throw new RuntimeException(varname + " must be set");
      }
      return val;
    }

    public static void main(String[] args) throws IOException {
        if (args.length != 4) {
            System.err.println("usage: java Viola viola-port conductor-host conductor-port conductor-user");
            System.exit(1);
        }
        final int port = Integer.parseInt(args[0]);
        final String conductorHost = args[1];
        final int conductorPort = Integer.parseInt(args[2]);
        final String conductorUser = args[3];

        final String junit = getEnvVarOrFail("JUNIT_JAR");
        final String hamcrest = getEnvVarOrFail("HAMCREST_JAR");
        final String mavenRepo = getEnvVarOrFail("HOME") + "/.m2/repository";
        final String asm = getEnvVarOrFail("ASM_JAR");
        final String autograderHome = getEnvVarOrFail("AUTOGRADER_HOME");
        final String checkstyle = getEnvVarOrFail("CHECKSTYLE_JAR");
        final String gorn = getEnvVarOrFail("GORN_JAR");

        System.out.println("============== Viola ==============");
        System.out.printf("Viola port = %d\n", port);
        System.out.printf("Conductor  = %s:%d\n", conductorHost, conductorPort);
        System.out.printf("junit      = %s\n", junit);
        System.out.printf("hamcrest   = %s\n", hamcrest);
        System.out.printf("maven repo = %s\n", mavenRepo);
        System.out.printf("asm        = %s\n", asm);
        System.out.printf("autograder = %s\n", autograderHome);
        System.out.printf("checkstyle = %s\n", checkstyle);
        System.out.printf("gorn       = %s\n", gorn);
        System.out.println("===================================");

        env = new ViolaEnv(conductorHost, conductorPort, conductorUser, junit, hamcrest, mavenRepo, asm, checkstyle,
                autograderHome, gorn);

        final ImportFromConductorRunnable importRunner = new ImportFromConductorRunnable(toImport, toNotify, executor);
        final Thread importThread = new Thread(importRunner);
        importThread.start();

        final ExportToConductorRunnable exportRunner = new ExportToConductorRunnable(toExport, toNotify);
        final Thread exportThread = new Thread(exportRunner);
        exportThread.start();

        final NotifyConductorRunnable notifyRunner = new NotifyConductorRunnable(toNotify);
        final Thread notifyThread = new Thread(notifyRunner);
        notifyThread.start();

        // Set up an HTTP server with run and cancellation endpoints
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/run", new RunHandler());
        server.createContext("/cancel", new CancelHandler());
        // Executor for handling incoming connections
        server.setExecutor(serverExecutor);
        server.start();
    }

    /**
     * Handler for cancellation requests.
     */
    static class CancelHandler implements HttpHandler {
        public void handle(HttpExchange t) throws IOException {
            ViolaUtil.log("Received cancel request - %s\n", t.getRequestURI().getQuery());
            Map <String, String> parms = Viola.queryToMap(t.getRequestURI().getQuery());
            String err_msg = null;
            if (!parms.containsKey("done_token")) {
                err_msg = "Missing done token";
            }

            if (err_msg != null) {
                ViolaUtil.log("Error - %s\n", err_msg);
                writeResponse(t, "{ \"status\": \"Failure\", \"msg\": \"" +
                        err_msg + "\" }");
            } else {
                final String done_token = parms.get("done_token");
                ViolaUtil.log("trying to cancel run with done_token=%s\n", done_token);
                boolean foundRun = false;
                try {
                    foundRun = executor.cancel(done_token);
                } finally {
                    writeResponse(t, "{ \"status\": \"Success\", \"found\": " +
                            foundRun + " }");
                }
            }
        }
    }

    /**
     * Handler for run requests.
     */
    static class RunHandler implements HttpHandler {
        public void handle(HttpExchange t) throws IOException {
            ViolaUtil.log("Received run request - %s\n", t.getRequestURI().getQuery());

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
            } else if (!parms.containsKey("jvm_args")) {
                err_msg = "Missing JVM args";
            } else if (!parms.containsKey("timeout")) {
                err_msg = "Missing test timeout";
            } else if (!parms.containsKey("submission_path")) {
                err_msg = "Missing submission path";
            } else if (!parms.containsKey("assignment_path")) {
                err_msg = "Missing assignment path";
            } else if (!parms.containsKey("required_files")) {
                err_msg = "Missing required files";
            }

            if (err_msg != null) {
                ViolaUtil.log("Error - %s\n", err_msg);
                writeResponse(t, "{ \"status\": \"Failure\", \"msg\": \"" +
                        err_msg + "\" }");
            } else {
                final String done_token = parms.get("done_token");
                final String user = parms.get("user");
                final String assignment_name = parms.get("assignment");
                final int run_id = Integer.parseInt(parms.get("run"));
                final int assignment_id = Integer.parseInt(parms.get("assignment_id"));
                final String jvm_args = parms.get("jvm_args");
                final int timeout = Integer.parseInt(parms.get("timeout"));
                final String assignmentPath = parms.get("assignment_path");
                final String submissionPath = parms.get("submission_path");
                final String requiredFiles = parms.get("required_files");

                ViolaUtil.log("starting tests for user=%s assignment=%s run=%d " +
                        "assignment_id=%d jvm_args=\"%s\" timeout=%d " +
                        "submission_path=%s assignment_path=%s required_files=%s\n", user,
                        assignment_name, run_id, assignment_id, jvm_args,
                        timeout, submissionPath, assignmentPath, requiredFiles);

                final LocalTestRunner runnable = new LocalTestRunner(done_token,
                        user, assignment_name, run_id, assignment_id, jvm_args,
                        timeout, env, toExport, assignmentPath, submissionPath,
                        requiredFiles);
                synchronized (toImport) {
                    toImport.add(runnable);
                    toImport.notify();
                }
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
}
