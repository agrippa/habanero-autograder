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
    private static final FairViolaTaskQueue executorQueue = new FairViolaTaskQueue();
    // private static final BlockingQueue<Runnable> executorQueue = new LinkedBlockingQueue<Runnable>();
    private final static int poolSize = 4;
    private static final ThreadPoolExecutor exec = new ThreadPoolExecutor(poolSize, poolSize,
        60, TimeUnit.SECONDS, executorQueue);

    private static ViolaEnv env = null;

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
        final int port = Integer.parseInt(args[0]);
        final String conductorHost = args[1];
        final int conductorPort = Integer.parseInt(args[2]);

        final String svnUser =
            System.getenv("SVN_USER") == null ? "jmg3" : System.getenv("SVN_USER");
        final String svnPassword =
            System.getenv("SVN_PASSWORD") == null ? "" :
            System.getenv("SVN_PASSWORD");
        String svnRepo = System.getenv("SVN_REPO");
        if (svnRepo == null) {
            svnRepo = "https://svn.rice.edu/r/parsoft/projects/AutoGrader/student-runs";
        }
        while (svnRepo.endsWith("/")) {
            svnRepo = svnRepo.substring(0, svnRepo.length() - 1);
        }

        final String junit = getEnvVarOrFail("JUNIT_JAR");
        final String hamcrest = getEnvVarOrFail("HAMCREST_JAR");
        final String hj = getEnvVarOrFail("HJ_JAR");
        final String asm = getEnvVarOrFail("ASM_JAR");
        final String autograderHome = getEnvVarOrFail("AUTOGRADER_HOME");

        final SVNClientManager ourClientManager =
            SVNClientManager.newInstance(SVNWCUtil.createDefaultOptions(true),
                    svnUser, svnPassword);

        System.out.println("============== Viola ==============");
        System.out.printf("Viola port = %d\n", port);
        System.out.printf("Conductor  = %s:%d\n", conductorHost, conductorPort);
        System.out.printf("SVN        = %s @ %s\n", svnUser, svnRepo);
        System.out.printf("junit      = %s\n", junit);
        System.out.printf("hamcrest   = %s\n", hamcrest);
        System.out.printf("hj         = %s\n", hj);
        System.out.printf("asm        = %s\n", asm);
        System.out.printf("autograder = %s\n", autograderHome);
        System.out.println("===================================");

        env = new ViolaEnv(conductorHost, conductorPort,
            ourClientManager, svnRepo, junit, hamcrest, hj, asm, autograderHome);

        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/run", new RunHandler());
        // Executor for handling incoming connections
        server.setExecutor(exec);
        server.start();
    }

    static class RunHandler implements HttpHandler {
        public void handle(HttpExchange t) throws IOException {
            ViolaUtil.log("Received request - %s\n", t.getRequestURI().getQuery());

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
                ViolaUtil.log("Error - %s\n", err_msg);
                writeResponse(t, "{ \"status\": \"Failure\", \"msg\": \"" +
                        err_msg + "\" }");
            } else {
                final String done_token = parms.get("done_token");
                final String user = parms.get("user");
                final String assignment_name = parms.get("assignment");
                final int run_id = Integer.parseInt(parms.get("run"));
                final int assignment_id = Integer.parseInt(parms.get("assignment_id"));
                ViolaUtil.log("starting tests for user=%s assignment=%s run=%d assignment_id=%d\n", user,
                        assignment_name, run_id, assignment_id);

                final LocalTestRunner runnable = new LocalTestRunner(done_token,
                        user, assignment_name, run_id, assignment_id, env);
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
}
