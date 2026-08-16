/**
 * This test is mainly related to core runner package to check if everything executes in right order
 */

import { afterEach, beforeEach, describe, test, expect } from "@drownek/plugwright";

const executionLog: string[] = [];

beforeEach(async () => {
    executionLog.push('root:beforeEach');
});

afterEach(async () => {
    executionLog.push('root:afterEach');
});

describe('beforeEach / afterEach execution order', () => {

    beforeEach(async () => {
        executionLog.push('L1:beforeEach');
    });

    afterEach(async () => {
        executionLog.push('L1:afterEach');
    });

    test('should run root and L1 beforeEach in order', async () => {
        expect(executionLog).toEqual([
            'root:beforeEach',
            'L1:beforeEach',
        ]);
    });

    test('should have run afterEach from previous test and beforeEach again', async () => {
        // After the previous test, afterEach hooks should have fired, then beforeEach for this test
        expect(executionLog).toEqual([
            // first test setup
            'root:beforeEach',
            'L1:beforeEach',
            // first test teardown
            'L1:afterEach',
            'root:afterEach',
            // second test setup
            'root:beforeEach',
            'L1:beforeEach',
        ]);
    });

    describe('Level 2', () => {

        beforeEach(async () => {
            executionLog.push('L2:beforeEach');
        });

        afterEach(async () => {
            executionLog.push('L2:afterEach');
        });

        test('should run all three levels of beforeEach', async () => {
            // We only care about the hooks that ran for THIS test (the tail of the log)
            const lastThree = executionLog.slice(-3);
            expect(lastThree).toEqual([
                'root:beforeEach',
                'L1:beforeEach',
                'L2:beforeEach',
            ]);
        });

        describe('Level 3', () => {

            beforeEach(async () => {
                executionLog.push('L3:beforeEach');
            });

            afterEach(async () => {
                executionLog.push('L3:afterEach');
            });

            test('should run four levels of beforeEach (root → L1 → L2 → L3)', async () => {
                const lastFour = executionLog.slice(-4);
                expect(lastFour).toEqual([
                    'root:beforeEach',
                    'L1:beforeEach',
                    'L2:beforeEach',
                    'L3:beforeEach',
                ]);
            });

            test('should have run L3 and L2 afterEach after previous test', async () => {
                // After the previous test in Level 3, afterEach should fire L3 → L2 → L1 → root
                // Then beforeEach fires root → L1 → L2 → L3 for this test
                const lastEight = executionLog.slice(-8);
                expect(lastEight).toEqual([
                    'L3:afterEach',
                    'L2:afterEach',
                    'L1:afterEach',
                    'root:afterEach',
                    'root:beforeEach',
                    'L1:beforeEach',
                    'L2:beforeEach',
                    'L3:beforeEach',
                ]);
            });
        });
    });
});

describe('State isolation between describes', () => {

    let counter = 0;

    beforeEach(async () => {
        counter++;
        executionLog.push(`isolation:beforeEach(${counter})`);
    });

    test('counter should be 1 on first run', async () => {
        expect(counter).toBe(1);
    });

    test('counter should be 2 on second run (beforeEach runs each time)', async () => {
        expect(counter).toBe(2);
    });

    describe('Nested isolation', () => {

        let nestedValue: string | undefined;

        beforeEach(async () => {
            nestedValue = 'initialized';
        });

        afterEach(async () => {
            nestedValue = undefined;
        });

        test('nestedValue should be initialized by nested beforeEach', async () => {
            expect(nestedValue).toBe('initialized');
        });

        test('nestedValue should be re-initialized (afterEach cleared it)', async () => {
            expect(nestedValue).toBe('initialized');
        });
    });
});

describe('Empty describe blocks should not fail', () => {
    describe('Empty nested', () => {
        // intentionally empty
    });

    test('this test should still run after an empty describe', async () => {
        expect(true).toBe(true);
    });
});

describe('afterEach runs even if test body mutates state', () => {

    let value = 'clean';

    afterEach(async () => {
        value = 'clean';
    });

    test('mutate value and expect it to be clean at start', async () => {
        expect(value).toBe('clean');
        value = 'dirty';
    });

    test('value should be clean again thanks to afterEach', async () => {
        expect(value).toBe('clean');
    });
});

describe('toThrow and toThrowAsync with non-Error objects/strings', () => {
    test('should match string errors and non-Error objects', async () => {
        expect(() => { throw "string error"; }).toThrow("string");
        expect(() => { throw "string error"; }).toThrow(/string/);
        expect(() => { throw { myMessage: "object error" }; }).toThrow("[object Object]");
        expect(() => { throw new Error("my error"); }).toThrow("my");
        expect(() => { throw new Error("my error"); }).toThrow(/my/);
    });

    test('should match async string errors and non-Error objects', async () => {
        await expect(async () => { throw "async string error"; }).toThrowAsync("async");
        await expect(async () => { throw "async string error"; }).toThrowAsync(/async/);
        await expect(async () => { throw { myMessage: "async object error" }; }).toThrowAsync("[object Object]");
        await expect(async () => { throw new Error("async my error"); }).toThrowAsync("async");
        await expect(async () => { throw new Error("async my error"); }).toThrowAsync(/async/);
    });
});