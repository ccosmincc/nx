import {
  formatFiles,
  generateFiles,
  getPackageManagerVersion,
  names,
  NxJsonConfiguration,
  PackageManager,
  Tree,
  updateJson,
  writeJson,
} from '@nrwl/devkit';
import {
  angularCliVersion,
  nxVersion,
  prettierVersion,
  typescriptVersion,
} from '../../utils/versions';
import { readFileSync } from 'fs';
import { join, join as pathJoin } from 'path';
import { Preset } from '../utils/presets';
import { deduceDefaultBase } from '../../utilities/default-base';
import { NormalizedSchema } from './new';

export const DEFAULT_NRWL_PRETTIER_CONFIG = {
  singleQuote: true,
};

export async function generateWorkspaceFiles(
  host: Tree,
  options: NormalizedSchema
) {
  if (!options.name) {
    throw new Error(`Invalid options, "name" is required.`);
  }
  options = normalizeOptions(options);
  createFiles(host, options);
  createNxJson(host, options);
  createPrettierrc(host, options);
  if (options.preset === Preset.Angular) {
    decorateAngularClI(host, options);
  }
  const [packageMajor] = getPackageManagerVersion(
    options.packageManager as PackageManager
  ).split('.');
  if (options.packageManager === 'pnpm' && +packageMajor >= 7) {
    createNpmrc(host, options);
  } else if (options.packageManager === 'yarn' && +packageMajor >= 2) {
    createYarnrcYml(host, options);
  }
  setPresetProperty(host, options);
  addNpmScripts(host, options);
  createAppsAndLibsFolders(host, options);
  setUpWorkspacesInPackageJson(host, options);

  await formatFiles(host);
}

function decorateAngularClI(host: Tree, options: NormalizedSchema) {
  const decorateCli = readFileSync(
    pathJoin(__dirname as any, '..', 'utils', 'decorate-angular-cli.js__tmpl__')
  ).toString();
  host.write(join(options.directory, 'decorate-angular-cli.js'), decorateCli);
}

function setPresetProperty(tree: Tree, options: NormalizedSchema) {
  updateJson(tree, join(options.directory, 'nx.json'), (json) => {
    if (options.preset === Preset.Core || options.preset === Preset.NPM) {
      addPropertyWithStableKeys(json, 'extends', 'nx/presets/npm.json');
      delete json.implicitDependencies;
      delete json.targetDefaults;
      delete json.targetDependencies;
      delete json.workspaceLayout;
      delete json.npmScope;
    }
    return json;
  });
}

function createAppsAndLibsFolders(host: Tree, options: NormalizedSchema) {
  if (
    options.preset === Preset.Core ||
    options.preset === Preset.TS ||
    options.preset === Preset.NPM
  ) {
    host.write(join(options.directory, 'packages/.gitkeep'), '');
  } else if (options.preset === Preset.ReactExperimental) {
    // don't generate any folders
  } else {
    host.write(join(options.directory, 'apps/.gitkeep'), '');
    host.write(join(options.directory, 'libs/.gitkeep'), '');
  }
}

function createNxJson(
  host: Tree,
  { directory, npmScope, packageManager, defaultBase, preset }: NormalizedSchema
) {
  const nxJson: NxJsonConfiguration & { $schema: string } = {
    $schema: './node_modules/nx/schemas/nx-schema.json',
    npmScope: npmScope,
    affected: {
      defaultBase,
    },
    tasksRunnerOptions: {
      default: {
        runner: 'nx/tasks-runners/default',
        options: {
          cacheableOperations: ['build', 'lint', 'test', 'e2e'],
        },
      },
    },
  };

  nxJson.targetDefaults = {
    build: {
      dependsOn: ['^build'],
    },
  };

  if (defaultBase === 'main') {
    delete nxJson.affected;
  }
  if (
    preset !== Preset.Core &&
    preset !== Preset.NPM &&
    preset !== Preset.Empty
  ) {
    nxJson.namedInputs = {
      default: ['{projectRoot}/**/*', 'sharedGlobals'],
      production: ['default'],
      sharedGlobals: [],
    };
    nxJson.targetDefaults.build.inputs = ['production', '^production'];
  }

  writeJson<NxJsonConfiguration>(host, join(directory, 'nx.json'), nxJson);
}

function createFiles(host: Tree, options: NormalizedSchema) {
  const formattedNames = names(options.name);
  const filesDirName =
    options.preset === Preset.ReactExperimental
      ? './files-root-app'
      : options.preset === Preset.NPM || options.preset === Preset.Core
      ? './files-package-based-repo'
      : './files-integrated-repo';
  generateFiles(host, pathJoin(__dirname, filesDirName), options.directory, {
    formattedNames,
    dot: '.',
    tmpl: '',
    workspaceFile: options.preset === Preset.Angular ? 'angular' : 'workspace',
    cliCommand: options.preset === Preset.Angular ? 'ng' : 'nx',
    nxCli: false,
    typescriptVersion,
    prettierVersion,
    // angular cli is used only when workspace schematics is added to angular cli
    angularCliVersion,
    ...(options as object),
    nxVersion,
    packageManager: options.packageManager,
  });
}

function createPrettierrc(host: Tree, options: NormalizedSchema) {
  writeJson(
    host,
    join(options.directory, '.prettierrc'),
    DEFAULT_NRWL_PRETTIER_CONFIG
  );
}
// ensure that pnpm install add all the missing peer deps

function createNpmrc(host: Tree, options: NormalizedSchema) {
  host.write(
    join(options.directory, '.npmrc'),
    'strict-peer-dependencies=false\nauto-install-peers=true\n'
  );
}
// ensure that yarn (berry) install uses classic node linker

function createYarnrcYml(host: Tree, options: NormalizedSchema) {
  host.write(
    join(options.directory, '.yarnrc.yml'),
    'nodeLinker: node-modules\n'
  );
}

function addNpmScripts(host: Tree, options: NormalizedSchema) {
  if (options.preset === Preset.Angular) {
    updateJson(host, join(options.directory, 'package.json'), (json) => {
      Object.assign(json.scripts, {
        ng: 'nx',
        postinstall: 'node ./decorate-angular-cli.js',
      });
      return json;
    });
  }

  if (
    options.preset !== Preset.TS &&
    options.preset !== Preset.Core &&
    options.preset !== Preset.NPM
  ) {
    updateJson(host, join(options.directory, 'package.json'), (json) => {
      Object.assign(json.scripts, {
        start: 'nx serve',
        build: 'nx build',
        test: 'nx test',
      });
      return json;
    });
  }
}

function addPropertyWithStableKeys(obj: any, key: string, value: string) {
  const copy = { ...obj };
  Object.keys(obj).forEach((k) => {
    delete obj[k];
  });
  obj[key] = value;
  Object.keys(copy).forEach((k) => {
    obj[k] = copy[k];
  });
}

function normalizeOptions(options: NormalizedSchema) {
  let defaultBase = options.defaultBase || deduceDefaultBase();
  return {
    npmScope: options.name,
    ...options,
    defaultBase,
  };
}

function setUpWorkspacesInPackageJson(tree: Tree, options: NormalizedSchema) {
  if (options.preset === Preset.NPM || options.preset === Preset.Core) {
    if (options.packageManager === 'pnpm') {
      tree.write(
        join(options.directory, 'pnpm-workspace.yaml'),
        `packages:
  - 'packages/*'
`
      );
    } else {
      updateJson(tree, join(options.directory, 'package.json'), (json) => {
        json.workspaces = ['packages/*'];
        return json;
      });
    }
  }
}
