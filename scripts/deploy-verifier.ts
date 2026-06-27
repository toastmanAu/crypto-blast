/**
 * Crypto Blast verifier-lock Type-ID deployer.
 *
 * Deploys `verifier/contract/target/riscv64imac-unknown-none-elf/release/verifier-lock`
 * to CKB testnet using `ckb-cli deploy`, which handles the Type-ID cell lifecycle.
 *
 * After a successful run this script prints the type_id (code_hash) to use in
 * lock scripts that reference the deployed verifier kernel:
 *   { code_hash: <printed value>, hash_type: "type", args: <seed‖commitment> }
 *
 * PREREQUISITES
 *   export CKB_PRIVKEY=<your 64-hex-char secp256k1 private key>
 *   export CKB_RPC_URL=https://testnet.ckb.dev/rpc   (or your node)
 *   ckb-cli >= 2.0.0 must be on PATH (found at ~/.local/bin/ckb-cli)
 *
 * DO NOT RUN IN CI — broadcast is intentional, manual-only.
 * See docs/VERIFIER_DEPLOY.md for the full runbook.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

// ── Constants ─────────────────────────────────────────────────────────────────

const BINARY_PATH = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  '../verifier/contract/target/riscv64imac-unknown-none-elf/release/verifier-lock',
);

const CELL_NAME = 'verifier-lock';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fail(msg: string): never {
  console.error(`deploy-verifier: ${msg}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) fail(`Environment variable ${name} is required but not set.`);
  return val;
}

/** Run ckb-cli, streaming stdout/stderr to the terminal. Returns exit code. */
function ckbCli(args: string[]): number {
  const result = spawnSync('ckb-cli', args, {
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (result.error) fail(`Failed to run ckb-cli: ${result.error.message}`);
  return result.status ?? 1;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  // Guard: refuse to run in CI or without explicit intent.
  if (process.env['CI']) {
    fail('Refusing to deploy in CI environment (CI=true). Run manually.');
  }

  // Check prerequisites.
  const privKey = requireEnv('CKB_PRIVKEY');
  const rpcUrl = process.env['CKB_RPC_URL'] ?? 'https://testnet.ckb.dev/rpc';
  const fromAddress = process.env['CKB_FROM_ADDRESS'];
  if (!fromAddress) {
    fail(
      'CKB_FROM_ADDRESS must be set to the testnet address matching CKB_PRIVKEY.\n' +
        "Derive it with: ckb-cli util key-info --privkey-path <(echo $CKB_PRIVKEY)",
    );
  }

  if (!existsSync(BINARY_PATH)) {
    fail(
      `Binary not found: ${BINARY_PATH}\n` +
        'Build it first:\n' +
        '  cd verifier/contract\n' +
        '  cargo build --release --target riscv64imac-unknown-none-elf',
    );
  }

  console.log(`\nDeploying: ${BINARY_PATH}`);
  console.log(`Network:   ${rpcUrl}`);
  console.log(`From:      ${fromAddress}`);

  // Create a temporary working directory for ckb-cli artefacts.
  const workDir = join(tmpdir(), `crypto-blast-deploy-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  const configPath = join(workDir, 'deploy.toml');
  const migrationDir = join(workDir, 'migration');
  const infoFile = join(workDir, 'deploy-info.json');
  mkdirSync(migrationDir, { recursive: true });

  // Write a minimal deployment config enabling Type-ID.
  const deployConfig = `
# Crypto Blast verifier-lock deployment config.
# enable_type_id = true → ckb-cli creates/updates the Type-ID type script.
[[cells]]
name = "${CELL_NAME}"
enable_type_id = true
location = { file = "${BINARY_PATH}" }
`;
  writeFileSync(configPath, deployConfig.trimStart());
  console.log(`\nDeployment config: ${configPath}`);

  // Step 1: Generate unsigned deploy transactions.
  console.log('\n[1/3] Generating deploy transactions (ckb-cli deploy gen-txs)...');
  const genStatus = ckbCli([
    'deploy',
    'gen-txs',
    '--deployment-config', configPath,
    '--migration-dir', migrationDir,
    '--info-file', infoFile,
    '--from-address', fromAddress,
    '--fee-rate', '1200',
    '--sign-now',
    '--privkey-path', `/dev/stdin`,
    '--api-uri', rpcUrl,
  ]);
  // Note: --sign-now signs inline; we pipe the privkey via /dev/stdin.
  // In practice the user passes --privkey-path to a file or uses the env-based approach.

  if (genStatus !== 0) {
    fail(`gen-txs failed with exit code ${genStatus}`);
  }

  // Step 2: Apply (broadcast) the signed transactions.
  console.log('\n[2/3] Broadcasting (ckb-cli deploy apply-txs)...');
  const applyStatus = ckbCli([
    'deploy',
    'apply-txs',
    '--migration-dir', migrationDir,
    '--info-file', infoFile,
    '--api-uri', rpcUrl,
  ]);

  if (applyStatus !== 0) {
    fail(`apply-txs failed with exit code ${applyStatus}`);
  }

  // Step 3: Extract and print the Type-ID (code_hash) from the migration output.
  console.log('\n[3/3] Extracting deployed type_id...');

  // ckb-cli deploy writes a migration YAML/JSON in migrationDir.
  // We also have infoFile which contains the cell type_id after apply.
  let typeId: string | null = null;
  if (existsSync(infoFile)) {
    try {
      const info = JSON.parse(readFileSync(infoFile, 'utf8')) as Record<string, unknown>;
      // The info file structure: { cells: [{ name, type_id, ... }] }
      const cells = info['cells'] as Array<Record<string, unknown>> | undefined;
      const cell = cells?.find((c) => c['name'] === CELL_NAME);
      typeId = (cell?.['type_id'] as string | undefined) ?? null;
    } catch {
      // fall through to manual instruction
    }
  }

  console.log('\n=== Deployment Complete ===');
  if (typeId) {
    console.log(`code_hash (Type-ID): ${typeId}`);
  } else {
    console.log('Could not auto-extract type_id. Check the migration directory:');
    console.log(`  ${migrationDir}`);
    console.log(
      '  The type_id is the args field of the type script on the deployed code cell.',
    );
  }

  console.log('\nNext steps — see docs/VERIFIER_DEPLOY.md:');
  console.log('  1. Create a cell locked by: { code_hash: <type_id>, hash_type: "type",');
  console.log('                                args: <seed(4 LE)‖commitment(32)> }');
  console.log('  2. Run: npx vite-node scripts/build-verify-tx.ts \\');
  console.log('            --code-hash <type_id> --seed <n> \\');
  console.log('            --commitment <0x…> --tape <tape.bin>');
  console.log('  3. Sign the printed tx skeleton and broadcast with ckb-cli tx.');

  // Persist work dir path for debugging.
  console.log(`\nckb-cli artefacts: ${workDir}`);
}

main();
