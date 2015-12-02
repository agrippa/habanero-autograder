import java.util.concurrent.BlockingQueue;
import java.util.Collection;
import java.util.concurrent.TimeUnit;
import java.util.Iterator;
import java.util.List;
import java.util.LinkedList;
import java.util.Map;
import java.util.HashMap;
import java.util.PriorityQueue;

public class FairViolaTaskQueue implements BlockingQueue<Runnable> {
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

  private void newPendingTask(LocalTestRunner r, String username) {
    System.err.println("New pending task for user=" + username + " run_id=" + r.getRunId());
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

  private Runnable getPendingTask() throws InterruptedException {
    System.err.println("Getting pending task");
    LocalTestRunner result = null;

    synchronized(this) {
      while (nPending == 0) {
        this.wait();
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
    }
    System.err.println("Got pending task result=" + result);
    return result;
  }

  @Override
  public boolean add(Runnable r) {
    LocalTestRunner actual = (LocalTestRunner)r;
    newPendingTask(actual, actual.getUser());
    return true;
  }

  @Override
  public boolean contains(Object obj) {
    throw new UnsupportedOperationException();
  }

  @Override
  public int drainTo(Collection<? super Runnable> c) {
    throw new UnsupportedOperationException();
  }

  @Override
  public int drainTo(Collection<? super Runnable> c, int maxElements) {
    throw new UnsupportedOperationException();
  }

  @Override
  public boolean offer(Runnable r) {
    throw new UnsupportedOperationException();
  }

  @Override
  public boolean offer(Runnable r, long timeout, TimeUnit unit) {
    throw new UnsupportedOperationException();
  }

  @Override
  public Runnable poll(long timeout, TimeUnit unit) {
    throw new UnsupportedOperationException();
  }

  @Override
  public void put(Runnable r) {
    throw new UnsupportedOperationException();
  }

  @Override
  public int remainingCapacity() {
    throw new UnsupportedOperationException();
  }

  @Override
  public boolean remove(Object o) {
    throw new UnsupportedOperationException();
  }

  @Override
  public Runnable take() throws InterruptedException {
    return getPendingTask();
  }

  @Override
  public Runnable peek() {
    throw new UnsupportedOperationException();
  }

  @Override
  public Runnable poll() {
    throw new UnsupportedOperationException();
  }

  @Override
  public Runnable remove() {
    throw new UnsupportedOperationException();
  }

  @Override
  public Runnable element() {
    throw new UnsupportedOperationException();
  }

  @Override
  public void clear() {
    throw new UnsupportedOperationException();
  }

  @Override
  public boolean retainAll(Collection<?> c) {
    throw new UnsupportedOperationException();
  }

  @Override
  public boolean removeAll(Collection<?> c) {
    throw new UnsupportedOperationException();
  }

  @Override
  public boolean addAll(Collection<? extends Runnable> c) {
    throw new UnsupportedOperationException();
  }

  @Override
  public boolean containsAll(Collection<?> c) {
    throw new UnsupportedOperationException();
  }

  @Override
  public Object[] toArray() {
    throw new UnsupportedOperationException();
  }

  @Override
  public <T> T[] toArray(T[] a) {
    throw new UnsupportedOperationException();
  }

  @Override
  public Iterator<Runnable> iterator() {
    throw new UnsupportedOperationException();
  }

  @Override
  public boolean isEmpty() {
    throw new UnsupportedOperationException();
  }
  
  @Override
  public int size() {
    throw new UnsupportedOperationException();
  }

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
