import org.tmatesoft.svn.core.wc.SVNClientManager;

public class ViolaEnv {
  public final String conductorHost;
  public final int conductorPort;

  public final SVNClientManager ourClientManager;
  public final String svnRepo;

  public final String junit;
  public final String hamcrest;
  public final String hj;
  public final String asm;

  public ViolaEnv(String conductorHost, int conductorPort,
      SVNClientManager ourClientManager, String svnRepo, String junit,
      String hamcrest, String hj, String asm) {
    this.conductorHost = conductorHost;
    this.conductorPort = conductorPort;

    this.ourClientManager = ourClientManager;
    this.svnRepo = svnRepo;

    this.junit = junit;
    this.hamcrest = hamcrest;
    this.hj = hj;
    this.asm = asm;
  }
}
