import * as core from "@actions/core";

function parseDependencies(
  deps: object | string | null | undefined,
): HelmRepo[] {
  let depsObj: object | null = null;
  if (typeof deps === "string" && deps.length > 0) {
    try {
      depsObj = JSON.parse(deps);
    } catch (err) {
      throw new Error("dependencies must be a valid YAML or JSON array");
    }
  } else if (typeof deps === "object") {
    depsObj = deps;
  } else if (Array.isArray(deps)) {
    return deps;
  }
  if (!depsObj) {
    return [];
  }
  if (Array.isArray(depsObj)) {
    return depsObj;
  }
  return [depsObj];
}

function parseValueFiles(files: string | string[]): string[] {
  let fileList;
  if (typeof files === "string") {
    try {
      fileList = JSON.parse(files);
    } catch (err) {
      fileList = [files];
    }
  } else {
    fileList = files;
  }
  if (!Array.isArray(fileList)) {
    return [];
  }
  return fileList.filter((f) => !!f);
}

/**
 * Parse actions input values
 */
function parseInput(name: string, required = false): string {
  return core.getInput(name, { required });
}

function parseValues(values: object | string | null | undefined): string {
  if (!values) {
    return "{}";
  }
  if (typeof values === "object") {
    return JSON.stringify(values);
  }
  return values;
}

function parseSecrets(secrets: string | object): string | object {
  if (typeof secrets === "string") {
    try {
      return JSON.parse(secrets);
    } catch (err) {
      return secrets;
    }
  }
  return secrets;
}

export interface HelmRepo {
  url?: string;
  alias?: string;
  username?: string;
  password?: string;
}

/**
 * Helm deployment configuration
 */
export interface HelmDeployConfig {
  command: string;

  // remove and upgrade
  release?: string;
  namespace?: string;
  timeout?: string;

  // upgrade
  values?: string;
  dry?: boolean;
  atomic?: boolean;
  valueFiles?: string[];
  secrets?: string | object;

  // upgrade and push
  chart?: string;
  chartVersion?: string;
  repo?: string;
  repoAlias?: string;
  repoUsername?: string;
  repoPassword?: string;
  dependencies?: HelmRepo[];

  // push
  appVersion?: string;
  chartDir?: string;
  force?: boolean;
}

export function getRepoConfig(conf: HelmDeployConfig): HelmRepo {
  return {
    url: conf.repo,
    alias: conf.repoAlias,
    username: conf.repoUsername,
    password: conf.repoPassword,
  };
}

/**
 * Parse the action's entire config
 */
export async function parseConfig(): Promise<HelmDeployConfig> {
  const command = parseInput("command").toLowerCase();

  const isPush = command === "push";
  const isUpgrade = command === "upgrade";
  const isRemove = command === "remove";

  let conf = {
    command,

    // remove and upgrade
    release: parseInput("release", isRemove || isUpgrade),
    namespace: parseInput("namespace"),
    timeout: parseInput("timeout"),

    // upgrade
    values: parseValues(parseInput("values")),
    dry: parseInput("dry-run") === "true",
    atomic: parseInput("atomic") === "true",
    valueFiles: parseValueFiles(parseInput("value-files")),
    secrets: parseSecrets(parseInput("secrets")),

    // upgrade and push
    chart: parseInput("chart", isUpgrade || isPush),
    chartVersion: parseInput("chart-version"),
    repo: parseInput("repo", isPush),
    repoAlias: parseInput("repo-alias"),
    repoUsername: parseInput("repo-username"),
    repoPassword: parseInput("repo-password"),
    dependencies: parseDependencies(parseInput("dependencies")),

    // push
    appVersion: parseInput("app-version"),
    chartDir: parseInput("chart-dir"),
    force: parseInput("force") === "true",
  };

  if (!conf.repoAlias) conf.repoAlias = "source-chart-repo";

  return conf;
}
