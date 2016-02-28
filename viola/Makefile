all: ViolaEnv.class TestRunnerException.class ViolaUtil.class LocalTestRunner.class FairViolaTaskExecutor.class Viola.class SVNImportRunnable.class

FLAGS=-Xlint:deprecation -classpath .:lib/svnkit-1.8.11/lib/svnkit-1.8.11.jar:commons-io-2.4.jar

ViolaEnv.class: ViolaEnv.java
	javac ${FLAGS} ViolaEnv.java

SVNImportRunnable.class: SVNImportRunnable.java
	javac ${FLAGS} SVNImportRunnable.java

TestRunnerException.class: TestRunnerException.java
	javac ${FLAGS} TestRunnerException.java

ViolaUtil.class: ViolaUtil.java
	javac ${FLAGS} ViolaUtil.java

Viola.class: Viola.java
	javac ${FLAGS} Viola.java

FairViolaTaskExecutor.class: FairViolaTaskExecutor.java
	javac ${FLAGS} FairViolaTaskExecutor.java

LocalTestRunner.class: LocalTestRunner.java
	javac ${FLAGS} LocalTestRunner.java

clean:
	rm -f *.class

run:
	./deploy.sh localhost 8000

