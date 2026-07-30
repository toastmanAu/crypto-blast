/**
 * Crypto Blast contract deployer (generalized).
 *
 * Deploys any of the four contract binaries to CKB testnet using
 * `ckb-cli deploy` with Type-ID. Usage:
 *
 *   npx vite-node scripts/deploy-contract.ts <name>
 *
 * where <name> is one of: verifier-lock, escrow-lock, forfeit-lock, claim-lock.
 *
 * After a successful run this script prints the type_id (code_hash) and
 * appends the result to `verifier/deployment-record.json`.
 *
 * PREREQUISITES
 *   Your deploy key must be in the ckb-cli keystore:
 *     ckb-cli account import --privkey-path <path-to-64-hex-key>
 *   export CKB_FROM_ADDRESS=<the testnet address matching that keystore account>
 *   export CKB_RPC_URL=https://testnet.ckb.dev/rpc   (or your node)
 *   ckb-cli >= 2.0.0 must be on PATH
 *   gen-txs signs via --sign-now and prompts for the keystore password.
 *
 * DO NOT RUN IN CI — broadcast is intentional, manual-only.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

// ── Constants ─────────────────────────────────────────────────────────────────

const CONTRACTS: Record<string, { binary: string; description: string }> = {
  'verifier-lock': {
    binary: 'verifier-lock',
    description: 'Phase-2 on-chain verifier (replay + commitment check)',
  },
  'escrow-lock': {
    binary: 'escrow-lock',
    description: 'Phase-4A settlement (happy/court/refund/forfeit-claim)',
  },
  'forfeit-lock': {
    binary: 'forfeit-lock',
    description: 'Phase-4B forfeit (ADVANCE + FORFEIT-FINALIZE)',
  },
  'claim-lock': {
    binary: 'claim-lock',
    description: 'Challenge window (CHALLENGE + FINALIZE)',
  },
};

const RELEASE_DIR = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  '../verifier/contract/target/riscv64imac-unknown-none-elf/release',
);

const RECORD_PATH = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  '../verifier/deployment-record.json',
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function fail(msg: string): never {
  console.error(`deploy-contract: ${msg}`);
  process.exit(1);
}

function ckbCli(args: string[]): number {
  const result = spawnSync('ckb-cli', args, {
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (result.error) fail(`Failed to run ckb-cli: ${result.error.message}`);
  return result.status ?? 1;
}

function lockArgFromAddress(address: string): string {
  const result = spawnSync(
    'ckb-cli',
    ['util', 'key-info', '--address', address, '--output-format', 'yaml'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const out = (result.stdout ?? '') + (result.stderr ?? '');
  const m = out.match(/lock_arg:\s*(0x[0-9a-fA-F]+)/);
  if (!m) fail(`Could not derive lock_arg from address ${address}:\n${out}`);
  return m[1];
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  if (process.env['CI']) {
    fail('Refusing to deploy in CI environment (CI=true). Run manually.');
  }

  const name = process.argv[2];
  if (!name || !CONTRACTS[name]) {
    console.error('Usage: npx vite-node scripts/deploy-contract.ts <name>');
    console.error(`Available contracts: ${Object.keys(CONTRACTS).join(', ')}`);
    process.exit(1);
  }

  const contract = CONTRACTS[name];
  const binaryPath = join(RELEASE_DIR, contract.binary);

  const rpcUrl = process.env['CKB_RPC_URL'] ?? 'https://testnet.ckb.dev/rpc';
  const fromAddress = process.env['CKB_FROM_ADDRESS'];
  if (!fromAddress) {
    fail(
      'CKB_FROM_ADDRESS must be set to the testnet address whose key is in your ckb-cli keystore.\n' +
        'Derive it from your key with: ckb-cli util key-info --privkey-path <path-to-key>',
    );
  }

  if (!existsSync(binaryPath)) {
    fail(
      `Binary not found: ${binaryPath}\n` +
        'Build it first:\n' +
        '  cd verifier/contract\n' +
        '  cargo build --release --target riscv64imac-unknown-none-elf',
    );
  }

  console.log(`\nDeploying: ${name} (${contract.description})`);
  console.log(`Binary:    ${binaryPath}`);
  console.log(`Network:   ${rpcUrl}`);
  console.log(`From:      ${fromAddress}`);

  const workDir = join(tmpdir(), `crypto-blast-deploy-${name}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  const configPath = join(workDir, 'deploy.toml');
  const migrationDir = join(workDir, 'migration');
  const infoFile = join(workDir, 'deploy-info.json');
  mkdirSync(migrationDir, { recursive: true });

  const lockArgs = lockArgFromAddress(fromAddress);
  const deployConfig = `
# Crypto Blast ${name} deployment config.
[[cells]]
name = "${name}"
enable_type_id = true
location = { file = "${binaryPath}" }

[lock]
code_hash = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8"
hash_type = "type"
args = "${lockArgs}"
`;
  writeFileSync(configPath, deployConfig.trimStart());
  console.log(`\nDeployment config: ${configPath}`);

  // Step 1: Generate + sign.
  console.log('\n[1/3] Generating + signing deploy transactions...');
  const genStatus = ckbCli([
    '--output-format', 'json',
    '--url', rpcUrl,
    'deploy',
    'gen-txs',
    '--deployment-config', configPath,
    '--migration-dir', migrationDir,
    '--info-file', infoFile,
    '--from-address', fromAddress,
    '--fee-rate', '1200',
    '--sign-now',
  ]);
  if (genStatus !== 0) fail(`gen-txs failed with exit code ${genStatus}`);

  // Step 2: Broadcast.
  console.log('\n[2/3] Broadcasting...');
  const applyStatus = ckbCli([
    '--url', rpcUrl,
    'deploy',
    'apply-txs',
    '--migration-dir', migrationDir,
    '--info-file', infoFile,
  ]);
  if (applyStatus !== 0) fail(`apply-txs failed with exit code ${applyStatus}`);

  // Step 3: Extract type_id.
  console.log('\n[3/3] Extracting deployed type_id...');
  let typeId: string | null = null;
  if (existsSync(infoFile)) {
    try {
      const info = JSON.parse(readFileSync(infoFile, 'utf8')) as Record<string, unknown>;
      const cells = info['cells'] as Array<Record<string, unknown>> | undefined;
      const cell = cells?.find((c) => c['name'] === name);
      typeId = (cell?.['type_id'] as string | undefined) ?? null;
    } catch {
      // fall through
    }
  }

  console.log('\n=== Deployment Complete ===');
  if (typeId) {
    console.log(`${name} code_hash (Type-ID): ${typeId}`);

    // Append to deployment-record.json.
    if (existsSync(RECORD_PATH)) {
      try {
        const record = JSON.parse(readFileSync(RECORD_PATH, 'utf8')) as Record<string, unknown>;
        const key = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        record[key] = {
          codeHash: typeId,
          hashType: 'type',
          binary: `verifier/contract/target/riscv64imac-unknown-none-elf/release/${contract.binary}`,
          description: contract.description,
        };
        record['lastUpdated'] = new Date().toISOString().split('T')[0];
        writeFileSync(RECORD_PATH, JSON.stringify(record, null, 2) + '\n');
        console.log(`Updated: ${RECORD_PATH}`);
      } catch (e) {
        console.error(`Warning: could not update deployment-record.json: ${e}`);
      }
    }
  } else {
    console.log('Could not auto-extract type_id. Check the migration directory:');
    console.log(`  ${migrationDir}`);
  }

  console.log(`\nckb-cli artefacts: ${workDir}`);
}

main();
