import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const expectedPackageFiles = [
  'LICENSE',
  'README.md',
  'bin/node-pg-migrate.js',
  'dist/index.d.ts',
  'dist/index.js',
  'package.json',
  'templates/migration-template.cjs',
  'templates/migration-template.cts',
  'templates/migration-template.js',
  'templates/migration-template.mjs',
  'templates/migration-template.mts',
  'templates/migration-template.sql',
  'templates/migration-template.ts',
].toSorted();

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const run = (command, arguments_, cwd) => {
  console.log(`> ${command} ${arguments_.join(' ')}`);
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    fail(`${basename(command)} exited with status ${result.status}`);
  }
};

const findTarball = async (directory) => {
  const entries = (await readdir(directory)).filter((file) =>
    file.endsWith('.tgz')
  );

  if (entries.length !== 1) {
    fail(
      `Expected exactly one package tarball in ${directory}, found ${entries.length}`
    );
  }

  return join(directory, entries[0]);
};

const verifyPackage = async (directoryArgument) => {
  if (!directoryArgument) {
    fail('Usage: verify-package.mjs package <tarball-directory>');
  }

  const directory = resolve(directoryArgument);
  const tarball = await findTarball(directory);
  const result = spawnSync('tar', ['-tzf', tarball], {
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    fail(`Unable to inspect ${tarball}`);
  }

  const actualPackageFiles = result.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((file) => !file.endsWith('/'))
    .map((file) => file.replace(/^package\//u, ''))
    .toSorted();

  if (
    JSON.stringify(actualPackageFiles) !== JSON.stringify(expectedPackageFiles)
  ) {
    console.error('Expected package files:', expectedPackageFiles);
    console.error('Actual package files:', actualPackageFiles);
    fail('Published package contents do not match the allowlist');
  }

  console.log(
    `Verified ${actualPackageFiles.length} files in ${basename(tarball)}`
  );
};

const verifyInstalledVersion = async (
  workspace,
  packageName,
  expectedVersion
) => {
  const packageJsonPath = join(
    workspace,
    'node_modules',
    ...packageName.split('/'),
    'package.json'
  );
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));

  if (packageJson.version !== expectedVersion) {
    fail(
      `Expected ${packageName}@${expectedVersion}, installed ${packageJson.version}`
    );
  }
};

const verifyConsumer = async (directoryArgument, pgVersion, typesPgVersion) => {
  if (!directoryArgument || !pgVersion || !typesPgVersion) {
    fail(
      'Usage: verify-package.mjs consumer <tarball-directory> <pg-version> <@types/pg-version>'
    );
  }

  const tarball = await findTarball(resolve(directoryArgument));
  const workspace = await mkdtemp(join(tmpdir(), 'node-pg-migrate-consumer-'));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  console.log(`Consumer workspace: ${workspace}`);

  try {
    await writeFile(
      join(workspace, 'package.json'),
      `${JSON.stringify({ name: 'fork-ci-consumer', private: true, type: 'module' }, null, 2)}\n`
    );

    run(
      npm,
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        tarball,
        `pg@${pgVersion}`,
        `@types/pg@${typesPgVersion}`,
        'typescript@7.0.2',
      ],
      workspace
    );

    await verifyInstalledVersion(workspace, 'pg', pgVersion);
    await verifyInstalledVersion(workspace, '@types/pg', typesPgVersion);

    await writeFile(
      join(workspace, 'runtime-smoke.mjs'),
      `import * as pgm from 'node-pg-migrate';

for (const exportName of ['Migration', 'MigrationBuilder', 'PgLiteral', 'escapeValue', 'runner']) {
  if (typeof pgm[exportName] !== 'function') {
    throw new TypeError(\`Expected \${exportName} to be a function\`);
  }
}

if (typeof pgm.PgType !== 'object' || pgm.PgType === null) {
  throw new TypeError('Expected PgType to be an object');
}
`
    );
    run(process.execPath, ['runtime-smoke.mjs'], workspace);

    await writeFile(
      join(workspace, 'consumer.mts'),
      `import {
  Migration,
  MigrationBuilder,
  PgLiteral,
  PgType,
  runner,
  type RunnerOption,
} from 'node-pg-migrate';

const publicApi: readonly unknown[] = [
  Migration,
  MigrationBuilder,
  PgLiteral,
  PgType,
  runner,
];
const options: RunnerOption | undefined = undefined;

void publicApi;
void options;
`
    );
    await writeFile(
      join(workspace, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            noEmit: true,
            skipLibCheck: false,
            strict: true,
            target: 'ES2023',
          },
          include: ['consumer.mts'],
        },
        null,
        2
      )}\n`
    );
    run(
      process.execPath,
      [
        join(workspace, 'node_modules/typescript/bin/tsc'),
        '--project',
        'tsconfig.json',
      ],
      workspace
    );

    const packageRoot = join(workspace, 'node_modules/node-pg-migrate');
    const cli = join(packageRoot, 'bin/node-pg-migrate.js');
    const binShim = join(
      workspace,
      'node_modules/.bin',
      process.platform === 'win32' ? 'node-pg-migrate.cmd' : 'node-pg-migrate'
    );

    if (!existsSync(binShim)) {
      fail(`Package manager did not create the CLI shim at ${binShim}`);
    }

    run(process.execPath, [cli, '--help'], workspace);
    run(process.execPath, [cli, '--version'], workspace);

    for (const language of ['js', 'ts', 'sql', 'cjs', 'mjs', 'cts', 'mts']) {
      const migrationsDirectory = join(workspace, 'migrations', language);
      await mkdir(migrationsDirectory, { recursive: true });
      run(
        process.execPath,
        [
          cli,
          'create',
          `smoke-${language}`,
          '--migrations-dir',
          migrationsDirectory,
          '--migration-file-language',
          language,
          '--migration-filename-format',
          'index',
        ],
        workspace
      );

      const migrations = await readdir(migrationsDirectory);
      if (migrations.length !== 1 || !migrations[0].endsWith(`.${language}`)) {
        fail(
          `Expected one .${language} migration, found ${JSON.stringify(migrations)}`
        );
      }
    }

    console.log(
      `Verified package consumer with Node ${process.version}, pg@${pgVersion}, and @types/pg@${typesPgVersion}`
    );
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
};

const [mode, ...arguments_] = process.argv.slice(2);

if (mode === 'package') {
  await verifyPackage(arguments_[0]);
} else if (mode === 'consumer') {
  await verifyConsumer(arguments_[0], arguments_[1], arguments_[2]);
} else {
  fail('Expected mode "package" or "consumer"');
}
