package edu.rice.comp322;

import junit.framework.*;

public class StudentCorrectnessTest extends TestCase {
  private final AutoGraderExample example = new AutoGraderExample();

  public void testAdd() {
    assertEquals(example.sum(1, 3), 4);
  }

  public void testDouble() {
    assertEquals(example.dbl(3), 6);
  }

  public void testTriple() {
    assertEquals(example.triple(4), 12);
  }

  public void testMult() {
    assertEquals(example.mult(5, 5), 25);
  }
}
