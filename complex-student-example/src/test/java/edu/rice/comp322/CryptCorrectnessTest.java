package edu.rice.comp322;

import junit.framework.*;

import java.net.URL;
import java.io.BufferedReader;
import java.io.InputStreamReader;

import static edu.rice.hj.Module0.launchHabaneroApp;
import edu.rice.hj.api.SuspendableException;

public class CryptCorrectnessTest extends TestCase {

    private void checkCorrectness(int size) throws SuspendableException {
      final Crypt crypt = new Crypt(size);
      crypt.Do();
      // crypt.validate returns true on error
      assertFalse("Test failure for size=" + size, crypt.validate());
    }

    public void testCorrectness1(){
        launchHabaneroApp(() -> {
          checkCorrectness(200000);
        });
    }

    public void testCorrectness2(){
        launchHabaneroApp(() -> {
          checkCorrectness(500000);
        });
    }

    public void testCorrectness3(){
        launchHabaneroApp(() -> {
          checkCorrectness(800000);
        });
    }

    public void testCorrectness4() {
      assertFalse("Expected test failure", true);
    }

    public void testCorrectness5() {
      assertFalse("Expected test failure", true);
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
