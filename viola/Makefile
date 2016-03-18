all: ViolaEnv.class TestRunnerException.class ViolaUtil.class LocalTestRunner.class FairViolaTaskExecutor.class Viola.class ExportToConductorRunnable.class NotifyConductorRunnable.class ImportFromConductorRunnable.class CommonUtils.class

FLAGS=-Xlint:deprecation -classpath .:commons-io-2.4.jar

ViolaEnv.class: ViolaEnv.java
	javac ${FLAGS} ViolaEnv.java

CommonUtils.class: CommonUtils.java
	javac ${FLAGS} CommonUtils.java

ImportFromConductorRunnable.class: ImportFromConductorRunnable.java
	javac ${FLAGS} ImportFromConductorRunnable.java

ExportToConductorRunnable.class: ExportToConductorRunnable.java
	javac ${FLAGS} ExportToConductorRunnable.java

NotifyConductorRunnable.class: NotifyConductorRunnable.java
	javac ${FLAGS} NotifyConductorRunnable.java

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

