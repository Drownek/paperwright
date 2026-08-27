#!/usr/bin/env node

// Publishes every npm package in this repository.
//
// There are two places these packages need to reach, and they differ only in where they are
// sent and how the request is authenticated:
//
//   - npmjs.com, the public release. This is what the release workflow runs, and what
//     anyone reproducing a release runs locally. It is also the default here, so a bare
//     `npm run publish:packages` does the public thing.
//
//   - a registry of your own. An organisation behind a proxy, or one that mirrors its
//     dependencies, needs these packages somewhere its builds can reach. Pointing
//     `publishConfig.registry` at that registry inside each package.json would send the
//     public release there too, so the registry and its credentials live outside the
//     packages, in the environment.
//
// Configuration, every entry optional:
//
//   PLUGWRIGHT_NPM_REGISTRY     registry URL; unset means npmjs.com
//   PLUGWRIGHT_NPM_USER         registry username, for a registry that wants a password
//   PLUGWRIGHT_NPM_PASSWORD     registry password
//   PLUGWRIGHT_NPM_TAG          dist-tag to publish under (default: latest)
//   PLUGWRIGHT_NPM_ACCESS       npm access level (default: public)
//   PLUGWRIGHT_NPM_PROVENANCE   set to publish with --provenance
//
// The same settings can be given as flags: --registry, --user, --password, --tag, --access,
// --provenance. Flags win over the environment. `--dry-run` packs each package and reports
// what would be sent without sending it.
//
// A username and password are only used when both are given. Without them the publish uses
// whatever credentials npm already has — an `npm login` session, an `NPM_TOKEN` in `.npmrc`,
// or the OIDC token a CI job was issued. That covers npmjs.com and every registry that
// authenticates the same way.
//
// When a username and password are given they are written to a temporary npm config outside
// the working tree and passed with `--userconfig`, so nothing lands in a file the repository
// could commit. They go in as the Basic `_auth` pair rather than a bearer `_authToken`,
// because some registries (Nexus among them) answer a bearer token with 401.

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Every npm package published out of this repository, in dependency order: the plugin
// packages are written against the runner, so a consumer resolving them wants the runner to
// already be there.
const PACKAGES = [
    "runner-package",
    "auth-authme-package",
    "console-rcon-package",
];

const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

// Reads `--name value` and bare `--name` switches out of argv.
function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith("--")) continue;
        const name = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
            args[name] = next;
            i++;
        } else {
            args[name] = true;
        }
    }
    return args;
}

// How to run npm as a child process.
//
// Windows npm is a `.cmd` shim, and Node refuses to spawn one without a shell — a shell that
// would then reinterpret what it is handed. When npm runs this script it points
// `npm_execpath` at its own entry point, so the shim can be stepped over entirely; the shell
// is only the fallback for a run straight through node.
function npmInvocation() {
    const execpath = process.env.npm_execpath;
    if (execpath && execpath.endsWith(".js")) {
        return { command: process.execPath, prefix: [execpath], shell: false };
    }
    return {
        command: process.platform === "win32" ? "npm.cmd" : "npm",
        prefix: [],
        shell: process.platform === "win32",
    };
}

// Writes a throwaway npm config holding the credentials, and returns its path.
//
// The path in the auth key has to match the registry's, minus the protocol — npm looks the
// credentials up by that path and silently sends none when it does not match.
function writeAuthConfig(registry, user, password) {
    const authKey = registry.replace(/^https?:/, "");
    const npmrc = [
        `registry=${registry}`,
        `${authKey}:_auth=${Buffer.from(`${user}:${password}`).toString("base64")}`,
        `${authKey}:always-auth=true`,
        "",
    ].join("\n");

    const configFile = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "plugwright-publish-")),
        "npmrc"
    );
    fs.writeFileSync(configFile, npmrc, { mode: 0o600 });
    return configFile;
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    const registry = args.registry || process.env.PLUGWRIGHT_NPM_REGISTRY || PUBLIC_REGISTRY;
    const user = args.user || process.env.PLUGWRIGHT_NPM_USER;
    const password = args.password || process.env.PLUGWRIGHT_NPM_PASSWORD;
    const tag = args.tag || process.env.PLUGWRIGHT_NPM_TAG || "latest";
    const access = args.access || process.env.PLUGWRIGHT_NPM_ACCESS || "public";
    const provenance = Boolean(args.provenance || process.env.PLUGWRIGHT_NPM_PROVENANCE);
    const dryRun = Boolean(args["dry-run"]);

    if (Boolean(user) !== Boolean(password)) {
        console.error(
            "A username without a password, or the other way round. Set both " +
            "PLUGWRIGHT_NPM_USER and PLUGWRIGHT_NPM_PASSWORD, or neither."
        );
        process.exit(1);
    }

    const version = fs.readFileSync("version.txt", "utf8").trim();
    console.log(
        `${dryRun ? "Dry run: would publish" : "Publishing"} ${version} to ${registry} ` +
        `under the "${tag}" tag\n`
    );

    const configFile = user ? writeAuthConfig(registry, user, password) : null;
    const npm = npmInvocation();

    try {
        for (const pkg of PACKAGES) {
            const name = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).name;
            console.log(`\n=== ${name}@${version}`);
            execFileSync(
                npm.command,
                [
                    ...npm.prefix,
                    "publish",
                    ...(configFile ? ["--userconfig", configFile] : []),
                    "--registry", registry,
                    "--tag", tag,
                    "--access", access,
                    ...(provenance ? ["--provenance"] : []),
                    ...(dryRun ? ["--dry-run"] : []),
                ],
                { cwd: pkg, stdio: "inherit", shell: npm.shell }
            );
        }
    } finally {
        // Credentials, so they go whether the publish worked or not.
        if (configFile) {
            fs.rmSync(path.dirname(configFile), { recursive: true, force: true });
        }
    }

    console.log(`\n${dryRun ? "Dry run complete for" : "Published"} ${version} to ${registry}`);
}

main();
