rootProject.name = "plugwright"

// plugwright-api   — stable contract third-party modes compile against
// plugwright-core  — mode-agnostic engine: extension, mode registry, generic tasks
// plugwright-local — built-in "local" mode; also hosts the published plugin id for now,
//                    until a second built-in mode exists for a dedicated bundle module to combine
include(":plugwright-api")
include(":plugwright-core")
include(":plugwright-local")
