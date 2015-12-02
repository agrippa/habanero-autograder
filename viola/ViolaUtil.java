import java.util.Date;
import java.text.SimpleDateFormat;

public class ViolaUtil {
    public static void log(String format, Object... args) {
        StackTraceElement[] stack = Thread.currentThread().getStackTrace();
        StackTraceElement callee = stack[2];
        String calleeClassname = callee.getClassName();
        String timestamp = new SimpleDateFormat("yyyy.MM.dd.HH.mm.ss").format(new Date());
        System.err.printf(timestamp + " " + calleeClassname + ": " + format, args);
    }
}

