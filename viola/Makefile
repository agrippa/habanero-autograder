all: ViolaEnv.class TestRunnerException.class ViolaUtil.class LocalTestRunner.class FairViolaTaskQueue.class Viola.class

ViolaEnv.class: ViolaEnv.java
	javac -Xlint:deprecation -classpath .:lib/svnkit-1.8.11/lib/svnkit-1.8.11.jar ViolaEnv.java

TestRunnerException.class: TestRunnerException.java
	javac -Xlint:deprecation -classpath .:lib/svnkit-1.8.11/lib/svnkit-1.8.11.jar TestRunnerException.java

ViolaUtil.class: ViolaUtil.java
	javac -Xlint:deprecation -classpath .:lib/svnkit-1.8.11/lib/svnkit-1.8.11.jar ViolaUtil.java

Viola.class: Viola.java
	javac -Xlint:deprecation -classpath .:lib/svnkit-1.8.11/lib/svnkit-1.8.11.jar Viola.java

FairViolaTaskQueue.class: FairViolaTaskQueue.java
	javac -Xlint:deprecation -classpath .:lib/svnkit-1.8.11/lib/svnkit-1.8.11.jar FairViolaTaskQueue.java

LocalTestRunner.class: LocalTestRunner.java
	javac -Xlint:deprecation -classpath .:lib/svnkit-1.8.11/lib/svnkit-1.8.11.jar LocalTestRunner.java

clean:
	rm -f *.class

run:
	./deploy.sh

