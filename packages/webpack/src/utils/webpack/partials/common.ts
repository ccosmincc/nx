import { basename, join, resolve } from 'path';
import type { Compiler, Configuration } from 'webpack';
import { ids, ProgressPlugin, sources } from 'webpack';
import { ScriptTarget } from 'typescript';

import { normalizeExtraEntryPoints } from '../normalize-entry';
import { ScriptsWebpackPlugin } from '../plugins/scripts-webpack-plugin';
import { BuildBrowserFeatures } from '../build-browser-features';
import { getOutputHashFormat } from '../../hash-format';
import { findAllNodeModules, findUp } from '../../fs';
import type { CreateWebpackConfigOptions, ExtraEntryPoint } from '../../models';

export function getCommonConfig(
  wco: CreateWebpackConfigOptions
): Configuration {
  const { root, projectRoot, sourceRoot, buildOptions, tsConfig } = wco;

  let stylesOptimization: boolean;
  let scriptsOptimization: boolean;
  if (typeof buildOptions.optimization === 'object') {
    scriptsOptimization = buildOptions.optimization.scripts;
    stylesOptimization = buildOptions.optimization.styles;
  } else {
    scriptsOptimization = stylesOptimization = !!buildOptions.optimization;
  }

  const nodeModules = findUp('node_modules', projectRoot);
  if (!nodeModules) {
    throw new Error('Cannot locate node_modules directory.');
  }

  // tslint:disable-next-line:no-any
  const extraPlugins: any[] = [];
  const entryPoints: { [key: string]: string[] } = {};

  if (buildOptions.main) {
    entryPoints['main'] = [resolve(root, buildOptions.main)];
  }

  const buildBrowserFeatures = new BuildBrowserFeatures(
    projectRoot,
    tsConfig.options.target || ScriptTarget.ES5
  );

  const differentialLoadingNeeded =
    buildBrowserFeatures.isDifferentialLoadingNeeded();

  if (tsConfig.options.target === ScriptTarget.ES5) {
    if (buildBrowserFeatures.isEs5SupportNeeded()) {
      // The nomodule polyfill needs to be inject prior to any script and be
      // outside of webpack compilation because otherwise webpack will cause the
      // script to be wrapped in window["webpackJsonp"] which causes this to fail.
      if (buildBrowserFeatures.isNoModulePolyfillNeeded()) {
        const noModuleScript: ExtraEntryPoint = {
          bundleName: 'polyfills-nomodule-es5',
          input: join(__dirname, '..', 'safari-nomodule.js'),
        };
        buildOptions.scripts = buildOptions.scripts
          ? [...buildOptions.scripts, noModuleScript]
          : [noModuleScript];
      }

      // For full build differential loading we don't need to generate a seperate polyfill file
      // because they will be loaded exclusivly based on module and nomodule
      const polyfillsChunkName = differentialLoadingNeeded
        ? 'polyfills'
        : 'polyfills-es5';

      entryPoints[polyfillsChunkName] = [
        join(__dirname, '..', 'es5-polyfills.js'),
      ];

      // If not performing a full differential build the polyfills need to be added to ES5 bundle
      if (buildOptions.polyfills) {
        entryPoints[polyfillsChunkName].push(
          resolve(root, buildOptions.polyfills)
        );
      }
    }
  }

  if (buildOptions.polyfills) {
    entryPoints['polyfills'] = [
      ...(entryPoints['polyfills'] || []),
      resolve(root, buildOptions.polyfills),
    ];
  }

  // determine hashing format
  const hashFormat = getOutputHashFormat(buildOptions.outputHashing || 'none');

  // process global scripts
  const globalScriptsByBundleName = normalizeExtraEntryPoints(
    buildOptions.scripts || [],
    'scripts'
  ).reduce(
    (
      prev: { bundleName: string; paths: string[]; inject: boolean }[],
      curr
    ) => {
      const bundleName = curr.bundleName;
      const resolvedPath = resolve(root, curr.input);
      const existingEntry = prev.find((el) => el.bundleName === bundleName);
      if (existingEntry) {
        if (existingEntry.inject && !curr.inject) {
          // All entries have to be lazy for the bundle to be lazy.
          throw new Error(
            `The ${curr.bundleName} bundle is mixing injected and non-injected scripts.`
          );
        }

        existingEntry.paths.push(resolvedPath);
      } else {
        prev.push({
          bundleName,
          paths: [resolvedPath],
          inject: curr.inject,
        });
      }

      return prev;
    },
    []
  );

  if (globalScriptsByBundleName.length > 0) {
    // Add a new asset for each entry.
    globalScriptsByBundleName.forEach((script) => {
      // Lazy scripts don't get a hash, otherwise they can't be loaded by name.
      const hash = script.inject ? hashFormat.script : '';
      const bundleName = script.bundleName;

      extraPlugins.push(
        new ScriptsWebpackPlugin({
          name: bundleName,
          sourceMap: !!buildOptions.sourceMap,
          filename: `${basename(bundleName)}${hash}.js`,
          scripts: script.paths,
          basePath: sourceRoot,
        })
      );
    });
  }

  if (buildOptions.progress) {
    extraPlugins.push(new ProgressPlugin({ profile: buildOptions.verbose }));
  }

  // TODO Needs source exported from webpack
  if (buildOptions.statsJson) {
    extraPlugins.push(
      new (class {
        apply(compiler: Compiler) {
          compiler.hooks.emit.tap('angular-cli-stats', (compilation) => {
            const data = JSON.stringify(
              compilation.getStats().toJson('verbose')
            );
            compilation.assets[`stats.json`] = new sources.RawSource(data);
          });
        }
      })()
    );
  }

  let sourceMapUseRule;
  if (!!buildOptions.sourceMap) {
    sourceMapUseRule = {
      use: [
        {
          loader: require.resolve('source-map-loader'),
        },
      ],
    };
  }

  // Allow loaders to be in a node_modules nested inside the devkit/build-angular package.
  // This is important in case loaders do not get hoisted.
  // If this file moves to another location, alter potentialNodeModules as well.
  const loaderNodeModules = findAllNodeModules(__dirname, projectRoot);
  loaderNodeModules.unshift('node_modules');

  // Load rxjs path aliases.
  // https://github.com/ReactiveX/rxjs/blob/master/doc/pipeable-operators.md#build-and-treeshaking
  let alias = {};
  try {
    const rxjsPathMappingImport = wco.supportES2015
      ? 'rxjs/_esm2015/path-mapping'
      : 'rxjs/_esm5/path-mapping';
    const rxPaths = require(require.resolve(rxjsPathMappingImport, {
      paths: [projectRoot],
    }));
    alias = rxPaths(nodeModules);
  } catch {}

  return {
    profile: buildOptions.statsJson,
    resolve: {
      extensions: ['.ts', '.tsx', '.mjs', '.js'],
      symlinks: true,
      modules: [wco.tsConfig.options.baseUrl || projectRoot, 'node_modules'],
      alias,
    },
    resolveLoader: {
      modules: loaderNodeModules,
    },
    entry: entryPoints,
    output: {
      path: resolve(root, buildOptions.outputPath as string),
      publicPath: buildOptions.deployUrl,
    },
    watch: buildOptions.watch,
    performance: {
      hints: false,
    },
    module: {
      // Show an error for missing exports instead of a warning.
      strictExportPresence: true,
      rules: [
        {
          test: /\.(eot|svg|cur|jpg|png|webp|gif|otf|ttf|woff|woff2|ani)$/,
          loader: require.resolve('file-loader'),
          options: {
            name: `[name]${hashFormat.file}.[ext]`,
          },
        },
        {
          test: /[\/\\]hot[\/\\]emitter\.js$/,
          parser: { node: { events: true } },
        },
        {
          test: /[\/\\]webpack-dev-server[\/\\]client[\/\\]utils[\/\\]createSocketUrl\.js$/,
          parser: { node: { querystring: true } },
        },
        {
          test: /\.js$/,
          // Factory files are processed by BO in the rules added in typescript.ts.
          exclude: /(ngfactory|ngstyle)\.js$/,
        },
        {
          test: /\.js$/,
          exclude: /(ngfactory|ngstyle)\.js$/,
          enforce: 'pre',
          ...sourceMapUseRule,
        },
      ],
    },
    plugins: extraPlugins,
  };
}
