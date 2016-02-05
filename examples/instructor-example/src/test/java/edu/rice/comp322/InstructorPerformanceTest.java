package edu.rice.comp322;

import junit.framework.*;

public class InstructorPerformanceTest extends TestCase {
  private final AutoGraderExample example = new AutoGraderExample();

  public void testAdd() {
    assertEquals(example.sum(10, 20), 30);
  }

  public void testDouble() {
    assertEquals(example.dbl(15), 30);
  }

  public void testTriple() {
    assertEquals(example.triple(20), 60);
  }

  public void testMult() {
    assertEquals(example.mult(10, 10), 100);
  }
}
