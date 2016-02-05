package edu.rice.comp322;

import edu.rice.hj.api.SuspendableException;

import static edu.rice.hj.Module0.finish;
import static edu.rice.hj.Module1.forall;
import static edu.rice.hj.Module1.forallChunked;
import static edu.rice.hj.Module1.launchHabaneroApp;


public class Crypt extends IDEA {
    public Crypt(int size) {
        this.array_rows = size;
        buildTestData();
    }

    public boolean validate() {
        boolean error = false;

        for (int i = 0; i < array_rows; i++){
            error = (plain1 [i] != plain2 [i]);

            if (error){
                System.out.println("Validation failed");
                System.out.println("Original Byte " + i + " = " + plain1[i]);
                System.out.println("Encrypted Byte " + i + " = " + crypt1[i]);
                System.out.println("Decrypted Byte " + i + " = " + plain2[i]);
                break;
            }
        }
        return error;
    }

    public void freeTestData() {
        plain1 = null;
        crypt1 = null;
        plain2 = null;
        userkey = null;
        Z = null;
        DK = null;

        System.gc();                // Force garbage collection.
    }

    public static long time(int size, int repeats) throws SuspendableException{
        long sumExecutionTime = 0;
        for (int r = 0; r < repeats; r++) {
            final Crypt crypt = new Crypt(size);

            final long executionTime = crypt.Do();

            sumExecutionTime += executionTime;
        }
        return sumExecutionTime / repeats;
    }

    public static void main(String[] args) {

      launchHabaneroApp(() -> {
        final int size = (args.length > 0 ? Integer.parseInt(args[0]) : 3000000);
        final int repeats = (args.length > 1 ? Integer.parseInt(args[1]) : 30);

        long time = time(size, repeats);

        System.out.println(String.format("Processing of %d bytes took %d ms on average", size, time));

        Crypt crypt = new Crypt(size);
        crypt.Do();
      });
    }
}
