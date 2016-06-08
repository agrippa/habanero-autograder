import java.util.concurrent.BlockingQueue;
import java.util.Collection;
import java.util.concurrent.TimeUnit;
import java.util.Iterator;
import java.util.List;
import java.util.LinkedList;
import java.util.Map;
import java.util.HashMap;
import java.util.PriorityQueue;
import java.util.concurrent.Executor;

/**
 * The FairViolaTaskExecutor implements fair-share scheduling for users accessing Viola, giving higher priority to
 * submissions from users that have not been recently submitting large amounts of jobs.
 */
public class FairViolaTaskExecutor {
  private final long windowSizeMilliseconds = 120 * 60 * 1000; // 2 hours
  private final LinkedList<TaskExecution> executedTaskWindow =
    new LinkedList<TaskExecution>();
  private PriorityQueue<TasksInWindow> userPriorities =
    new PriorityQueue<TasksInWindow>();
  private final Map<String, TasksInWindow> tasksInWindowPerUser =
    new HashMap<String, TasksInWindow>();
  private final Map<String, LinkedList<LocalTestRunner>> pendingTasks =
    new HashMap<String, LinkedList<LocalTestRunner>>();
  private int nPending = 0;

  // The underlying thread pool user tests are executed on.
  private final Thread[] workerThreads;
  private final LocalTestRunner[] runningTasks;

  public FairViolaTaskExecutor(int nthreads) {
    this.workerThreads = new Thread[nthreads];
    this.runningTasks = new LocalTestRunner[nthreads];
    for (int t = 0; t < nthreads; t++) {
      this.workerThreads[t] = new Thread(new ViolaRunner(t));
      this.workerThreads[t].start();
    }
  }

  // Enqueue a new job to be run by the Viola component.
  private void newPendingTask(LocalTestRunner r, String username) {
    synchronized(this) {
      if (!tasksInWindowPerUser.containsKey(username)) {
        TasksInWindow inWindow = new TasksInWindow(username);
        tasksInWindowPerUser.put(username, inWindow);
        userPriorities.add(inWindow);

        pendingTasks.put(username, new LinkedList<LocalTestRunner>());
      }

      pendingTasks.get(username).add(r);
      nPending++;

      this.notify();
    }
  }

  // Find a new piece of work to process.
  private LocalTestRunner getPendingTask(int tid) {
    LocalTestRunner result = null;

    synchronized(this) {
      while (nPending == 0) {
        try {
          this.wait();
        } catch (InterruptedException ie) {
        }
      }

      PriorityQueue<TasksInWindow> newUserPriorities =
        new PriorityQueue<TasksInWindow>();
      final long currentTime = System.currentTimeMillis();
      final long windowStart = currentTime - windowSizeMilliseconds;

      while (!executedTaskWindow.isEmpty() && executedTaskWindow.peek().time < windowStart) {
        TaskExecution task = executedTaskWindow.poll();
        // Passed beyond our current window
        tasksInWindowPerUser.get(task.user).decrCount();
      }

      while (!userPriorities.isEmpty() && result == null) {
        final TasksInWindow inWindow = userPriorities.poll();
        final String username = inWindow.getUsername();
        final LinkedList<LocalTestRunner> pending = pendingTasks.get(username);

        if (!pending.isEmpty()) {
          result = pending.poll(); // will cause break from while loop
          inWindow.incrCount();
          executedTaskWindow.add(new TaskExecution(System.currentTimeMillis(), username));
          newUserPriorities.add(inWindow);
          newUserPriorities.addAll(userPriorities);
        } else {
          newUserPriorities.add(inWindow);
        }
      }
      userPriorities = newUserPriorities;

      assert result != null;
      nPending--;

      ViolaUtil.log("thread %d got run %d to process, %d remaining pending " +
              "tasks\n", tid, result.getRunId(), nPending);

      runningTasks[tid] = result;
    }
    return result;
  }

  public void execute(LocalTestRunner command) {
    newPendingTask(command, command.getUser());
  }

