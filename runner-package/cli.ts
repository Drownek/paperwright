#!/usr/bin/env node

import { runTestSession, runPingSession, runCleanupSession } from './runner.js';

const argv = process.argv.slice(2);

async function main(): Promise<void> {
    if (argv.includes('--ping')) {
        await runPingSession();
        return;
    }
    if (argv.includes('--cleanup')) {
        await runCleanupSession();
        return;
    }
    await runTestSession();
}

main().catch((error: Error) => {
    console.error('\nTest run failed:', error);
    process.exit(1);
});
