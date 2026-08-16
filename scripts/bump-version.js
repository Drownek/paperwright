#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const readline = require("readline");

// Every npm package published out of this repo. They move as one version: a plugin package
// and the runner it is written against are only recognisable as a matching pair if their
// version numbers say so, and the plugin packages are useless on their own anyway.
const NPM_PACKAGES = [
    "runner-package",
    "auth-authme-package",
    "console-rcon-package",
];

function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

// Updated to take a regex pattern and a replacement string directly
function replaceRegexInFile(filePath, regex, replacement) {
    if (!fs.existsSync(filePath)) {
        console.warn(`  Warning: ${filePath} not found, skipping.`);
        return;
    }
    const content = fs.readFileSync(filePath, "utf8");
    const updated = content.replace(regex, replacement);
    if (updated === content) {
        console.warn(`  Warning: pattern not found in ${filePath}, skipping.`);
        return;
    }
    fs.writeFileSync(filePath, updated, "utf8");
    console.log(`  Updated ${filePath}`);
}

function bumpVersionFiles(newVersion, isPrerelease) {
    console.log("\nUpdating version references in source files...");

    if (!isPrerelease) {
        const docFiles = [
            "README.md",
            "docs/quickstart.mdx",
        ];

        for (const file of docFiles) {
            replaceRegexInFile(
                file,
                /id\("io\.github\.drownek\.plugwright"\) version "[^"]+"/g,
                `id("io.github.drownek.plugwright") version "${newVersion}"`
            );
        }
    }

    replaceRegexInFile(
        "example_plugin/build.gradle.kts",
        /id\("io\.github\.drownek\.plugwright"\) version "[^"]+"/g,
        `id("io.github.drownek.plugwright") version "${newVersion}"`
    );
}

async function main() {
    let newVersion = process.argv[2];

    const oldVersion = fs.existsSync("version.txt")
        ? fs.readFileSync("version.txt", "utf8").trim()
        : "";

    if (!newVersion) {
        newVersion = await prompt(`Version [${oldVersion}]: `);
        newVersion = newVersion || oldVersion;
    }

    if (!newVersion) {
        console.error("No version provided.");
        process.exit(1);
    }

    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) {
        console.error("Invalid semver:", newVersion);
        process.exit(1);
    }

    const isPrerelease = newVersion.includes("-");

    // update version.txt
    fs.writeFileSync("version.txt", newVersion + "\n");

    // update each published package's package.json and its lockfile's own version field
    for (const pkg of NPM_PACKAGES) {
        console.log(`\nBumping ${pkg}...`);
        execSync(
            `npm version ${newVersion} --no-git-tag-version --allow-same-version`,
            { cwd: pkg, stdio: "inherit" }
        );
    }

    // Refresh every lockfile that records the runner's version rather than its own.
    //
    // The plugin packages depend on the runner through `file:../runner-package`, and npm
    // copies the linked package's version into their lockfiles. `npm version` does not
    // rewrite that copy — only an install does — so without this the plugin packages ship a
    // lockfile still naming the previous runner version.
    const LOCKFILE_ONLY = [
        ...NPM_PACKAGES.filter((pkg) => pkg !== "runner-package"),
        "example_plugin/src/test/e2e",
    ];

    for (const dir of LOCKFILE_ONLY) {
        console.log(`\nUpdating lockfile in ${dir}...`);
        execSync(
            `npm install --package-lock-only`,
            { cwd: dir, stdio: "inherit" }
        );
    }

    // bump version references in source files (docs only for stable releases)
    const changedSourceFiles = [
        "example_plugin/build.gradle.kts",
    ];
    bumpVersionFiles(newVersion, isPrerelease);
    if (!isPrerelease) {
        changedSourceFiles.push(
            "README.md",
            "docs/quickstart.mdx",
        );
    }

    // commit version files (+ source files if updated)
    const filesToCommit = [
        "version.txt",
        ...NPM_PACKAGES.flatMap((pkg) => [`${pkg}/package.json`, `${pkg}/package-lock.json`]),
        "example_plugin/src/test/e2e/package-lock.json",
        ...changedSourceFiles,
    ].join(" ");

    execSync(
        `git commit -m "chore: bump to ${newVersion}" -- ${filesToCommit}`,
        { stdio: "inherit" }
    );

    // optionally create an annotated tag
    const tagAnswer = await prompt(`Create tag v${newVersion}? [${isPrerelease ? "y/N" : "Y/n"}] `);
    const createTag = isPrerelease
        ? tagAnswer.toLowerCase() === "y"
        : tagAnswer === "" || tagAnswer.toLowerCase() === "y";

    if (createTag) {
        execSync(`git tag -a "v${newVersion}" -m "v${newVersion}"`, { stdio: "inherit" });
    }

    console.log(`\nVersion bumped to ${newVersion}${createTag ? `, tagged as v${newVersion}` : " (no tag created)"}`);

    // optionally push
    const pushAnswer = await prompt("Push commits and tags? [Y/n] ");
    if (pushAnswer === "" || pushAnswer.toLowerCase() === "y") {
        execSync(createTag ? `git push && git push origin v${newVersion}` : "git push", { stdio: "inherit" });
        console.log("Pushed.");
    } else {
        console.log(`Skipped push. Run: git push${createTag ? ` && git push origin v${newVersion}` : ""}`);
    }
}

main();