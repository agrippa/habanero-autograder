package edu.rice.comp322;

import junit.framework.*;

import static edu.rice.hj.Module0.launchHabaneroApp;
import edu.rice.hj.api.SuspendableException;

public class CryptPerformanceTest extends TestCase {

    private void checkCorrectness(String lbl, int size) throws SuspendableException {
      final Crypt crypt = new Crypt(size);

      PerfTestUtils.runPerfTest(lbl, () -> crypt.Do(),
          () -> assertFalse("Test failure for size=" + size, crypt.validate()));
    }

    public void testCorrectness1(){
        final String lbl = PerfTestUtils.getTestLabel();
        launchHabaneroApp(() -> {
          checkCorrectness(lbl, 2000000);
        });
    }

    public void testCorrectness2(){
        final String lbl = PerfTestUtils.getTestLabel();
        launchHabaneroApp(() -> {
          checkCorrectness(lbl, 50000000);
        });
    }

    public void testCorrectness3(){
        final String lbl = PerfTestUtils.getTestLabel();
        launchHabaneroApp(() -> {
          checkCorrectness(lbl, 80000000);
        });
    }
}
