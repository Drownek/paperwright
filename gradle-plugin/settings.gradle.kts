rootProject.name = "plugwright"

// plugwright-api      — stable contract third-party modes compile against
// plugwright-core     — mode-agnostic engine: extension, mode registry, generic tasks
// plugwright-local    — built-in "local" mode
// plugwright-external — built-in "external" mode: attaches to an already-running server
// plugwright-bundle   — id "io.github.drownek.plugwright": applies core, registers local + external
include(":plugwright-api")
include(":plugwright-core")
include(":plugwright-local")
include(":plugwright-external")
include(":plugwright-bundle")
