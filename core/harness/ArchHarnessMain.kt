package com.mdeo.optimizer

/**
 * Runs the arch harness outside Gradle (`java -cp <test runtime classpath> com.mdeo.optimizer.ArchHarnessMainKt`),
 * configured by the same environment variables as ArchHarnessTest, so that several runs can go in
 * parallel (Gradle serialises test tasks of one project). See core/harness/harness.sh `runjava`.
 */
fun main() {
    ArchHarnessTest().`arch harness`()
}
