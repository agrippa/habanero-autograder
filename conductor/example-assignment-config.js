/*
 * This is an example of a JSON grading configuration file. It is split into
 * three sections: correctness, performance, and style.
 *
 * correctness is a list of test-name and points-worth tuples, and applies only
 * to correctness tests run under Viola.
 *
 * performance is a list of tests, for each specifying ranges of speedups and
 * the points-off associated with each.
 *
 * style specifies the points to take off per checkstyle error, with a maximum
 * number of points off to limit excessive points loss.
 */
{
  "correctness": [
    { "testname": "edu.rice.comp322.CryptCorrectnessTest.testCorrectness1", "points_worth": 10.0 },
    { "testname": "edu.rice.comp322.CryptCorrectnessTest.testCorrectness2", "points_worth": 10.0 },
    { "testname": "edu.rice.comp322.CryptCorrectnessTest.testCorrectness3", "points_worth": 10.0 }
  ],
  "performance": [
    { "testname": "edu.rice.comp322.CryptPerformanceTest.testCorrectness1",
      /* Fairly normal grading, no points off for 4x or better, 6 points off for 2-4x, 8 points off for less than 2x */
      "grading": [
        { "bottom_inclusive": 0.0, "top_exclusive": 2.0,  "points_off": 8.0 },
        { "bottom_inclusive": 2.0, "top_exclusive": 4.0,  "points_off": 6.0 },
        { "bottom_inclusive": 4.0, "top_exclusive": -1.0, "points_off": 0.0 }]
    },
    { "testname": "edu.rice.comp322.CryptPerformanceTest.testCorrectness2",
      /* Fairly harsh grading, no points off for 10x or better, 6 points off for 8-10x, 8 points off for less than 8x */
      "grading": [
        { "bottom_inclusive": 0.0,  "top_exclusive": 8.0,  "points_off": 8.0 },
        { "bottom_inclusive": 8.0,  "top_exclusive": 10.0, "points_off": 6.0 },
        { "bottom_inclusive": 10.0, "top_exclusive": -1.0, "points_off": 0.0 }]
    },
    { "testname": "edu.rice.comp322.CryptPerformanceTest.testCorrectness3",
      /* Fairly generous grading, no points off for 2x or better, 6 points off for 1-2x, 8 points off for less than 1x */
      "grading": [
        { "bottom_inclusive": 0.0, "top_exclusive": 1.0,  "points_off": 8.0 },
        { "bottom_inclusive": 1.0, "top_exclusive": 2.0,  "points_off": 6.0 },
        { "bottom_inclusive": 2.0, "top_exclusive": -1.0, "points_off": 0.0 }]
    }
  ],
  "style": {
    "points_per_error": 0.1,
    "max_points_off": 4.0
  }
}
