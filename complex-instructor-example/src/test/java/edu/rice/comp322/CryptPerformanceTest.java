package edu.rice.comp322;

import junit.framework.*;

import java.net.URL;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.MalformedURLException;
import java.io.IOException;

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

    public void testNetworkConnectivity() {
      try {
        URL oracle = new URL("http://www.oracle.com/");
        BufferedReader in = new BufferedReader(
            new InputStreamReader(oracle.openStream()));

        String inputLine;
        while ((inputLine = in.readLine()) != null) {
          ;
        }
        in.close();
      } catch (MalformedURLException m) {
      } catch (IOException io) {
      }
    }
}
