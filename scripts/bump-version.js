#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const readline = require("readline");

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

        // Matches any version after the package name, e.g., "@drownek/plugwright": "^1.x.x"
        replaceRegexInFile(
            "gradle-plugin/plugwright-core/src/main/kotlin/me/drownek/plugwright/PlugwrightPlugin.kt",
            /"@drownek\/plugwright": "\^[^"]+"/g,
            `"@drownek/plugwright": "^${newVersion}"`
        );
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

    // update runner-package/package.json
    execSync(
        `npm version ${newVersion} --no-git-tag-version --allow-same-version`,
        { cwd: "runner-package", stdio: "inherit" }
    );

    // update the lockfile in the example plugin
    console.log("\nUpdating lockfile in example_plugin...");
    execSync(
        `npm install --package-lock-only`,
        { cwd: "example_plugin/src/test/e2e", stdio: "inherit" }
    );

    // bump version references in source files (docs and templates only for stable releases)
    const changedSourceFiles = [
        "example_plugin/build.gradle.kts",
    ];
    bumpVersionFiles(newVersion, isPrerelease);
    if (!isPrerelease) {
        changedSourceFiles.push(
            "README.md",
            "docs/quickstart.mdx",
            "gradle-plugin/plugwright-core/src/main/kotlin/me/drownek/plugwright/PlugwrightPlugin.kt",
        );
    }

    // commit version files (+ source files if updated)
    const filesToCommit = [
        "version.txt",
        "runner-package/package.json",
        "runner-package/package-lock.json",
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