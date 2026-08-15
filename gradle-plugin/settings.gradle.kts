rootProject.name = "plugwright"

// plugwright-api      — stable contract third-party modes compile against
// plugwright-core     — mode-agnostic engine: extension, mode registry, generic tasks
// plugwright-local    — built-in "local" mode; also hosts the published plugin id for now,
//                    until a dedicated bundle module registers it alongside plugwright-external
// plugwright-external — built-in "external" mode: attaches to an already-running server
include(":plugwright-api")
include(":plugwright-core")
include(":plugwright-local")
include(":plugwright-external")
