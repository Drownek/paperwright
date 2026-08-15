import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import pc from 'picocolors';
import { extractSpecLocation } from './stack-trace.js';
import type { TestResult } from './types.js';

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    return `${seconds.toFixed(1)}s`;
}

function statusOf(result: TestResult): 'PASS' | 'FAIL' | 'SKIP' {
    if (result.skipped) return 'SKIP';
    return result.passed ? 'PASS' : 'FAIL';
}

export function printTestSummary(testResults: TestResult[]): number {
    console.log(`\n${pc.bold("=".repeat(40))}`);
    console.log(pc.bold('  Test Summary'));
    console.log(pc.bold("=".repeat(40)));

    const skipped = testResults.filter(r => r.skipped);
    const executed = testResults.filter(r => !r.skipped);
    const passed = executed.filter(r => r.passed);
    const failed = executed.filter(r => !r.passed);
    const totalDuration = testResults.reduce((sum, r) => sum + r.durationMs, 0);

    console.log(`  Total:    ${pc.bold(String(testResults.length))}`);
    console.log(`  Passed:   ${pc.green(pc.bold(String(passed.length)))}`);
    console.log(`  Failed:   ${failed.length > 0 ? pc.red(pc.bold(String(failed.length))) : pc.dim(String(failed.length))}`);
    console.log(`  Skipped:  ${skipped.length > 0 ? pc.yellow(pc.bold(String(skipped.length))) : pc.dim(String(skipped.length))}`);
    console.log(`  Duration: ${pc.dim(formatDuration(totalDuration))}`);

    const statusCol = 'Status';
    const testCol = 'Test';
    const durationCol = 'Duration';

    const statusWidth = Math.max(statusCol.length, ...testResults.map(r => statusOf(r).length));
    const durationWidth = Math.max(durationCol.length, ...testResults.map(r => formatDuration(r.durationMs).length));
    const testWidth = Math.max(testCol.length, ...testResults.map(r => r.testName.length));

    const header = `  ${pc.dim(`${statusCol.padEnd(statusWidth)}  ${testCol.padEnd(testWidth)}  ${durationCol.padStart(durationWidth)}`)}`;
    const separator = `  ${pc.dim(`${"-".repeat(statusWidth)}  ${"-".repeat(testWidth)}  ${"-".repeat(durationWidth)}`)}`;

    console.log(`\n${header}`);
    console.log(separator);

    for (const result of testResults) {
        const status = statusOf(result);
        const statusPadded = status.padEnd(statusWidth);
        const coloredStatus = status === 'PASS'
            ? pc.green(pc.bold(statusPadded))
            : status === 'SKIP'
                ? pc.yellow(pc.bold(statusPadded))
                : pc.red(pc.bold(statusPadded));
        const duration = formatDuration(result.durationMs);
        console.log(`  ${coloredStatus}  ${result.testName.padEnd(testWidth)}  ${pc.dim(duration.padStart(durationWidth))}`);
    }

    console.log(separator);
    console.log(`  ${''.padEnd(statusWidth)}  ${pc.bold('Total'.padEnd(testWidth))}  ${pc.dim(formatDuration(totalDuration).padStart(durationWidth))}`);

    if (skipped.length > 0) {
        console.log(`\n${pc.yellow(pc.bold('Skipped Tests:'))}\n`);
        for (const result of skipped) {
            console.log(`  ${pc.yellow(`- ${result.testName}`)}`);
            if (result.skipReason) console.log(`    ${pc.dim(result.skipReason)}`);
        }
    }

    if (failed.length > 0) {
        console.log(`\n${pc.red(pc.bold('Failed Tests:'))}\n`);

        for (const result of failed) {
            console.log(`  ${pc.red(`x ${result.testName}`)}`);

            if (result.error) {
                console.log(`    ${pc.red(result.error.message)}`);
                const location = extractSpecLocation(result.error);
                if (location) {
                    console.log(`    ${pc.dim(`at ${location}`)}`);
                }
            }

            console.log('');
        }

        return 1;
    } else {
        console.log(`\n${pc.green(pc.bold('All tests passed!'))}`);
        return 0;
    }
}

function xmlEscape(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Writes the machine-readable report a matrix run aggregates across environments. */
export function writeJsonReport(path: string, environmentName: string, testResults: TestResult[]): void {
    const skipped = testResults.filter(r => r.skipped);
    const executed = testResults.filter(r => !r.skipped);
    const passed = executed.filter(r => r.passed);
    const failed = executed.filter(r => !r.passed);
    const durationMs = testResults.reduce((sum, r) => sum + r.durationMs, 0);

    const report = {
        environment: environmentName,
        summary: {
            total: testResults.length,
            passed: passed.length,
            failed: failed.length,
            skipped: skipped.length,
            durationMs,
        },
        tests: testResults.map(r => ({
            file: r.file,
            name: r.testName,
            status: statusOf(r).toLowerCase(),
            durationMs: r.durationMs,
            error: r.error ? r.error.message : null,
            skipReason: r.skipReason ?? null,
            plugin: r.plugin ?? null,
        })),
    };

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
}

/** Writes a JUnit XML report: `testsuite name="plugwright.<env>"`, one `testcase` per test,
 *  spec file as `classname`, full `describe`-chain name as `name`. */
export function writeJUnitReport(path: string, environmentName: string, testResults: TestResult[]): void {
    const skipped = testResults.filter(r => r.skipped).length;
    const failed = testResults.filter(r => !r.skipped && !r.passed).length;
    const totalTimeSeconds = (testResults.reduce((sum, r) => sum + r.durationMs, 0) / 1000).toFixed(3);

    const cases = testResults.map(r => {
        const timeSeconds = (r.durationMs / 1000).toFixed(3);
        const classname = xmlEscape(r.file);
        const name = xmlEscape(r.testName);
        const pluginAttr = r.plugin ? ` plugin="${xmlEscape(r.plugin)}"` : '';
        const inner = r.skipped
            ? `\n    <skipped message="${xmlEscape(r.skipReason ?? 'skipped')}"/>\n  `
            : !r.passed
                ? `\n    <failure message="${xmlEscape(r.error?.message ?? 'failed')}">${xmlEscape(r.error?.stack ?? r.error?.message ?? '')}</failure>\n  `
                : '';
        return `  <testcase classname="${classname}" name="${name}" time="${timeSeconds}"${pluginAttr}>${inner}</testcase>`;
    });

    const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<testsuite name="plugwright.${xmlEscape(environmentName)}" tests="${testResults.length}" failures="${failed}" skipped="${skipped}" time="${totalTimeSeconds}">`,
        ...cases,
        '</testsuite>',
        '',
    ].join('\n');

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, xml, 'utf8');
}