// module.exports = {
//   // preset: "ts-jest",
//   preset: "ts-jest/presets/js-with-ts",
//   clearMocks: true,
//   moduleFileExtensions: ["js", "ts"],
//   testEnvironment: "node",
//   testMatch: [
//     "**/__tests__/**/*.test.ts",
//     // "**/*.test.ts"
//   ],
//   testRunner: "jest-circus/runner",
//   // transform: {
//   //   "^.+\\.ts$": "ts-jest",
//   // },
//   // transformIgnorePatterns: [
//   //   "node_modules",
//   //   // "node_modules/(?!tempy/.*)",
//   //   // "node_modules/(?!variables/.*)",
//   // ],
//   // moduleNameMapper: {
//   //   "^variables$": "variables/dist/cjs",
//   //   "^[NAME OF MODULE YOU WANT TO IMPORT]$":
//   //     "[NAME OF MODULE YOU WANT TO IMPORT]/dist/cjs",
//   // },
//   verbose: true,
// };

import type { JestConfigWithTsJest } from "ts-jest";

const jestConfig: JestConfigWithTsJest = {
  // [...]
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    // '^.+\\.[tj]sx?$' to process js/ts with ts-jest
    // '^.+\\.m?[tj]sx?$' to process js/ts/mjs/mts with ts-jest
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
      },
    ],
  },
};

export default jestConfig;
