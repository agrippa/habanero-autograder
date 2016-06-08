/**
 * Encapsulates various constant environmental information that needs to be passed to several components.
 */
public class ViolaEnv {
    // Hostname of the conductor
    public final String conductorHost;
    // Port at which the conductor is listening for HTTP requests
    public final int conductorPort;
    // SSH user on the conductor
    public final String conductorUser;

    // Local path to the JUnit JAR
    public final String junit;
    // Local path to the hamcrest JAR
    public final String hamcrest;
    public final String mavenRepo;
    // Local path to the ASM JAR
    public final String asm;
    // Local path to the checkstyle JAR
    public final String checkstyle;
    // Root directory of the local autograder installation
    public final String autograderHome;

    public ViolaEnv(String conductorHost, int conductorPort, String conductorUser, String junit, String hamcrest,
            String mavenRepo, String asm, String checkstyle,  String autograderHome) {
        this.conductorHost = conductorHost;
        this.conductorPort = conductorPort;
        this.conductorUser = conductorUser;

        this.junit = junit;
        this.hamcrest = hamcrest;
        this.mavenRepo = mavenRepo;
        this.asm = asm;
        this.autograderHome = autograderHome;
        this.checkstyle = checkstyle;
    }
}
