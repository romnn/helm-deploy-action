module.exports = {
  // preset: "ts-jest",
  preset: "ts-jest/presets/js-with-ts",
  clearMocks: true,
  moduleFileExtensions: ["js", "ts"],
  testEnvironment: "node",
  testMatch: [
    "**/__tests__/**/*.test.ts",
    // "**/*.test.ts"
  ],
  testRunner: "jest-circus/runner",
  // transform: {
  //   "^.+\\.ts$": "ts-jest",
  // },
  // transformIgnorePatterns: [
  //   "node_modules",
  //   // "node_modules/(?!tempy/.*)",
  //   // "node_modules/(?!variables/.*)",
  // ],
  // moduleNameMapper: {
  //   "^variables$": "variables/dist/cjs",
  //   "^[NAME OF MODULE YOU WANT TO IMPORT]$":
  //     "[NAME OF MODULE YOU WANT TO IMPORT]/dist/cjs",
  // },
  verbose: true,
};
