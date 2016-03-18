
public class ViolaEnv {
  public final String conductorHost;
  public final int conductorPort;
  public final String conductorUser;

  public final String junit;
  public final String hamcrest;
  public final String mavenRepo;
  public final String asm;
  public final String checkstyle;
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