  /**
   * Try to cancel a job on the Viola component, either by removing it from the list of pending tasks or by interrupting
   * the thread handling its execution.
   */
  public boolean cancel(String done_token) {
      synchronized (this) {
          for (Map.Entry<String, LinkedList<LocalTestRunner>> entry : pendingTasks.entrySet()) {
              LocalTestRunner found = null;
              for (LocalTestRunner runner : entry.getValue()) {
                  if (runner.getDoneToken().equals(done_token)) {
                      found = runner;
                      break;
                  }
              }

              if (found != null) {
                  ViolaUtil.log("found run to cancel in pending tasks list, removing.\n");
                  final boolean removed = entry.getValue().remove(found);
                  assert removed;
                  nPending--;
                  return true;
              }
          }

          for (int i = 0; i < runningTasks.length; i++) {
              if (runningTasks[i] != null && runningTasks[i].getDoneToken().equals(done_token)) {
                  ViolaUtil.log("signaling thread %d to cancel run.\n", i);
                  runningTasks[i].setBeingCancelled();
                  workerThreads[i].interrupt();

                  while (runningTasks[i] != null && runningTasks[i].getDoneToken().equals(done_token)) {
                      try {
                          ViolaUtil.log("waiting on running task to complete\n");
                          this.wait();
                      } catch (InterruptedException ie) {
                          ViolaUtil.log("cancellation thread got interrupted exception\n");
                      }
                  }

                  ViolaUtil.log("finished waiting on running task to complete\n");
                  return true;
              }
          }
      }

      return false;
  }

  /**
   * Implements the core work loop for the Viola's thread pool. This class is responsible for basically polling for new
   * work and then executing it.
   */
  class ViolaRunner implements Runnable {
      private final int tid;

      public ViolaRunner(int tid) {
          this.tid = tid;
      }

      @Override
      public void run() {
          while (true) {
              LocalTestRunner r = null;
              try {
                  r = getPendingTask(tid);
                  r.run(tid);
              } catch (Throwable t) {
                  ViolaUtil.log("thread %d got a top-level unhandled exception:\n");
                  t.printStackTrace();
              } finally {
                  if (r == null) {
                      ViolaUtil.log("thread %d notifying of completion of null run\n", tid);
                  } else {
                      ViolaUtil.log("thread %d notifying of completion of run %d\n", tid, r.getRunId());
                  }
                  synchronized(FairViolaTaskExecutor.this) {
                      runningTasks[tid] = null;
                      FairViolaTaskExecutor.this.notifyAll();
                  }
              }
          }
      }
  }

  /**
   * Represents a single submission by a single user. TaskExecution objects are tracked to help enforce the fair-share
   * policy implemented by this executor.
   */
  class TaskExecution implements Comparable<TaskExecution> {
    public final long time;
    public final String user;

    public TaskExecution(long time, String user) {
      this.time = time;
      this.user = user;
    }

    @Override
    public int compareTo(TaskExecution other) {
      return (int)(this.time - other.time);
    }

    @Override
    public boolean equals(Object obj) {
      if (obj instanceof TaskExecution) {
        TaskExecution other = (TaskExecution)obj;
        return other.time == this.time && other.user.equals(this.user);
      }
      return false;
    }

    @Override
    public int hashCode() {
      return (int)time;
    }
  }

  /**
   * TasksInWindow counts the number of tasks that have executed within a recent window of time, in support of the
   * fair-share scheduling policy.
   */
  class TasksInWindow implements Comparable<TasksInWindow> {
    private int count;
    private final String username;

    public TasksInWindow(String username) {
      this.username = username;
      this.count = 0;
    }

    public int getCount() {
      return count;
    }

    public String getUsername() {
      return username;
    }

    public void incrCount() {
      count++;
    }

    public void decrCount() {
      count--;
    }

    @Override
    public int compareTo(TasksInWindow other) {
      return this.count - other.count;
    }
  }
}
