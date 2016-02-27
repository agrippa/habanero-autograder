import org.tmatesoft.svn.core.wc.SVNClientManager;

public class ViolaEnv {
  public final String conductorHost;
  public final int conductorPort;

  public final String svnRepo;
  public final String svnUser;
  public final String svnPassword;

  public final String junit;
  public final String hamcrest;
  public final String mavenRepo;
  public final String asm;
  public final String checkstyle;
  public final String autograderHome;

  public ViolaEnv(String conductorHost, int conductorPort,
      String svnRepo, String svnUser, String svnPassword, String junit,
      String hamcrest, String mavenRepo, String asm, String checkstyle,
      String autograderHome) {
    this.conductorHost = conductorHost;
    this.conductorPort = conductorPort;

    this.svnRepo = svnRepo;
    this.svnUser = svnUser;
    this.svnPassword = svnPassword;

    this.junit = junit;
    this.hamcrest = hamcrest;
    this.mavenRepo = mavenRepo;
    this.asm = asm;
    this.autograderHome = autograderHome;
    this.checkstyle = checkstyle;
  }
}
