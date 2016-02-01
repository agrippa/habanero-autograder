import org.tmatesoft.svn.core.wc.SVNClientManager;

public class ViolaEnv {
  public final String conductorHost;
  public final int conductorPort;

  public final SVNClientManager ourClientManager;
  public final String svnRepo;

  public final String junit;
  public final String hamcrest;
  public final String mavenRepo;
  public final String asm;
  public final String checkstyle;
  public final String autograderHome;

  public ViolaEnv(String conductorHost, int conductorPort,
      SVNClientManager ourClientManager, String svnRepo, String junit,
      String hamcrest, String mavenRepo, String asm, String checkstyle,
      String autograderHome) {
    this.conductorHost = conductorHost;
    this.conductorPort = conductorPort;

    this.ourClientManager = ourClientManager;
    this.svnRepo = svnRepo;

    this.junit = junit;
    this.hamcrest = hamcrest;
    this.mavenRepo = mavenRepo;
    this.asm = asm;
    this.autograderHome = autograderHome;
    this.checkstyle = checkstyle;
  }
}
